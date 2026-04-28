import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ImmichSharedLinkAuth } from './types';

export function loadDotEnv(filePath: string) {
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

export function normalizeImmichUrl(url: string) {
  return url.replace(/\/+$/, '');
}

export function resolveImmichBaseUrl(sharedLinkUrl: string) {
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

export function resolveSharedLinkAuth(urlOrKey: string, slug: string): ImmichSharedLinkAuth | null {
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

export function createServerConfig(projectRoot: string) {
  loadDotEnv(path.join(projectRoot, '.env'));

  const immichSharedLinkUrl = process.env.IMMICH_SHARED_LINK_URL?.trim() || '';
  const immichBaseUrl = resolveImmichBaseUrl(immichSharedLinkUrl);
  const immichSharedLink = resolveSharedLinkAuth(
    immichSharedLinkUrl || process.env.IMMICH_SHARED_LINK_KEY?.trim() || '',
    process.env.IMMICH_SHARED_LINK_SLUG?.trim() ?? '',
  );
  return {
    buildVersion: process.env.GUEST_CAMERA_BUILD_VERSION?.trim() || 'dev',
    clientDist: path.join(projectRoot, 'dist', 'client'),
    exiftoolCandidates: process.env.EXIFTOOL_PATH?.trim() ? [process.env.EXIFTOOL_PATH.trim()] : ['exiftool'],
    frontendLogPath: path.join(projectRoot, 'logs', 'frontend-client.ndjson'),
    immichBaseUrl,
    immichConfigured: !!immichBaseUrl && !!immichSharedLink,
    immichSharedLink,
    immichSharedLinkUrl,
    logsRoot: path.join(projectRoot, 'logs'),
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 250 * 1024 * 1024),
    port: Number(process.env.PORT ?? 3001),
    tempRoot: path.resolve(process.env.UPLOAD_STAGING_DIR?.trim() || path.join(projectRoot, 'uploads'))
  };
}

export type ServerConfig = ReturnType<typeof createServerConfig>;
