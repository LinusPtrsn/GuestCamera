import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, stat, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

type ImmichSharedLinkAuth = {
  key?: string;
  slug?: string;
};

type ImmichSharedLinkResponse = {
  assets?: ImmichAsset[];
  album?: {
    id: string;
    assetCount?: number;
    albumThumbnailAssetId?: string | null;
  };
};

type ImmichAsset = {
  id: string;
  createdAt?: string;
  fileCreatedAt?: string;
  thumbhash?: string | null;
};

type ImmichTimeBucket = {
  timeBucket: string;
  count: number;
};

type ImmichTimeBucketAssets = {
  id: string[];
  isTrashed?: boolean[];
  fileCreatedAt?: string[];
  thumbhash?: Array<string | null>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const clientDist = path.join(projectRoot, 'dist', 'client');
const tempRoot = path.join(os.tmpdir(), 'guest-camera');
const logsRoot = path.resolve(projectRoot, 'logs');
const frontendLogPath = path.join(logsRoot, 'frontend-errors.ndjson');
const localEnvPath = path.join(projectRoot, '.env');
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 250 * 1024 * 1024);
const thumbnailAvailabilityCache = new Map<string, { ok: boolean; checkedAt: number }>();
const thumbnailResponseCache = new Map<string, { body: Buffer; contentType: string; checkedAt: number }>();
const exiftoolCandidates = [
  process.env.EXIFTOOL_PATH?.trim(),
  'exiftool'
].filter(Boolean) as string[];
const defaultBuildVersion = 'dev';

loadDotEnv(localEnvPath);

const port = Number(process.env.PORT ?? 3001);
const buildVersion = process.env.GUEST_CAMERA_BUILD_VERSION?.trim() || defaultBuildVersion;
const immichApiKey = process.env.IMMICH_API_KEY?.trim() ?? '';
const immichSharedLinkUrl = process.env.IMMICH_SHARED_LINK_URL?.trim() || '';
const immichBaseUrl = resolveImmichBaseUrl(immichSharedLinkUrl);
const immichSharedLink = resolveSharedLinkAuth(
  immichSharedLinkUrl || process.env.IMMICH_SHARED_LINK_KEY?.trim() || '',
  process.env.IMMICH_SHARED_LINK_SLUG?.trim() ?? '',
);
const immichConfigured = !!immichBaseUrl && (immichApiKey.length > 0 || !!immichSharedLink);

async function ensureDirectories() {
  await mkdir(tempRoot, { recursive: true });
  await mkdir(logsRoot, { recursive: true });
}

function loadDotEnv(filePath: string) {
  if (!existsSync(filePath)) {
    return;
  }

  const raw = readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function resolveSharedLinkAuth(urlOrKey: string, slug: string): ImmichSharedLinkAuth | null {
  if (slug) {
    return { slug };
  }

  if (!urlOrKey) {
    return null;
  }

  try {
    const parsed = new URL(urlOrKey);
    const explicitKey = parsed.searchParams.get('key');
    const explicitSlug = parsed.searchParams.get('slug');
    if (explicitSlug) {
      return { slug: explicitSlug };
    }
    if (explicitKey) {
      return { key: explicitKey };
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    const last = parts.at(-1);
    if (parts.includes('share') && last) {
      return { key: last };
    }
  } catch {
    return { key: urlOrKey };
  }

  return { key: urlOrKey };
}

function normalizeImmichUrl(url: string) {
  return url.replace(/\/+$/, '');
}

function resolveImmichBaseUrl(sharedLinkUrl: string) {
  if (!sharedLinkUrl) {
    return '';
  }

  try {
    const parsed = new URL(sharedLinkUrl);
    parsed.pathname = '/api';
    parsed.search = '';
    parsed.hash = '';
    return normalizeImmichUrl(parsed.toString());
  } catch {
    return '';
  }
}

function json(res: any, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readJson(req: any) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 16 * 1024 * 1024) {
      throw new Error('Request too large');
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function appendFrontendLog(entry: Record<string, unknown>) {
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
  await appendFile(frontendLogPath, line, 'utf8');
  console.log(`[frontend] ${line.trimEnd()}`);
}

function addSharedLinkParams(url: URL) {
  if (immichSharedLink?.key) {
    url.searchParams.set('key', immichSharedLink.key);
  }
  if (immichSharedLink?.slug) {
    url.searchParams.set('slug', immichSharedLink.slug);
  }
}

function immichApiUrl(pathname: string, params: Record<string, string | undefined> = {}) {
  if (!immichBaseUrl) {
    throw new Error('IMMICH_SHARED_LINK_URL fehlt oder ist keine gueltige URL');
  }
  const url = new URL(`${immichBaseUrl}${pathname}`);
  addSharedLinkParams(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

async function fetchImmichJson<T>(pathname: string, params: Record<string, string | undefined> = {}) {
  const response = await fetch(immichApiUrl(pathname, params), {
    headers: {
      Accept: 'application/json',
      ...(immichApiKey ? { 'x-api-key': immichApiKey } : {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Immich request failed: ${response.status} ${text}`);
  }
  return (await response.json()) as T;
}

function getImmichThumbnailUrl(assetId: string, thumbhash?: string | null) {
  const url = immichApiUrl(`/assets/${assetId}/thumbnail`);
  if (thumbhash) {
    url.searchParams.set('c', thumbhash);
  }
  return url.toString();
}

function getPublicThumbnailUrl(assetId: string, thumbhash?: string | null) {
  const params = new URLSearchParams();
  if (thumbhash) {
    params.set('c', thumbhash);
  }
  const suffix = params.size > 0 ? `?${params}` : '';
  return `/api/immich-thumbnails/${encodeURIComponent(assetId)}${suffix}`;
}

async function hasImmichThumbnail(assetId: string, thumbnailUrl: string) {
  const cached = thumbnailAvailabilityCache.get(assetId);
  if (cached && Date.now() - cached.checkedAt < 5 * 60 * 1000) {
    return cached.ok;
  }

  const response = await fetch(thumbnailUrl, {
    method: 'HEAD',
    headers: {
      ...(immichApiKey ? { 'x-api-key': immichApiKey } : {})
    }
  });
  const ok = response.ok && !!response.headers.get('content-type')?.startsWith('image/');
  thumbnailAvailabilityCache.set(assetId, { ok, checkedAt: Date.now() });
  return ok;
}

async function getCachedImmichThumbnail(assetId: string, thumbhash?: string | null) {
  const cacheKey = `${assetId}:${thumbhash ?? ''}`;
  const cached = thumbnailResponseCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < 5 * 60 * 1000) {
    return cached;
  }

  const response = await fetch(getImmichThumbnailUrl(assetId, thumbhash), {
    headers: {
      Accept: 'image/*',
      ...(immichApiKey ? { 'x-api-key': immichApiKey } : {})
    }
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.startsWith('image/')) {
    throw new Error(`Immich thumbnail failed: ${response.status}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  const entry = { body, contentType, checkedAt: Date.now() };
  thumbnailResponseCache.set(cacheKey, entry);
  return entry;
}

async function getImmichGallery() {
  if (!immichSharedLink) {
    return { total: 0, recent: [], albumUrl: immichSharedLinkUrl || null };
  }

  const sharedLink = await fetchImmichJson<ImmichSharedLinkResponse>('/shared-links/me');
  const albumId = sharedLink.album?.id;
  const total = sharedLink.album?.assetCount ?? sharedLink.assets?.length ?? 0;
  const recent: Array<{ name: string; url: string; thumbnailUrl: string | null; createdAt: string; size: number }> = [];

  if (albumId) {
    const buckets = await fetchImmichJson<ImmichTimeBucket[]>('/timeline/buckets', { albumId, order: 'desc' });
    for (const bucket of buckets) {
      if (recent.length >= 3) {
        break;
      }

      const assets = await fetchImmichJson<ImmichTimeBucketAssets>('/timeline/bucket', {
        albumId,
        timeBucket: bucket.timeBucket,
        order: 'desc'
      });
      for (let index = 0; index < assets.id.length && recent.length < 3; index += 1) {
        if (assets.isTrashed?.[index]) {
          continue;
        }

        const id = assets.id[index];
        const immichThumbnailUrl = getImmichThumbnailUrl(id, assets.thumbhash?.[index]);
        if (!(await hasImmichThumbnail(id, immichThumbnailUrl))) {
          continue;
        }

        const thumbnailUrl = getPublicThumbnailUrl(id, assets.thumbhash?.[index]);
        recent.push({
          name: id,
          url: thumbnailUrl,
          thumbnailUrl,
          createdAt: assets.fileCreatedAt?.[index] ?? bucket.timeBucket,
          size: 0
        });
      }
    }
  } else {
    for (const asset of sharedLink.assets ?? []) {
      if (recent.length >= 3) {
        break;
      }

      const immichThumbnailUrl = getImmichThumbnailUrl(asset.id, asset.thumbhash);
      if (!(await hasImmichThumbnail(asset.id, immichThumbnailUrl))) {
        continue;
      }

      const thumbnailUrl = getPublicThumbnailUrl(asset.id, asset.thumbhash);
      recent.push({
        name: asset.id,
        url: thumbnailUrl,
        thumbnailUrl,
        createdAt: asset.fileCreatedAt ?? asset.createdAt ?? '',
        size: 0
      });
    }
  }

  return { total, recent, albumUrl: immichSharedLinkUrl || null };
}

async function parseMultipart(req: any) {
  const contentType = String(req.headers['content-type'] ?? '');
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) {
    throw new Error('Missing multipart boundary');
  }

  const boundary = `--${match[1] ?? match[2]}`;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    totalBytes += buffer.length;
    if (totalBytes > maxUploadBytes) {
      throw new Error('Upload too large');
    }
  }

  const body = Buffer.concat(chunks);
  const parts = body.toString('binary').split(boundary);
  const fields = new Map<string, string | Buffer>();

  for (const part of parts) {
    if (!part.includes('Content-Disposition')) {
      continue;
    }

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      continue;
    }

    const rawHeaders = part.slice(0, headerEnd);
    const rawValue = part.slice(headerEnd + 4).replace(/\r\n--$/, '');
    const nameMatch = rawHeaders.match(/name="([^"]+)"/);
    if (!nameMatch) {
      continue;
    }

    const fileNameMatch = rawHeaders.match(/filename="([^"]*)"/);
    if (fileNameMatch) {
      fields.set(nameMatch[1], Buffer.from(rawValue, 'binary'));
    } else {
      fields.set(nameMatch[1], rawValue.trim());
    }
  }

  return fields;
}

async function uploadToImmich(filePath: string, capturedAt: string, mimeType: string) {
  if (!immichConfigured) {
    return { uploaded: false, warning: 'IMMICH_SHARED_LINK_URL fehlt oder ist keine gueltige URL' };
  }

  const fileBuffer = await readFile(filePath);
  const filename = path.basename(filePath);
  const checksum = crypto.createHash('sha1').update(fileBuffer).digest('hex');

  const form = new FormData();
  form.append('assetData', new Blob([fileBuffer], { type: mimeType }), filename);
  form.append('deviceAssetId', checksum);
  form.append('deviceId', 'guest-camera');
  form.append('fileCreatedAt', capturedAt);
  form.append('fileModifiedAt', capturedAt);
  form.append('filename', filename);
  form.append('isFavorite', 'false');

  const uploadUrl = new URL(`${immichBaseUrl}/assets`);
  if (immichSharedLink?.key) {
    uploadUrl.searchParams.set('key', immichSharedLink.key);
  }
  if (immichSharedLink?.slug) {
    uploadUrl.searchParams.set('slug', immichSharedLink.slug);
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      ...(immichApiKey ? { 'x-api-key': immichApiKey } : {})
    },
    body: form
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`Immich upload failed: ${uploadResponse.status} ${text}`);
  }

  const uploadResult = (await uploadResponse.json()) as { id?: string; status?: string; duplicate?: boolean };
  return { uploaded: true, assetId: uploadResult.id };
}

function extensionForMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase().split(';')[0].trim();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'video/mp4') return '.mp4';
  if (normalized === 'video/quicktime') return '.mov';
  if (normalized === 'video/webm') return '.webm';
  if (normalized.startsWith('video/')) return '.webm';
  return '.jpg';
}

function uploaderDescription(name: string) {
  const trimmed = name.trim();
  return trimmed
    ? `Uploaded by guest camera user: ${trimmed}`
    : 'Uploaded by anonymous guest camera user';
}

async function writeDescriptionMetadata(filePath: string, description: string) {
  const errors: string[] = [];
  for (const exiftool of exiftoolCandidates) {
    const args = [
      '-overwrite_original',
      '-Description=' + description,
      '-ImageDescription=' + description,
      '-XMP-dc:Description=' + description,
      '-UserComment=' + description,
      filePath
    ];
    const result = await new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
      const child = spawn(exiftool, args, { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (cause) => {
        resolve({ ok: false, message: cause.message });
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true });
          return;
        }
        resolve({ ok: false, message: stderr.trim() || `ExifTool exited with code ${code}` });
      });
    });
    if (result.ok) {
      return;
    }
    errors.push(`${exiftool}: ${result.message}`);
  }
  throw new Error(errors.join(' | ') || 'ExifTool is not available');
}

function mergeWarnings(...warnings: Array<string | undefined>) {
  return warnings
    .map((warning) => warning?.trim())
    .filter((warning): warning is string => Boolean(warning))
    .join(' | ');
}

async function handleCapture(req: any, res: any) {
  let form: Map<string, string | Buffer>;
  try {
    form = await parseMultipart(req);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Upload konnte nicht gelesen werden';
    json(res, message === 'Upload too large' ? 413 : 400, { ok: false, message });
    return;
  }

  const name = String(form.get('name') ?? '').trim();
  const mimeType = String(form.get('mimeType') ?? 'image/jpeg');
  const capturedAt = String(form.get('capturedAt') ?? new Date().toISOString());
  const photo = form.get('photo');

  if (!Buffer.isBuffer(photo)) {
    json(res, 400, { ok: false, message: 'Foto fehlt' });
    return;
  }

  const extension = extensionForMimeType(mimeType);
  const filename = `${capturedAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}${extension}`;
  const tempDir = await mkdtemp(path.join(tempRoot, 'upload-'));
  const fullPath = path.join(tempDir, filename);
  await writeFile(fullPath, photo);

  let metadataWarning = '';
  let uploadResult: { uploaded: boolean; albumId?: string; assetId?: string; warning?: string };
  try {
    try {
      await writeDescriptionMetadata(fullPath, uploaderDescription(name));
    } catch (cause) {
      metadataWarning = cause instanceof Error ? `Metadaten konnten nicht geschrieben werden: ${cause.message}` : 'Metadaten konnten nicht geschrieben werden';
      console.warn(metadataWarning);
    }
    uploadResult = await uploadToImmich(fullPath, capturedAt, mimeType);
  } catch (cause) {
    json(res, 502, {
      ok: false,
      localPath: '',
      albumName: 'Immich Shared Link',
      message: cause instanceof Error ? cause.message : 'Immich upload failed'
    });
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return;
  }
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});

  json(res, 200, {
    ok: true,
    localPath: '',
    albumName: 'Immich Shared Link',
    ...uploadResult,
    warning: mergeWarnings(metadataWarning, uploadResult.warning) || undefined
  });
}

async function serveStatic(req: any, res: any) {
  if ((req.url === '/health' || req.url === '/api/health') && req.method === 'GET') {
    json(res, 200, { ok: true, version: buildVersion });
    return;
  }

  if (req.url === '/api/status') {
    json(res, 200, {
      immichConfigured,
      sharedLinkConfigured: !!immichSharedLink,
      storageRoot: '',
      apiBaseUrl: immichBaseUrl,
      buildVersion
    });
    return;
  }

  if (req.url === '/api/client-log' && req.method === 'POST') {
    try {
      const payload = await readJson(req);
      await appendFrontendLog({
        level: String(payload.level ?? 'error'),
        message: String(payload.message ?? 'Unknown client error'),
        source: String(payload.source ?? 'window'),
        stack: payload.stack ? String(payload.stack) : undefined,
        pageUrl: payload.pageUrl ? String(payload.pageUrl) : undefined,
        userAgent: payload.userAgent ? String(payload.userAgent) : undefined
      });
      res.writeHead(204);
      res.end();
    } catch (cause) {
      console.error('Failed to record frontend log', cause);
      json(res, 400, { ok: false, message: 'Invalid client log payload' });
    }
    return;
  }

  if (req.url === '/api/gallery' && req.method === 'GET') {
    json(res, 200, await getImmichGallery());
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/api/immich-thumbnails/')) {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const assetId = decodeURIComponent(parsed.pathname.slice('/api/immich-thumbnails/'.length));
    const thumbhash = parsed.searchParams.get('c');

    if (!assetId) {
      json(res, 400, { ok: false, message: 'Asset fehlt' });
      return;
    }

    try {
      const thumbnail = await getCachedImmichThumbnail(assetId, thumbhash);
      res.writeHead(200, {
        'Content-Type': thumbnail.contentType,
        'Content-Length': thumbnail.body.length,
        'Cache-Control': 'private, max-age=60'
      });
      res.end(thumbnail.body);
    } catch (cause) {
      console.error('Failed to proxy Immich thumbnail', cause);
      json(res, 502, { ok: false, message: 'Thumbnail konnte nicht geladen werden' });
    }
    return;
  }

  if (req.url === '/api/capture' && req.method === 'POST') {
    await handleCapture(req, res);
    return;
  }

  if (req.method === 'GET' && req.url) {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const resolved = pathname === '/' ? path.join(clientDist, 'index.html') : path.join(clientDist, pathname);
    if (existsSync(resolved)) {
      const fileStat = await stat(resolved);
      const stream = createReadStream(resolved);
      const ext = path.extname(resolved);
      const contentType =
        ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : ext === '.css'
            ? 'text/css; charset=utf-8'
            : ext === '.svg'
              ? 'image/svg+xml'
              : ext === '.html'
                ? 'text/html; charset=utf-8'
                : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileStat.size
      });
      stream.pipe(res);
      return;
    }
  }

  json(res, 404, { ok: false, message: 'Not found' });
}

async function main() {
  await ensureDirectories();

  const server = createServer((req, res) => {
    void serveStatic(req, res).catch((cause) => {
      json(res, 500, {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Unexpected server error'
      });
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Guest Camera listening on http://0.0.0.0:${port}`);
  });
}

void main();
