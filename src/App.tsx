import { Camera, CameraOff, ChevronRight, User } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

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

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [mode, setMode] = useState<Mode>('intro');
  const [name, setName] = useState('');
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [gallery, setGallery] = useState<GalleryResponse>({ total: 0, recent: [], albumUrl: null });
  const [cameraActive, setCameraActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Bereit');
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');

  const canShoot = useMemo(() => !busy && cameraActive, [busy, cameraActive]);
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
      stopCamera();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const startCamera = async () => {
    setError('');
    setMessage('Kamera wird gestartet');
    try {
      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices?.getUserMedia) throw new Error('Kamera ist in diesem Browser nicht verfuegbar');
      const stream = await mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
      setMessage('Kamera aktiv');
    } catch (cause) {
      setCameraActive(false);
      const text = cause instanceof Error ? cause.message : 'Kamerazugriff fehlgeschlagen';
      setMessage('Kamera blockiert');
      setError(text);
      sendFrontendLog({
        level: 'error',
        message: text,
        source: 'startCamera',
        stack: cause instanceof Error ? cause.stack : undefined
      });
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
  };

  const capture = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    setBusy(true);
    setError('');
    setMessage('Foto wird aufgenommen');
    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas-Kontext fehlt');
      context.drawImage(video, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => {
          if (!result) {
            reject(new Error('Bild konnte nicht erzeugt werden'));
            return;
          }
          resolve(result);
        }, 'image/jpeg', 0.95);
      });

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));

      const form = new FormData();
      form.append('name', name.trim());
      form.append('mimeType', 'image/jpeg');
      form.append('capturedAt', new Date().toISOString());
      form.append('photo', blob, `guest-camera-${Date.now()}.jpg`);

      const response = await fetch('/api/capture', { method: 'POST', body: form });
      const payload = (await response.json()) as CaptureResponse;
      if (!response.ok) throw new Error(payload.message ?? 'Upload fehlgeschlagen');

      setMessage(payload.uploaded ? 'Foto hochgeladen' : 'Foto lokal gespeichert');
      if (payload.warning) setError(payload.warning);
      await refreshGallery();
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Unbekannter Fehler';
      setError(text);
      sendFrontendLog({
        level: 'error',
        message: text,
        source: 'capture',
        stack: cause instanceof Error ? cause.stack : undefined
      });
      setMessage('Fehler beim Schiessen');
    } finally {
      setBusy(false);
    }
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
              <h1>Guest Camera</h1>
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
              <h1>Guest Camera</h1>
              <p>{status?.sharedLinkConfigured ? 'Immich Shared Link' : 'Immich'}</p>
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

        <button
          className="shot-button"
          type="button"
          onClick={canShoot ? capture : startCamera}
          disabled={busy}
          aria-label={cameraActive ? 'Foto aufnehmen' : 'Kamera starten und Foto aufnehmen'}
        >
          {cameraActive ? <CameraOff size={22} /> : <Camera size={22} />}
          <span>Foto aufnehmen</span>
          <ChevronRight size={18} />
        </button>

        <div className="status-row">
          <button className="text-button" type="button" onClick={() => setMode('intro')}>
            Namen ändern
          </button>
          <button className="text-button" type="button" onClick={stopCamera}>
            Kamera stoppen
          </button>
        </div>

        <video ref={videoRef} className="video" autoPlay playsInline muted />
        <canvas ref={canvasRef} className="hidden-canvas" />
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}
