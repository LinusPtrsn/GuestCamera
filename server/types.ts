export type ImmichSharedLinkAuth = {
  key?: string;
  slug?: string;
};

export type ImmichSharedLinkResponse = {
  assets?: ImmichAsset[];
  album?: {
    id: string;
    assetCount?: number;
    albumThumbnailAssetId?: string | null;
  };
};

export type ImmichAsset = {
  id: string;
  createdAt?: string;
  fileCreatedAt?: string;
  thumbhash?: string | null;
};

export type ImmichTimeBucket = {
  timeBucket: string;
  count: number;
};

export type ImmichTimeBucketAssets = {
  id: string[];
  isTrashed?: boolean[];
  fileCreatedAt?: string[];
  thumbhash?: Array<string | null>;
};

export type CaptureUpload = {
  fields: Map<string, string>;
  tempDir: string;
  filePath: string;
};
