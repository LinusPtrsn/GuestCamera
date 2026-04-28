import { Camera, User, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type CaptureResponse = {
  ok: boolean;
  localPath: string;
  albumName: string;
  assetId?: string;
  uploaded?: boolean;
  message?: string;
  warning?: string;
};

type GalleryItem = {
  name: string;
  url: string;
  createdAt: string;
  size: number;
};

type StatusResponse = {
  immichConfigured: boolean;
  sharedLinkConfigured: boolean;
  storageRoot: string;
  apiBaseUrl: string;
};

type GalleryResponse = {
  total: number;
  recent: GalleryItem[];
  albumUrl: string | null;
};

type FrontendLog = {
  level: 'error' | 'warn' | 'info';
  message: string;
  source: string;
  stack?: string;
};

type Mode = 'intro' | 'main';
type MediaKind = 'photo' | 'video';
type ShotState = {
  kind: MediaKind;
  blob: Blob;
  previewUrl: string;
  capturedAt: string;
};

export default function App() {
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<Mode>('intro');
  const [name, setName] = useState('');
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [gallery, setGallery] = useState<GalleryResponse>({ total: 0, recent: [], albumUrl: null });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Bereit');
  const [error, setError] = useState('');
  const [pendingShot, setPendingShot] = useState<ShotState | null>(null);
  const [captureKind, setCaptureKind] = useState<MediaKind>('photo');

  const recent = gallery.recent.slice(0, 3);
  const totalCount = gallery.total;
  const extraCount = Math.max(totalCount - 3, 0);
  const albumLink = gallery.albumUrl || '#';
  const sendFrontendLog = (entry: FrontendLog) => {
    const payload = JSON.stringify({
      ...entry,
      pageUrl: window.location.href,
      userAgent: navigator.userAgent
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/client-log', new Blob([payload], { type: 'application/json' }));
      return;
    }
    void fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(() => {});
  };

  const refreshGallery = async () => {
    const response = await fetch('/api/gallery');
    const data = (await response.json()) as GalleryResponse;
    setGallery(data);
  };

  useEffect(() => {
    let active = true;
    void fetch('/api/status')
      .then((res) => res.json())
      .then((data: StatusResponse) => {
        if (active) setStatus(data);
      })
      .catch(() => {
        if (active) setStatus(null);
      });
    void refreshGallery().catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onWindowError = (event: ErrorEvent) => {
      sendFrontendLog({
        level: 'error',
        message: event.message || 'Window error',
        source: 'window.error',
        stack: event.error instanceof Error ? event.error.stack : undefined
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      sendFrontendLog({
        level: 'error',
        message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection'),
        source: 'window.unhandledrejection',
        stack: reason instanceof Error ? reason.stack : undefined
      });
    };
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      if (pendingShot?.previewUrl) URL.revokeObjectURL(pendingShot.previewUrl);
    };
  }, [pendingShot]);

  const openNativeCamera = () => {
    setCaptureKind('photo');
    setError('');
    setMessage('Kamera wird geöffnet');
    photoInputRef.current?.click();
  };

  const openNativeVideo = () => {
    setCaptureKind('video');
    setError('');
    setMessage('Videokamera wird geöffnet');
    videoInputRef.current?.click();
  };

  const openDevicePicker = () => {
    setError('');
    setMessage('Datei wird ausgewählt');
    libraryInputRef.current?.click();
  };

  const handleNativeCapture = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      setMessage('Bereit');
      return;
    }

    try {
      if (pendingShot?.previewUrl) URL.revokeObjectURL(pendingShot.previewUrl);
      const previewUrl = URL.createObjectURL(file);
      const kind: MediaKind = file.type.startsWith('video/') || captureKind === 'video' ? 'video' : 'photo';
      setPendingShot({ kind, blob: file, previewUrl, capturedAt: new Date().toISOString() });
      setMessage(kind === 'video' ? 'Video aufgenommen' : 'Foto aufgenommen');
      setError('');
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Bild konnte nicht geladen werden';
      setError(text);
      sendFrontendLog({
        level: 'error',
        message: text,
        source: 'nativeCapture',
        stack: cause instanceof Error ? cause.stack : undefined
      });
      setMessage('Fehler beim Öffnen');
    }
  };

  const confirmUpload = async () => {
    if (!pendingShot) return;
    setBusy(true);
    setError('');
    setMessage(pendingShot.kind === 'video' ? 'Video-Upload läuft' : 'Upload läuft');
    try {
      const form = new FormData();
      form.append('name', name.trim());
      form.append('mimeType', pendingShot.blob.type || 'image/jpeg');
      form.append('capturedAt', pendingShot.capturedAt);
      form.append('photo', pendingShot.blob, `guest-camera-${Date.now()}.jpg`);

      const response = await fetch('/api/capture', { method: 'POST', body: form });
      const payload = (await response.json()) as CaptureResponse;
      if (!response.ok) throw new Error(payload.message ?? 'Upload fehlgeschlagen');

      setMessage(payload.uploaded ? (pendingShot.kind === 'video' ? 'Video hochgeladen' : 'Foto hochgeladen') : 'Lokal gespeichert');
      if (payload.warning) setError(payload.warning);
      await refreshGallery();
      if (pendingShot.previewUrl) URL.revokeObjectURL(pendingShot.previewUrl);
      setPendingShot(null);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Unbekannter Fehler';
      setError(text);
      sendFrontendLog({
        level: 'error',
        message: text,
        source: 'capture',
        stack: cause instanceof Error ? cause.stack : undefined
      });
      setMessage('Upload fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  const discardShot = () => {
    if (pendingShot?.previewUrl) URL.revokeObjectURL(pendingShot.previewUrl);
    setPendingShot(null);
    setMessage('Bereit');
    setError('');
  };

  if (mode === 'intro') {
    return (
      <main className="shell intro-shell">
        <section className="intro-card">
          <div className="brand intro-brand">
            <span className="brand-mark" aria-hidden="true">
              <User />
            </span>
            <div>
              <h1>Frühlingsfest Gästekamera</h1>
              <p>Name ist optional</p>
            </div>
          </div>

          <label className="field intro-field">
            <span className="field-label">
              <User size={16} />
              Dein Name
            </span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="optional" autoComplete="name" />
          </label>

          <div className="intro-actions">
            <button className="button secondary" type="button" onClick={() => setMode('main')}>
              Überspringen
            </button>
            <button className="button primary" type="button" onClick={() => setMode('main')}>
              Weiter
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="title-row">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Camera />
            </span>
            <div>
              <h1>Frühlingsfest Gästekamera</h1>
              <p>Für das Fest</p>
            </div>
          </div>
          <div className="pill">{message}</div>
        </div>

        <section className="gallery-block">
          <a className="gallery-grid" href={albumLink} target="_blank" rel="noreferrer" aria-label="Gesamtes Album öffnen">
            {[0, 1, 2].map((slot) => {
              const item = recent[slot];
              return (
                <div key={slot} className={`gallery-cell gallery-cell-${slot + 1}`}>
                  {item ? <img src={item.url} alt="" /> : null}
                </div>
              );
            })}
            <div className="gallery-cell gallery-cell-more">
              <span>+{extraCount}</span>
              <small>{totalCount} Fotos</small>
            </div>
          </a>
        </section>

        {!pendingShot ? (
          <div className="shot-stack">
            <div className="split-shots">
              <button className="shot-button shot-button-secondary" type="button" onClick={openNativeVideo} disabled={busy} aria-label="Video aufnehmen">
                <Video size={20} />
                <span>Video aufnehmen</span>
              </button>
              <button className="shot-button shot-button-primary" type="button" onClick={openNativeCamera} disabled={busy} aria-label="Kamera öffnen">
                <Camera size={22} />
                <span>Foto aufnehmen</span>
              </button>
            </div>
            <button className="native-fallback" type="button" onClick={openDevicePicker} disabled={busy}>
              Datei vom Gerät auswählen
            </button>
          </div>
        ) : null}

        <input
          ref={photoInputRef}
          className="hidden-input"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleNativeCapture}
          aria-hidden="true"
          tabIndex={-1}
        />

        <input
          ref={videoInputRef}
          className="hidden-input"
          type="file"
          accept="video/*"
          capture
          onChange={handleNativeCapture}
          aria-hidden="true"
          tabIndex={-1}
        />

        <input
          ref={libraryInputRef}
          className="hidden-input"
          type="file"
          accept="image/*,video/*"
          onChange={handleNativeCapture}
          aria-hidden="true"
          tabIndex={-1}
        />

        <div className="status-row">
          <button className="text-button" type="button" onClick={() => setMode('intro')}>
            Namen ändern
          </button>
        </div>

        {pendingShot ? (
          <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label={pendingShot.kind === 'video' ? 'Video bestätigen' : 'Foto bestätigen'}>
            <div className="confirm-shell">
              {pendingShot.kind === 'video' ? (
                <video className="preview-media confirm-media" src={pendingShot.previewUrl} controls playsInline autoPlay muted />
              ) : (
                <img className="preview-image confirm-image" src={pendingShot.previewUrl} alt="Aufgenommenes Foto" />
              )}
              <div className="confirm-actions">
                <button className="button secondary preview-secondary" type="button" onClick={discardShot} disabled={busy}>
                  Nicht jetzt
                </button>
                <button className="button primary preview-primary" type="button" onClick={confirmUpload} disabled={busy}>
                  {pendingShot.kind === 'video' ? 'Video hochladen' : 'Upload'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}
