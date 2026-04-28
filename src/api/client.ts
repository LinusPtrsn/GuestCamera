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
  return (await response.json()) as GalleryResponse;
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
