import { describe, expect, it } from 'vitest';
import { captureFilename, extensionForMimeType, normalizeCaptureMimeType, safeCapturedAt } from './capture-input';

describe('capture input normalization', () => {
  it('validates supported MIME types and rejects unknown values', () => {
    expect(normalizeCaptureMimeType('IMAGE/JPEG; charset=binary')).toBe('image/jpeg');
    expect(normalizeCaptureMimeType('video/mp4')).toBe('video/mp4');
    expect(() => normalizeCaptureMimeType('video/mp4\r\nx-evil: yes')).toThrow('Nicht unterstützter Dateityp');
    expect(() => normalizeCaptureMimeType('application/octet-stream')).toThrow('Nicht unterstützter Dateityp');
  });

  it('maps supported MIME types to extensions', () => {
    expect(extensionForMimeType('video/quicktime')).toBe('.mov');
    expect(extensionForMimeType('image/heic')).toBe('.heic');
  });

  it('normalizes invalid client timestamps to a server-controlled timestamp', () => {
    const now = new Date('2026-04-29T10:00:00.000Z');
    expect(safeCapturedAt('../../escape', now)).toBe('2026-04-29T10:00:00.000Z');
    expect(safeCapturedAt('2026-04-29T08:00:00.000Z', now)).toBe('2026-04-29T08:00:00.000Z');
  });

  it('creates filenames without path separators from capturedAt', () => {
    const filename = captureFilename('../../escape/2026:04:29', 'image/jpeg', 'id/../bad');
    expect(filename).toMatch(/\.jpg$/);
    expect(filename).not.toContain('/');
    expect(filename).not.toContain('..');
  });
});
