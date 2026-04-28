import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import type {
  ImmichSharedLinkAuth,
  ImmichSharedLinkResponse,
  ImmichTimeBucket,
  ImmichTimeBucketAssets
} from '../types';

type ImmichClientOptions = {
  apiKey: string;
  baseUrl: string;
  sharedLink: ImmichSharedLinkAuth | null;
};

export class ImmichClient {
  constructor(private options: ImmichClientOptions) {}

  get configured() {
    return !!this.options.baseUrl && (this.options.apiKey.length > 0 || !!this.options.sharedLink);
  }

  apiUrl(pathname: string, params: Record<string, string | undefined> = {}) {
    if (!this.options.baseUrl) {
      throw new Error('IMMICH_SHARED_LINK_URL fehlt oder ist keine gueltige URL');
    }
    const url = new URL(`${this.options.baseUrl}${pathname}`);
    if (this.options.sharedLink?.key) {
      url.searchParams.set('key', this.options.sharedLink.key);
    }
    if (this.options.sharedLink?.slug) {
      url.searchParams.set('slug', this.options.sharedLink.slug);
    }
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    return url;
  }

  async fetchJson<T>(pathname: string, params: Record<string, string | undefined> = {}) {
    const response = await fetch(this.apiUrl(pathname, params), {
      headers: {
        Accept: 'application/json',
        ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {})
      }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Immich request failed: ${response.status} ${text}`);
    }
    return (await response.json()) as T;
  }

  thumbnailUrl(assetId: string, thumbhash?: string | null) {
    const url = this.apiUrl(`/assets/${assetId}/thumbnail`);
    if (thumbhash) {
      url.searchParams.set('c', thumbhash);
    }
    return url.toString();
  }

  async uploadAsset(filePath: string, capturedAt: string, mimeType: string) {
    if (!this.configured) {
      return { uploaded: false, warning: 'IMMICH_SHARED_LINK_URL fehlt oder ist keine gueltige URL' };
    }

    const filename = path.basename(filePath);
    const checksum = await sha1File(filePath);
    const uploadUrl = this.apiUrl('/assets');
    const boundary = `guest-camera-${crypto.randomUUID()}`;
    const fileHeader = multipartFileHeader(boundary, 'assetData', filename, mimeType);
    const fields = [
      multipartField(boundary, 'deviceAssetId', checksum),
      multipartField(boundary, 'deviceId', 'guest-camera'),
      multipartField(boundary, 'fileCreatedAt', capturedAt),
      multipartField(boundary, 'fileModifiedAt', capturedAt),
      multipartField(boundary, 'filename', filename),
      multipartField(boundary, 'isFavorite', 'false')
    ];
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const fileSize = (await stat(filePath)).size;
    const contentLength = [...fields, fileHeader, footer].reduce((sum, chunk) => sum + chunk.byteLength, fileSize);

    const uploadResult = await new Promise<{ id?: string; status?: string; duplicate?: boolean }>((resolve, reject) => {
      const transportRequest = uploadUrl.protocol === 'http:' ? httpRequest : httpsRequest;
      const request = transportRequest(
        uploadUrl,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': contentLength,
            ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {})
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(new Error(`Immich upload failed: ${response.statusCode ?? 'unknown'} ${text}`));
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new Error(`Immich upload returned invalid JSON: ${text}`));
            }
          });
        }
      );
      request.on('error', reject);
      for (const field of fields) {
        request.write(field);
      }
      request.write(fileHeader);
      const fileStream = createReadStream(filePath);
      fileStream.on('error', (cause) => {
        request.destroy(cause);
      });
      fileStream.on('end', () => {
        request.end(footer);
      });
      fileStream.pipe(request, { end: false });
    });

    return { uploaded: true, assetId: uploadResult.id };
  }

  getSharedLink() {
    return this.fetchJson<ImmichSharedLinkResponse>('/shared-links/me');
  }

  getTimeBuckets(albumId: string) {
    return this.fetchJson<ImmichTimeBucket[]>('/timeline/buckets', { albumId, order: 'desc' });
  }

  getTimeBucket(albumId: string, timeBucket: string) {
    return this.fetchJson<ImmichTimeBucketAssets>('/timeline/bucket', { albumId, timeBucket, order: 'desc' });
  }
}

export async function sha1File(filePath: string) {
  const hash = crypto.createHash('sha1');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function multipartField(boundary: string, name: string, value: string) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    'utf8'
  );
}

export function multipartFileHeader(boundary: string, name: string, filename: string, mimeType: string) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
}
