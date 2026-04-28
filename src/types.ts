export type CaptureResponse = {
  ok: boolean;
  localPath: string;
  albumName: string;
  assetId?: string;
  uploaded?: boolean;
  message?: string;
  warning?: string;
};

export type GalleryItem = {
  name: string;
  url: string;
  thumbnailUrl: string | null;
  createdAt: string;
  size: number;
};

export type StatusResponse = {
  immichConfigured: boolean;
  sharedLinkConfigured: boolean;
  storageRoot: string;
  apiBaseUrl: string;
  buildVersion: string;
  maxUploadBytes?: number;
};

export type GalleryResponse = {
  total: number;
  recent: GalleryItem[];
  albumUrl: string | null;
};

export type GalleryLiveMessage = {
  type: 'gallery:update';
  gallery: GalleryResponse;
};

export type FrontendLog = {
  level: 'error' | 'warn' | 'info';
  message: string;
  source: string;
  stack?: string;
};

export type BuildInfoResponse = {
  version?: unknown;
};

export type MediaKind = 'photo' | 'video';
export type CaptureIntent = MediaKind | 'auto';

export type ShotState = {
  kind: MediaKind;
  blob: Blob;
  previewUrl: string;
  thumbnailUrl: string;
  capturedAt: string;
};

export type UploadPreviewState = {
  id: string;
  kind: MediaKind;
  thumbnailUrl: string;
  progress: number;
  status: 'uploading' | 'done' | 'failed';
};
