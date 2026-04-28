import type { ShotState } from '../types';

type Props = {
  busy: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
  shot: ShotState;
};

export function ConfirmationPreview({ busy, onConfirm, onDiscard, shot }: Props) {
  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label={shot.kind === 'video' ? 'Video bestätigen' : 'Foto bestätigen'}>
      <div className="confirm-shell">
        {shot.kind === 'video' ? (
          <video className="preview-media confirm-media" src={shot.previewUrl} controls playsInline autoPlay muted />
        ) : (
          <img className="preview-image confirm-image" src={shot.previewUrl} alt="Aufgenommenes Foto" />
        )}
        <div className="confirm-actions">
          <button className="button secondary preview-secondary" type="button" onClick={onDiscard} disabled={busy}>
            Nicht jetzt
          </button>
          <button className="button primary preview-primary" type="button" onClick={onConfirm} disabled={busy}>
            {shot.kind === 'video' ? 'Video hochladen' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}
