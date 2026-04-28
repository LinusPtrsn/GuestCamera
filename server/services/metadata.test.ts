import { describe, expect, it } from 'vitest';
import { descriptionMetadataArgs, uploaderDescription } from './metadata';

describe('metadata service', () => {
  it('formats uploader descriptions', () => {
    expect(uploaderDescription('Andreas')).toBe('Uploaded by guest camera user: Andreas');
    expect(uploaderDescription('')).toBe('Uploaded by anonymous guest camera user');
  });

  it('writes generic image description tags for images', () => {
    const args = descriptionMetadataArgs('/tmp/photo.jpg', 'Uploaded by Test');
    expect(args).toContain('-Description=Uploaded by Test');
    expect(args).toContain('-ImageDescription=Uploaded by Test');
    expect(args).not.toContain('-Keys:Description=Uploaded by Test');
  });

  it('adds QuickTime description groups for MP4/MOV containers', () => {
    const args = descriptionMetadataArgs('/tmp/video.mp4', 'Uploaded by Test');
    expect(args).toContain('-Keys:Description=Uploaded by Test');
    expect(args).toContain('-ItemList:Description=Uploaded by Test');
    expect(args).toContain('-UserData:Description=Uploaded by Test');
  });
});
