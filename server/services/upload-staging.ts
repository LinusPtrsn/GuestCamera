import { rm, mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import Busboy from 'busboy';
import type { CaptureUpload } from '../types';

export async function parseCaptureUpload(req: any, tempRoot: string, maxUploadBytes: number): Promise<CaptureUpload> {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new Error('Missing multipart boundary');
  }

  const tempDir = await mkdtemp(path.join(tempRoot, 'upload-'));
  const uploadPath = path.join(tempDir, 'asset.upload');
  const fields = new Map<string, string>();

  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: maxUploadBytes > 0 ? { fileSize: maxUploadBytes } : undefined
    });
    let fileFound = false;
    let activeFile: NodeJS.ReadableStream | null = null;
    let fileWrite: ReturnType<typeof createWriteStream> | null = null;
    let fileWritten: Promise<void> | null = null;
    let completed = false;

    const fail = (cause: Error) => {
      if (completed) {
        return;
      }
      completed = true;
      req.unpipe(busboy);
      req.resume();
      activeFile?.unpipe(fileWrite ?? undefined);
      activeFile?.resume();
      fileWrite?.end();
      void rm(tempDir, { recursive: true, force: true });
      setTimeout(() => {
        void rm(tempDir, { recursive: true, force: true });
      }, 1000);
      reject(cause);
    };

    busboy.on('field', (name, value) => {
      fields.set(name, value);
    });
    busboy.on('file', (name, file) => {
      if (name !== 'photo' || fileFound) {
        file.resume();
        return;
      }

      fileFound = true;
      activeFile = file;
      fileWrite = createWriteStream(uploadPath, { flags: 'wx' });
      fileWritten = new Promise((resolve, reject) => {
        fileWrite?.on('finish', resolve);
        fileWrite?.on('error', reject);
      });
      file.on('limit', () => {
        fail(new Error('Upload too large'));
      });
      file.on('error', fail);
      fileWrite.on('error', fail);
      file.pipe(fileWrite);
    });
    busboy.on('error', fail);
    busboy.on('finish', () => {
      if (completed) {
        return;
      }
      if (!fileFound || !fileWritten) {
        fail(new Error('Foto fehlt'));
        return;
      }
      fileWritten
        .then(() => {
          if (completed) {
            return;
          }
          completed = true;
          resolve({ fields, tempDir, filePath: uploadPath });
        })
        .catch(fail);
    });

    req.pipe(busboy);
  });
}
