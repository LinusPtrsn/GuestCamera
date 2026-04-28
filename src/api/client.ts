import type { BuildInfoResponse, CaptureResponse, FrontendLog, GalleryResponse, StatusResponse } from '../types';

export function sendFrontendLog(entry: FrontendLog) {
  const payload = JSON.stringify({
    ...entry,
    pageUrl: window.location.href,
    userAgent: navigator.userAgent
  });
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/client-log', new Blob([payload], { type: 'application/json' }));
    return;
  }
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true
  }).catch(() => {});
}

export async function fetchGallery() {
  const response = await fetch('/api/gallery');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(errorMessageFromPayload(payload, `Galerie konnte nicht geladen werden (${response.status})`));
  }
  if (!isGalleryResponse(payload)) {
    throw new Error('Galerie-Antwort hatte ein unerwartetes Format');
  }
  return payload;
}

function errorMessageFromPayload(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
    return payload.message;
  }
  return fallback;
}

export function isGalleryResponse(payload: unknown): payload is GalleryResponse {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  return Number.isFinite(candidate.total)
    && typeof candidate.total === 'number'
    && candidate.total >= 0
    && Array.isArray(candidate.recent)
    && candidate.recent.every(isGalleryItem)
    && (typeof candidate.albumUrl === 'string' || candidate.albumUrl === null);
}

function isGalleryItem(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  return typeof candidate.name === 'string'
    && typeof candidate.url === 'string'
    && (typeof candidate.thumbnailUrl === 'string' || candidate.thumbnailUrl === null)
    && typeof candidate.createdAt === 'string'
    && Number.isFinite(candidate.size)
    && typeof candidate.size === 'number'
    && candidate.size >= 0;
}

export async function fetchStatus() {
  return Promise.all([
    fetch('/build-info.json', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Build-Info konnte nicht geladen werden (${res.status})`);
        return (await res.json()) as BuildInfoResponse;
      })
      .catch(() => ({ version: null })),
    fetch('/api/status').then((res) => res.json() as Promise<StatusResponse>)
  ]);
}

export function uploadCapture(form: FormData, onProgress: (progress: number) => void) {
  return new Promise<CaptureResponse>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/capture');
    request.responseType = 'json';
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.max(0.02, Math.min(event.loaded / event.total, 0.98)));
      }
    };
    request.onload = () => {
      const payload = request.response as CaptureResponse | null;
      if (request.status >= 200 && request.status < 300 && payload) {
        onProgress(1);
        resolve(payload);
        return;
      }
      reject(new Error(payload?.message ?? 'Upload fehlgeschlagen'));
    };
    request.onerror = () => reject(new Error('Upload-Verbindung fehlgeschlagen'));
    request.onabort = () => reject(new Error('Upload abgebrochen'));
    request.send(form);
  });
}
