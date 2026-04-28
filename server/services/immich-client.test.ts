import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImmichClient, multipartField, multipartFileHeader } from './immich-client';

describe('ImmichClient', () => {
  it('fails uploads when Immich is not configured', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'guest-camera-immich-test-'));
    const filePath = path.join(tempRoot, 'asset.jpg');
    try {
      await writeFile(filePath, 'asset');
      const client = new ImmichClient({ baseUrl: '', sharedLink: null });

      await expect(client.uploadAsset(filePath, new Date().toISOString(), 'image/jpeg'))
        .rejects.toThrow('IMMICH_SHARED_LINK_URL fehlt oder ist keine gueltige URL');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('formats multipart field chunks', () => {
    expect(multipartField('boundary', 'name', 'value').toString()).toContain('name="name"');
    expect(multipartFileHeader('boundary', 'assetData', 'asset.jpg', 'image/jpeg').toString()).toContain('filename="asset.jpg"');
  });
});
