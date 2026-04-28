import type { GalleryItem, UploadPreviewState } from '../types';

type Props = {
  albumLink: string;
  extraCount: number;
  galleryLoading: boolean;
  localUpload: UploadPreviewState | null;
  recent: GalleryItem[];
  totalCount: number;
};

export function GalleryStrip({ albumLink, extraCount, galleryLoading, localUpload, recent, totalCount }: Props) {
  return (
    <section className="gallery-block">
      <a className="gallery-grid" href={albumLink} target="_blank" rel="noreferrer" aria-label="Gesamtes Album öffnen">
        {[0, 1, 2].map((slot) => {
          if (slot === 0 && localUpload) {
            const label =
              localUpload.status === 'failed'
                ? 'Upload fehlgeschlagen'
                : localUpload.status === 'done'
                  ? localUpload.kind === 'video' ? 'Video hochgeladen' : 'Foto hochgeladen'
                  : localUpload.kind === 'video' ? 'Video wird hochgeladen' : 'Foto wird hochgeladen';
            return (
              <div key={localUpload.id} className={`gallery-cell gallery-cell-uploading is-${localUpload.status}`} aria-live="polite">
                <img className="upload-preview-image" src={localUpload.thumbnailUrl} alt="" />
                <div className="upload-placeholder">
                  <span>{label}</span>
                  <div className="upload-bar" aria-hidden="true">
                    <div className="upload-bar-fill" style={{ width: `${Math.round(localUpload.progress * 100)}%` }} />
                  </div>
                  <small>{Math.round(localUpload.progress * 100)}%</small>
                </div>
              </div>
            );
          }

          const item = recent[localUpload ? slot - 1 : slot];
          return (
            <div key={slot} className={`gallery-cell gallery-cell-${slot + 1}`}>
              {item?.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : null}
            </div>
          );
        })}
        <div className="gallery-cell gallery-cell-more">
          {galleryLoading ? (
            <div className="gallery-loading" aria-live="polite">
              <span className="loading-ring" aria-hidden="true" />
              <small>Album lädt</small>
            </div>
          ) : (
            <>
              <span>+{extraCount}</span>
              <small>{totalCount} Fotos</small>
            </>
          )}
        </div>
      </a>
    </section>
  );
}
