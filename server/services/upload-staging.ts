import { rm, mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import Busboy from 'busboy';
import type { CaptureUpload } from '../types';

export const uploadFieldLimits = {
  fields: 8,
  fieldNameSize: 64,
  fieldSize: 1024,
  files: 1,
  parts: 12
};

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
      limits: {
        ...uploadFieldLimits,
        ...(maxUploadBytes > 0 ? { fileSize: maxUploadBytes } : {})
      }
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

    busboy.on('field', (name, value, info) => {
      if (info.nameTruncated) {
        fail(new Error('Upload field name too large'));
        return;
      }
      if (info.valueTruncated) {
        fail(new Error('Upload field too large'));
        return;
      }
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
    busboy.on('fieldsLimit', () => {
      fail(new Error('Too many upload fields'));
    });
    busboy.on('filesLimit', () => {
      fail(new Error('Too many upload files'));
    });
    busboy.on('partsLimit', () => {
      fail(new Error('Too many upload parts'));
    });
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
