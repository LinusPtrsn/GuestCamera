import { describe, expect, it } from 'vitest';
import { resolveImmichBaseUrl, resolveSharedLinkAuth } from './config';

describe('server config', () => {
  it('derives the Immich API URL from a shared link URL', () => {
    expect(resolveImmichBaseUrl('https://photos.example.test/share/abc123')).toBe('https://photos.example.test/api');
  });

  it('extracts a shared-link key from path, query, or plain key', () => {
    expect(resolveSharedLinkAuth('https://photos.example.test/share/path-key', '')).toEqual({ key: 'path-key' });
    expect(resolveSharedLinkAuth('https://photos.example.test/share/foo?key=query-key', '')).toEqual({ key: 'query-key' });
    expect(resolveSharedLinkAuth('plain-key', '')).toEqual({ key: 'plain-key' });
  });

  it('prefers explicit shared-link slug', () => {
    expect(resolveSharedLinkAuth('ignored', 'sluggy')).toEqual({ slug: 'sluggy' });
  });
});
