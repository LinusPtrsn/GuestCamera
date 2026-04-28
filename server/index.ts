import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, stat, appendFile } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

type ImmichSharedLinkAuth = {
  key?: string;
  slug?: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const clientDist = path.join(projectRoot, 'dist', 'client');
const storageRoot = path.resolve(projectRoot, 'captures');
const thumbnailRoot = path.resolve(storageRoot, '.thumbnails');
const logsRoot = path.resolve(projectRoot, 'logs');
const frontendLogPath = path.join(logsRoot, 'frontend-errors.ndjson');
const localEnvPath = path.join(projectRoot, '.env');
const thumbnailScriptPath = path.join(projectRoot, 'scripts', 'create-thumbnail.ps1');
const imageFilePattern = /\.(jpg|jpeg|png|webp)$/i;
const exiftoolCandidates = [
  process.env.EXIFTOOL_PATH?.trim(),
  'C:\\Users\\linus\\AppData\\Local\\Programs\\ExifTool\\ExifTool.exe',
  'C:\\Users\\linus\\AppData\\Local\\Programs\\ExifTool\\exiftool.exe',
  'C:\\Program Files\\ExifTool\\exiftool.exe',
  'C:\\Program Files (x86)\\ExifTool\\exiftool.exe',
  'exiftool'
].filter(Boolean) as string[];

loadDotEnv(localEnvPath);

const port = Number(process.env.PORT ?? 3001);
const immichBaseUrl = normalizeImmichUrl(process.env.IMMICH_INSTANCE_URL ?? 'http://127.0.0.1:2283/api');
const immichApiKey = process.env.IMMICH_API_KEY?.trim() ?? '';
const immichSharedLink = resolveSharedLinkAuth(
  process.env.IMMICH_SHARED_LINK_URL?.trim() || process.env.IMMICH_SHARED_LINK_KEY?.trim() || '',
  process.env.IMMICH_SHARED_LINK_SLUG?.trim() ?? '',
);
const immichSharedLinkUrl = process.env.IMMICH_SHARED_LINK_URL?.trim() || '';
const immichConfigured = immichApiKey.length > 0 || !!immichSharedLink;

async function ensureDirectories() {
  await mkdir(storageRoot, { recursive: true });
  await mkdir(thumbnailRoot, { recursive: true });
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

async function getGalleryEntries() {
  const entries: Array<{ name: string; path: string; createdAt: string; size: number; url: string; thumbnailUrl: string | null }> = [];

  const walk = async (dir: string) => {
    if (!existsSync(dir)) {
      return;
    }
    if (isWithinDirectory(thumbnailRoot, dir)) {
      return;
    }

    const items = await import('node:fs/promises').then((m) => m.readdir(dir, { withFileTypes: true }));
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!item.isFile()) {
        continue;
      }

      if (!imageFilePattern.test(item.name)) {
        continue;
      }

      const statResult = await stat(fullPath);
      const thumbnailPath = thumbnailPathFor(fullPath);
      if (!existsSync(thumbnailPath)) {
        continue;
      }

      entries.push({
        name: item.name,
        path: fullPath,
        createdAt: statResult.mtime.toISOString(),
        size: statResult.size,
        url: `/api/captures/${encodeURIComponent(path.relative(storageRoot, fullPath).split(path.sep).join('/'))}`,
        thumbnailUrl: `/api/thumbnails/${encodeURIComponent(path.relative(thumbnailRoot, thumbnailPath).split(path.sep).join('/'))}`,
      });
    }
  };

  await walk(storageRoot);
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return entries;
}

function isWithinDirectory(parent: string, target: string) {
  const relative = path.relative(parent, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function thumbnailPathFor(filePath: string) {
  const relative = path.relative(storageRoot, filePath);
  const withoutExt = relative.replace(/\.[^.]+$/, '');
  return path.join(thumbnailRoot, `${withoutExt}.jpg`);
}

async function ensureThumbnail(sourcePath: string, thumbnailPath: string) {
  await mkdir(path.dirname(thumbnailPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', thumbnailScriptPath, sourcePath, thumbnailPath],
      { windowsHide: true }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `Thumbnail generator exited with code ${code}`));
    });
  });
}

async function parseMultipart(req: any) {
  const contentType = String(req.headers['content-type'] ?? '');
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) {
    throw new Error('Missing multipart boundary');
  }

  const boundary = `--${match[1] ?? match[2]}`;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 20 * 1024 * 1024) {
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
    return { uploaded: false, warning: 'IMMICH_SHARED_LINK_URL oder IMMICH_SHARED_LINK_KEY fehlt' };
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

function isImageMimeType(mimeType: string) {
  return mimeType.toLowerCase().startsWith('image/');
}

function quoteExiftoolValue(value: string) {
  return value.replace(/"/g, '\\"');
}

async function writeDescriptionMetadata(filePath: string, description: string) {
  const exiftool = exiftoolCandidates[0] || 'exiftool';
  const args = ['-overwrite_original', '-Description=' + quoteExiftoolValue(description), filePath];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(exiftool, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ExifTool exited with code ${code}`));
    });
  });
}

async function handleCapture(req: any, res: any) {
  const form = await parseMultipart(req);
  const name = String(form.get('name') ?? '').trim();
  const mimeType = String(form.get('mimeType') ?? 'image/jpeg');
  const capturedAt = String(form.get('capturedAt') ?? new Date().toISOString());
  const photo = form.get('photo');

  if (!Buffer.isBuffer(photo)) {
    json(res, 400, { ok: false, message: 'Foto fehlt' });
    return;
  }

  const safeName = name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'guest';
  const date = capturedAt.slice(0, 10);
  const dir = path.join(storageRoot, safeName, date);
  await mkdir(dir, { recursive: true });

  const extension = extensionForMimeType(mimeType);
  const filename = `${capturedAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}${extension}`;
  const fullPath = path.join(dir, filename);
  await writeFile(fullPath, photo);

  let uploadResult: { uploaded: boolean; albumId?: string; assetId?: string; warning?: string };
  try {
    if (isImageMimeType(mimeType)) {
      await writeDescriptionMetadata(fullPath, name || 'guest');
      try {
        await ensureThumbnail(fullPath, thumbnailPathFor(fullPath));
      } catch (cause) {
        console.warn('Failed to create thumbnail', cause);
      }
    }
    uploadResult = await uploadToImmich(fullPath, capturedAt, mimeType);
  } catch (cause) {
    json(res, 502, {
      ok: false,
      localPath: fullPath,
      albumName: 'Immich Shared Link',
      message: cause instanceof Error ? cause.message : 'Immich upload failed'
    });
    return;
  }

  json(res, 200, {
    ok: true,
    localPath: fullPath,
    albumName: 'Immich Shared Link',
    ...uploadResult
  });
}

async function serveStatic(req: any, res: any) {
  if (req.url === '/api/status') {
    json(res, 200, {
      immichConfigured,
      sharedLinkConfigured: !!immichSharedLink,
      storageRoot,
      apiBaseUrl: immichBaseUrl
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
    const entries = await getGalleryEntries();
    json(res, 200, {
      total: entries.length,
      recent: entries.slice(0, 3),
      albumUrl: immichSharedLinkUrl || null
    });
    return;
  }

  if (req.url?.startsWith('/api/captures/') && req.method === 'GET') {
    const rel = decodeURIComponent(req.url.slice('/api/captures/'.length));
    const safeRel = rel.replace(/^\/+/, '');
    const target = path.resolve(storageRoot, safeRel.replace(/\//g, path.sep));
    if (!target.startsWith(storageRoot) || !existsSync(target)) {
      json(res, 404, { ok: false, message: 'Not found' });
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const contentType =
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : 'image/jpeg';
    const fileStat = await stat(target);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileStat.size,
      'Cache-Control': 'no-store'
    });
    createReadStream(target).pipe(res);
    return;
  }

  if (req.url?.startsWith('/api/thumbnails/') && req.method === 'GET') {
    const rel = decodeURIComponent(req.url.slice('/api/thumbnails/'.length));
    const safeRel = rel.replace(/^\/+/, '');
    const target = path.resolve(thumbnailRoot, safeRel.replace(/\//g, path.sep));
    if (!target.startsWith(thumbnailRoot) || !existsSync(target)) {
      json(res, 404, { ok: false, message: 'Not found' });
      return;
    }

    const fileStat = await stat(target);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': fileStat.size,
      'Cache-Control': 'no-store'
    });
    createReadStream(target).pipe(res);
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
