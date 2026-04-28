import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseCaptureUpload } from './upload-staging';

function multipartBody(boundary: string, fileContent: Buffer) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nAndreas\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

function multipartWithFields(boundary: string, fields: Array<[string, string]>, fileContent = Buffer.from('abc')) {
  return Buffer.concat([
    ...fields.map(([name, value]) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    ),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

function requestFor(body: Buffer, boundary: string) {
  const stream = Readable.from(body) as any;
  stream.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return stream;
}

describe('upload staging', () => {
  it('streams the uploaded file to a staging directory', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'guest-camera-test-'));
    try {
      const upload = await parseCaptureUpload(requestFor(multipartBody('x-test', Buffer.from('abc')), 'x-test'), tempRoot, 1024);

      expect(upload.fields.get('name')).toBe('Andreas');
      expect(await readFile(upload.filePath, 'utf8')).toBe('abc');
      expect((await stat(upload.tempDir)).isDirectory()).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects files over the configured limit and removes staged data', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'guest-camera-test-'));
    try {
      await expect(parseCaptureUpload(requestFor(multipartBody('x-test', Buffer.from('too large')), 'x-test'), tempRoot, 3))
        .rejects.toThrow('Upload too large');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects too many multipart fields', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'guest-camera-test-'));
    const fields = Array.from({ length: 9 }, (_, index) => [`field${index}`, 'value'] as [string, string]);
    try {
      await expect(parseCaptureUpload(requestFor(multipartWithFields('x-test', fields), 'x-test'), tempRoot, 1024))
        .rejects.toThrow('Too many upload fields');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects oversized multipart field values', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'guest-camera-test-'));
    try {
      await expect(parseCaptureUpload(
        requestFor(multipartWithFields('x-test', [['name', 'x'.repeat(1025)]]), 'x-test'),
        tempRoot,
        1024
      )).rejects.toThrow('Upload field too large');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
