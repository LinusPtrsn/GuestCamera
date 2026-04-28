import { createServer } from 'node:http';
import { mkdir, stat, appendFile, rm, rename } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { createServerConfig } from './config';
import { captureFilename, normalizeCaptureMimeType, safeCapturedAt } from './services/capture-input';
import { ImmichClient } from './services/immich-client';
import { parseCaptureUpload } from './services/upload-staging';
import * as metadataService from './services/metadata';
import type { CaptureUpload, ImmichSharedLinkResponse, ImmichTimeBucket, ImmichTimeBucketAssets } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const config = createServerConfig(projectRoot);
const {
  buildVersion,
  clientDist,
  exiftoolCandidates,
  frontendLogPath,
  immichBaseUrl,
  immichConfigured,
  immichSharedLink,
  immichSharedLinkUrl,
  logsRoot,
  maxUploadBytes,
  port,
  tempRoot
} = config;
const thumbnailAvailabilityCache = new Map<string, { ok: boolean; checkedAt: number }>();
const thumbnailResponseCache = new Map<string, { body: Buffer; contentType: string; checkedAt: number }>();
const immichClient = new ImmichClient({ baseUrl: immichBaseUrl, sharedLink: immichSharedLink });
const liveClients = new Set<Duplex>();
let lastGalleryBroadcastSignature = '';

async function ensureDirectories() {
  await mkdir(tempRoot, { recursive: true });
  await mkdir(logsRoot, { recursive: true });
}

function json(res: any, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function webSocketFrame(payload: string) {
  const body = Buffer.from(payload, 'utf8');
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function broadcastLiveMessage(message: unknown) {
  const frame = webSocketFrame(JSON.stringify(message));
  for (const client of liveClients) {
    if (!client.writable) {
      liveClients.delete(client);
      continue;
    }
    client.write(frame, (cause) => {
      if (cause) {
        liveClients.delete(client);
        client.destroy();
      }
    });
  }
}

function gallerySignature(gallery: Awaited<ReturnType<typeof getImmichGallery>>) {
  return JSON.stringify({
    total: gallery.total,
    recent: gallery.recent.map((item) => ({
      name: item.name,
      thumbnailUrl: item.thumbnailUrl,
      createdAt: item.createdAt
    }))
  });
}

async function broadcastGalleryUpdate({ force = false } = {}) {
  try {
    const gallery = await getImmichGallery();
    const signature = gallerySignature(gallery);
    if (!force && signature === lastGalleryBroadcastSignature) {
      return;
    }
    lastGalleryBroadcastSignature = signature;
    broadcastLiveMessage({ type: 'gallery:update', gallery });
  } catch (cause) {
    console.error('Failed to broadcast gallery update', cause);
  }
}

function handleLiveUpgrade(req: any, socket: Duplex) {
  const key = String(req.headers['sec-websocket-key'] ?? '');
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'));

  liveClients.add(socket);
  socket.on('close', () => liveClients.delete(socket));
  socket.on('end', () => liveClients.delete(socket));
  socket.on('error', () => liveClients.delete(socket));
  void broadcastGalleryUpdate({ force: true });
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
      Accept: 'application/json'
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

  const response = await fetch(thumbnailUrl, { method: 'HEAD' });
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
      Accept: 'image/*'
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

function mergeWarnings(...warnings: Array<string | undefined>) {
  return warnings
    .map((warning) => warning?.trim())
    .filter((warning): warning is string => Boolean(warning))
    .join(' | ');
}

async function handleCapture(req: any, res: any) {
  let upload: CaptureUpload;
  try {
    upload = await parseCaptureUpload(req, tempRoot, maxUploadBytes);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Upload konnte nicht gelesen werden';
    json(res, message === 'Upload too large' ? 413 : 400, { ok: false, message });
    return;
  }

  const name = String(upload.fields.get('name') ?? '').trim();
  let mimeType: ReturnType<typeof normalizeCaptureMimeType>;
  let capturedAt: string;
  try {
    mimeType = normalizeCaptureMimeType(String(upload.fields.get('mimeType') ?? 'image/jpeg'));
    capturedAt = safeCapturedAt(String(upload.fields.get('capturedAt') ?? ''));
  } catch (cause) {
    json(res, 400, {
      ok: false,
      localPath: '',
      albumName: 'Immich Shared Link',
      message: cause instanceof Error ? cause.message : 'Upload-Metadaten sind ungültig'
    });
    await rm(upload.tempDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  const filename = captureFilename(capturedAt, mimeType, crypto.randomUUID().slice(0, 8));
  const fullPath = path.join(upload.tempDir, filename);
  await rename(upload.filePath, fullPath);

  let metadataWarning = '';
  let uploadResult: { uploaded: boolean; albumId?: string; assetId?: string; warning?: string };
  try {
    try {
      await metadataService.writeDescriptionMetadata(fullPath, metadataService.uploaderDescription(name), exiftoolCandidates);
    } catch (cause) {
      metadataWarning = cause instanceof Error ? `Metadaten konnten nicht geschrieben werden: ${cause.message}` : 'Metadaten konnten nicht geschrieben werden';
      console.warn(metadataWarning);
    }
    uploadResult = await immichClient.uploadAsset(fullPath, capturedAt, mimeType);
  } catch (cause) {
    json(res, 502, {
      ok: false,
      localPath: '',
      albumName: 'Immich Shared Link',
      message: cause instanceof Error ? cause.message : 'Immich upload failed'
    });
    await rm(upload.tempDir, { recursive: true, force: true }).catch(() => {});
    return;
  }
  await rm(upload.tempDir, { recursive: true, force: true }).catch(() => {});

  json(res, 200, {
    ok: true,
    localPath: '',
    albumName: 'Immich Shared Link',
    ...uploadResult,
    warning: mergeWarnings(metadataWarning, uploadResult.warning) || undefined
  });
  void broadcastGalleryUpdate({ force: true });
  setTimeout(() => void broadcastGalleryUpdate(), 2500);
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
      storageRoot: tempRoot,
      maxUploadBytes,
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
  server.on('upgrade', (req, socket) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/api/live') {
      handleLiveUpgrade(req, socket);
      return;
    }
    socket.destroy();
  });
  setInterval(() => {
    if (liveClients.size > 0) {
      void broadcastGalleryUpdate();
    }
  }, 10000);

  server.listen(port, '0.0.0.0', () => {
    console.log(`Guest Camera listening on http://0.0.0.0:${port}`);
  });
}

void main();
