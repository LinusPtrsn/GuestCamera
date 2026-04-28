import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGallery, isGalleryResponse, sendFrontendLog, uploadCapture } from './client';

class MockXHR {
  static latest: MockXHR | null = null;
  method = '';
  url = '';
  response: unknown = null;
  status = 0;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  sentBody: unknown = null;

  constructor() {
    MockXHR.latest = this;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: unknown) {
    this.sentBody = body;
  }
}

describe('api client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends frontend logs with beacon when available', () => {
    const beacon = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon });

    sendFrontendLog({ level: 'info', message: 'hello', source: 'test' });

    expect(beacon).toHaveBeenCalledWith('/api/client-log', expect.any(Blob));
  });

  it('rejects gallery error responses instead of returning the server error shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ ok: false, message: 'Immich unavailable' })
    }));

    await expect(fetchGallery()).rejects.toThrow('Immich unavailable');
  });

  it('rejects malformed gallery success payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ total: 3 })
    }));

    await expect(fetchGallery()).rejects.toThrow('unerwartetes Format');
  });

  it('validates gallery response shape', () => {
    const item = { name: 'asset', url: '/thumb', thumbnailUrl: null, createdAt: '2026-04-29T00:00:00.000Z', size: 0 };
    expect(isGalleryResponse({ total: 1, recent: [item], albumUrl: null })).toBe(true);
    expect(isGalleryResponse({ total: 1 })).toBe(false);
    expect(isGalleryResponse({ total: Number.NaN, recent: [], albumUrl: null })).toBe(false);
    expect(isGalleryResponse({ total: -1, recent: [], albumUrl: null })).toBe(false);
    expect(isGalleryResponse({ total: 1, recent: [{ ...item, size: Number.NaN }], albumUrl: null })).toBe(false);
    expect(isGalleryResponse({ total: 1, recent: [{ ...item, thumbnailUrl: 42 }], albumUrl: null })).toBe(false);
  });

  it('uploads captures through XMLHttpRequest and reports progress', async () => {
    vi.stubGlobal('XMLHttpRequest', MockXHR);
    const progress = vi.fn();
    const form = new FormData();
    const promise = uploadCapture(form, progress);
    const request = MockXHR.latest!;

    request.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
    request.status = 200;
    request.response = { ok: true, localPath: '', albumName: 'Album' };
    request.onload?.();

    await expect(promise).resolves.toMatchObject({ ok: true });
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/capture');
    expect(request.sentBody).toBe(form);
    expect(progress).toHaveBeenCalledWith(0.5);
    expect(progress).toHaveBeenCalledWith(1);
  });
});
