import { spawn } from 'node:child_process';
import path from 'node:path';

export function uploaderDescription(name: string) {
  const trimmed = name.trim();
  return trimmed
    ? `Uploaded by guest camera user: ${trimmed}`
    : 'Uploaded by anonymous guest camera user';
}

export function descriptionMetadataArgs(filePath: string, description: string) {
  const extension = path.extname(filePath).toLowerCase();
  const isQuickTimeContainer = ['.mp4', '.mov', '.m4v'].includes(extension);
  return [
    '-m',
    '-overwrite_original',
    '-Description=' + description,
    '-ImageDescription=' + description,
    '-XMP-dc:Description=' + description,
    '-UserComment=' + description,
    ...(isQuickTimeContainer
      ? [
          '-Keys:Description=' + description,
          '-ItemList:Description=' + description,
          '-UserData:Description=' + description
        ]
      : []),
    filePath
  ];
}

export async function writeDescriptionMetadata(filePath: string, description: string, exiftoolCandidates: string[]) {
  const errors: string[] = [];
  for (const exiftool of exiftoolCandidates) {
    const result = await new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
      const child = spawn(exiftool, descriptionMetadataArgs(filePath, description), { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (cause) => {
        resolve({ ok: false, message: cause.message });
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true });
          return;
        }
        resolve({ ok: false, message: stderr.trim() || `ExifTool exited with code ${code}` });
      });
    });
    if (result.ok) {
      return;
    }
    errors.push(`${exiftool}: ${result.message}`);
  }
  throw new Error(errors.join(' | ') || 'ExifTool is not available');
}
