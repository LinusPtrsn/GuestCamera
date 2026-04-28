export const supportedMimeTypes = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm'
} as const;

export type SupportedMimeType = keyof typeof supportedMimeTypes;

export function normalizeCaptureMimeType(rawMimeType: string) {
  const normalized = rawMimeType.toLowerCase().split(';')[0].trim();
  if (Object.hasOwn(supportedMimeTypes, normalized)) {
    return normalized as SupportedMimeType;
  }
  throw new Error('Nicht unterstützter Dateityp');
}

export function extensionForMimeType(mimeType: SupportedMimeType) {
  return supportedMimeTypes[mimeType];
}

export function safeCapturedAt(rawCapturedAt: string, now = new Date()) {
  const parsed = rawCapturedAt ? new Date(rawCapturedAt) : now;
  if (Number.isNaN(parsed.getTime())) {
    return now.toISOString();
  }
  return parsed.toISOString();
}

export function captureFilename(capturedAt: string, mimeType: SupportedMimeType, id: string) {
  const safeTimestamp = safeCapturedAt(capturedAt).replace(/[^0-9A-Za-z-]/g, '-');
  const safeId = id.replace(/[^0-9A-Za-z-]/g, '').slice(0, 32);
  return `${safeTimestamp}-${safeId}${extensionForMimeType(mimeType)}`;
}
