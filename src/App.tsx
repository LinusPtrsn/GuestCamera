import { Camera, Plus, RefreshCw, Smartphone, User, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fetchGallery, fetchStatus, isGalleryLiveMessage, sendFrontendLog as sendFrontendLogEntry, uploadCapture as uploadCaptureRequest } from './api/client';
import { ConfirmationPreview } from './components/ConfirmationPreview';
import { GalleryStrip } from './components/GalleryStrip';
import { getBuildStatus } from './hooks/useBuildStatus';
import { useFrontendLogging } from './hooks/useFrontendLogging';
import type { CaptureIntent, GalleryResponse, MediaKind, ShotState, StatusResponse, UploadPreviewState } from './types';

type Mode = 'intro' | 'main';
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const STORAGE_NAME_KEY = 'guest-camera:name';
const STORAGE_NAME_SKIPPED_KEY = 'guest-camera:name-skipped';

function extensionForMedia(kind: MediaKind, mimeType: string) {
  if (kind === 'video') {
    if (mimeType === 'video/mp4') return '.mp4';
    if (mimeType === 'video/quicktime') return '.mov';
    if (mimeType === 'video/webm') return '.webm';
    return '.webm';
  }
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

function canvasToPreviewUrl(canvas: HTMLCanvasElement) {
  return canvas.toDataURL('image/jpeg', 0.74);
}

function fallbackPreviewUrl(kind: MediaKind) {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const gradient = context.createLinearGradient(0, 0, 720, 720);
  gradient.addColorStop(0, kind === 'video' ? '#3d658f' : '#aa6f17');
  gradient.addColorStop(1, '#102018');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 720, 720);
  context.fillStyle = 'rgba(255,255,255,0.9)';
  context.font = '700 44px system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillText(kind === 'video' ? 'Video' : 'Foto', 360, 380);
  return canvasToPreviewUrl(canvas);
}

async function imageBlobToPreviewUrl(blob: Blob) {
  const image = document.createElement('img');
  const objectUrl = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Bildvorschau konnte nicht erzeugt werden'));
      image.src = objectUrl;
    });
    const maxSize = 720;
    const ratio = Math.min(maxSize / image.naturalWidth, maxSize / image.naturalHeight, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas ist nicht verfügbar');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvasToPreviewUrl(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function videoBlobToPreviewUrl(fallbackUrl: string) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = fallbackUrl;

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Videovorschau Timeout')), 3000);
    video.onloadeddata = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Videovorschau konnte nicht erzeugt werden'));
    };
  });

  if (Number.isFinite(video.duration) && video.duration > 0.2) {
    video.currentTime = 0.1;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      window.setTimeout(resolve, 800);
    });
  }

  const width = video.videoWidth || 720;
  const height = video.videoHeight || 720;
  const maxSize = 720;
  const ratio = Math.min(maxSize / width, maxSize / height, 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas ist nicht verfügbar');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvasToPreviewUrl(canvas);
}

async function createLocalThumbnail(blob: Blob, kind: MediaKind, previewUrl: string) {
  try {
    if (kind === 'video') {
      return await videoBlobToPreviewUrl(previewUrl);
    }
    return await imageBlobToPreviewUrl(blob);
  } catch {
    return fallbackPreviewUrl(kind);
  }
}

export default function App() {
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInFlightRef = useRef(false);
  const pendingShotRef = useRef<ShotState | null>(null);

  const [name, setName] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [mode, setMode] = useState<Mode>(() => {
    try {
      const hasName = window.localStorage.getItem(STORAGE_NAME_KEY);
      const hasSkipped = window.localStorage.getItem(STORAGE_NAME_SKIPPED_KEY);
      return hasName || hasSkipped ? 'main' : 'intro';
    } catch {
      return 'intro';
    }
  });
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [frontendBuildVersion, setFrontendBuildVersion] = useState<string | null>(null);
  const [gallery, setGallery] = useState<GalleryResponse>({ total: 0, recent: [], albumUrl: null });
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Bereit');
  const [error, setError] = useState('');
  const [pendingShot, setPendingShot] = useState<ShotState | null>(null);
  const [captureKind, setCaptureKind] = useState<MediaKind>('photo');
  const [localUpload, setLocalUpload] = useState<UploadPreviewState | null>(null);
  const [autoUpload, setAutoUpload] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installHint, setInstallHint] = useState('');
  const [isInstalled, setIsInstalled] = useState(false);

  const recent = gallery.recent.slice(0, 3);
  const totalCount = gallery.total;
  const extraCount = Math.max(totalCount - 3, 0);
  const albumLink = gallery.albumUrl || '#';
  const displayName = name.trim() || 'Name';
  const buildStatus = getBuildStatus(frontendBuildVersion, status?.buildVersion ?? null);
  const hasBuildMismatch = buildStatus.hasMismatch;
  const buildBadgeLabel = buildStatus.label;
  const buildBadgeTitle = buildStatus.title;
  const handleRefreshAction = () => {
    if (hasBuildMismatch) {
      window.location.reload();
      return;
    }
    void refreshGallery({ clearLocalUpload: true });
  };
  const sendFrontendLog = sendFrontendLogEntry;

  const refreshGallery = async ({ clearLocalUpload = false } = {}) => {
    setGalleryLoading(true);
    if (clearLocalUpload) {
      setLocalUpload(null);
    }
    try {
      const data = await fetchGallery();
      setGallery(data);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Galerie konnte nicht geladen werden';
      sendFrontendLog({
        level: 'error',
        message: text,
        source: 'gallery',
        stack: cause instanceof Error ? cause.stack : undefined
      });
    } finally {
      setGalleryLoading(false);
    }
  };

  useEffect(() => {
    try {
      if (name.trim()) {
        window.localStorage.setItem(STORAGE_NAME_KEY, name.trim());
        window.localStorage.removeItem(STORAGE_NAME_SKIPPED_KEY);
      } else {
        window.localStorage.removeItem(STORAGE_NAME_KEY);
      }
    } catch {
      // Ignore storage failures on locked-down browsers.
    }
  }, [name]);

  useEffect(() => {
    let active = true;
    void fetchStatus()
      .then(([buildInfo, data]) => {
        if (!active) return;
        setFrontendBuildVersion(typeof buildInfo.version === 'string' ? buildInfo.version : null);
        setStatus(data);
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setFrontendBuildVersion(null);
        setStatus(null);
      });
    void refreshGallery().catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let retryId: number | undefined;
    let socket: WebSocket | null = null;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/api/live`);
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data));
          if (!isGalleryLiveMessage(payload)) {
            return;
          }
          setGallery(payload.gallery);
          setGalleryLoading(false);
          setLocalUpload((current) => current?.status === 'done' ? null : current);
        } catch (cause) {
          sendFrontendLog({
            level: 'warn',
            message: cause instanceof Error ? cause.message : 'Live-Galerie-Update konnte nicht gelesen werden',
            source: 'gallery.live'
          });
        }
      };
      socket.onclose = () => {
        if (closed) {
          return;
        }
        retryId = window.setTimeout(connect, 2000);
      };
      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryId !== undefined) {
        window.clearTimeout(retryId);
      }
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
    setIsInstalled(standalone);

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setInstallHint('');
    };
    const onAppInstalled = () => {
      setInstallPrompt(null);
      setInstallHint('App wurde hinzugefügt');
      setIsInstalled(true);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  useEffect(() => {
    pendingShotRef.current = pendingShot;
  }, [pendingShot]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!uploadInFlightRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (pendingShotRef.current?.previewUrl) {
        URL.revokeObjectURL(pendingShotRef.current.previewUrl);
      }
    };
  }, []);

  useFrontendLogging({ hasPendingPreview: () => !!pendingShotRef.current, sendLog: sendFrontendLog });

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

  const handleNativeCapture = async (event: React.ChangeEvent<HTMLInputElement>, intent: CaptureIntent) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      setMessage('Bereit');
      return;
    }

    try {
      if (pendingShot?.previewUrl) URL.revokeObjectURL(pendingShot.previewUrl);
      const previewUrl = URL.createObjectURL(file);
      const kind: MediaKind = intent === 'auto' ? file.type.startsWith('video/') ? 'video' : 'photo' : intent;
      const thumbnailUrl = await createLocalThumbnail(file, kind, previewUrl);
      const nextShot = { kind, blob: file, previewUrl, thumbnailUrl, capturedAt: new Date().toISOString() };
      setPendingShot(nextShot);
      sendFrontendLog({
        level: 'info',
        message: `Confirmation preview opened for ${kind}; file type=${file.type || 'unknown'}; size=${file.size}; autoUpload=${autoUpload}`,
        source: 'preview.open'
      });
      setMessage(kind === 'video' ? 'Video aufgenommen' : 'Foto aufgenommen');
      setError('');
      if (autoUpload) {
        void startUpload(nextShot, 'auto');
      }
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

  const startUpload = async (shot: ShotState, source: 'manual' | 'auto') => {
    if (uploadInFlightRef.current) return;
    const uploadId = `${shot.capturedAt}-${Math.random().toString(16).slice(2)}`;
    uploadInFlightRef.current = true;
    setBusy(true);
    setError('');
    setMessage(shot.kind === 'video' ? 'Video-Upload läuft' : 'Upload läuft');
    sendFrontendLog({
      level: 'info',
      message: `Upload ${source} for ${shot.kind}; blob type=${shot.blob.type || 'unknown'}; size=${shot.blob.size}`,
      source: source === 'auto' ? 'preview.autoupload' : 'preview.upload'
    });
    setLocalUpload({
      id: uploadId,
      kind: shot.kind,
      thumbnailUrl: shot.thumbnailUrl,
      progress: 0.02,
      status: 'uploading'
    });
    setPendingShot(null);
    try {
      const form = new FormData();
      const mimeType = shot.blob.type || (shot.kind === 'video' ? 'video/webm' : 'image/jpeg');
      form.append('name', name.trim());
      form.append('mimeType', mimeType);
      form.append('capturedAt', shot.capturedAt);
      form.append('photo', shot.blob, `guest-camera-${Date.now()}${extensionForMedia(shot.kind, mimeType)}`);

      const payload = await uploadCaptureRequest(form, (progress) => {
        setLocalUpload((current) => current?.id === uploadId ? { ...current, progress, status: 'uploading' } : current);
      });

      setMessage(payload.uploaded ? (shot.kind === 'video' ? 'Video hochgeladen' : 'Foto hochgeladen') : 'Lokal gespeichert');
      if (payload.warning) setError(payload.warning);
      setLocalUpload((current) => current?.id === uploadId ? { ...current, progress: 1, status: 'done' } : current);
      if (payload.uploaded) {
        setGallery((current) => ({ ...current, total: current.total + 1 }));
      }
      if (shot.previewUrl) URL.revokeObjectURL(shot.previewUrl);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Unbekannter Fehler';
      setError(text);
      setLocalUpload((current) => current?.id === uploadId ? { ...current, status: 'failed' } : current);
      sendFrontendLog({
        level: 'error',
        message: text,
        source: 'capture',
        stack: cause instanceof Error ? cause.stack : undefined
      });
      setMessage('Upload fehlgeschlagen');
    } finally {
      uploadInFlightRef.current = false;
      setBusy(false);
    }
  };

  const confirmUpload = async () => {
    if (!pendingShot) return;
    await startUpload(pendingShot, 'manual');
  };

  const discardShot = () => {
    sendFrontendLog({
      level: 'info',
      message: pendingShot ? `Confirmation preview discarded for ${pendingShot.kind}` : 'Confirmation preview discard without pending shot',
      source: 'preview.discard'
    });
    if (pendingShot?.previewUrl) URL.revokeObjectURL(pendingShot.previewUrl);
    setPendingShot(null);
    setMessage('Bereit');
    setError('');
  };

  const handleNameContinue = () => {
    try {
      if (name.trim()) {
        window.localStorage.setItem(STORAGE_NAME_KEY, name.trim());
        window.localStorage.removeItem(STORAGE_NAME_SKIPPED_KEY);
      } else {
        window.localStorage.removeItem(STORAGE_NAME_KEY);
        window.localStorage.setItem(STORAGE_NAME_SKIPPED_KEY, '1');
      }
    } catch {
      // Ignore storage failures on locked-down browsers.
    }
    setMode('main');
  };

  const handleInstallShortcut = async () => {
    if (installPrompt) {
      const prompt = installPrompt;
      setInstallPrompt(null);
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setInstallHint(choice.outcome === 'accepted' ? 'App wurde hinzugefügt' : '');
      return;
    }

    setInstallHint('iPhone: Teilen öffnen und "Zum Home-Bildschirm" wählen');
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
            <button className="button secondary" type="button" onClick={handleNameContinue}>
              Überspringen
            </button>
            <button className="button primary" type="button" onClick={handleNameContinue}>
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
          <div className="welcome-title">
            <h1>
              Willkommen beim Frühlingsfest -{' '}
              <button className="name-link" type="button" onClick={() => setMode('intro')}>
                {displayName}
              </button>
            </h1>
          </div>
          <div className="title-actions">
            <div className="status-controls">
              <div className="refresh-stack">
                <button
                  className={`icon-button ${hasBuildMismatch ? 'is-super-refresh' : ''}`}
                  type="button"
                  onClick={handleRefreshAction}
                  disabled={!hasBuildMismatch && (galleryLoading || busy)}
                  aria-label={hasBuildMismatch ? 'Neue Version laden' : 'Vorschau aktualisieren'}
                  title={hasBuildMismatch ? 'Neue Version laden' : 'Vorschau aktualisieren'}
                >
                  <RefreshCw size={19} />
                </button>
                <span
                  className={`build-version ${hasBuildMismatch ? 'is-warning' : ''}`}
                  title={buildBadgeTitle}
                  aria-label={hasBuildMismatch ? 'Frontend und Backend Build-Version unterscheiden sich' : `Build ${buildBadgeLabel}`}
                >
                  {buildBadgeLabel}
                </span>
              </div>
              <div className="pill">{message}</div>
              <label className="auto-upload-toggle">
                <input
                  type="checkbox"
                  checked={autoUpload}
                  onChange={(event) => setAutoUpload(event.target.checked)}
                />
                <span className="auto-upload-box" aria-hidden="true" />
                <span>Automatisch hochladen</span>
              </label>
            </div>
          </div>
        </div>

        <GalleryStrip
          albumLink={albumLink}
          extraCount={extraCount}
          galleryLoading={galleryLoading}
          localUpload={localUpload}
          recent={recent}
          totalCount={totalCount}
        />

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
          onChange={(event) => void handleNativeCapture(event, 'photo')}
          aria-hidden="true"
          tabIndex={-1}
        />

        <input
          ref={videoInputRef}
          className="hidden-input"
          type="file"
          accept="video/*"
          capture
          onChange={(event) => void handleNativeCapture(event, 'video')}
          aria-hidden="true"
          tabIndex={-1}
        />

        <input
          ref={libraryInputRef}
          className="hidden-input"
          type="file"
          accept="image/*,video/*"
          onChange={(event) => void handleNativeCapture(event, 'auto')}
          aria-hidden="true"
          tabIndex={-1}
        />

        {pendingShot ? <ConfirmationPreview busy={busy} onConfirm={confirmUpload} onDiscard={discardShot} shot={pendingShot} /> : null}

        {error ? <p className="error">{error}</p> : null}

        {!isInstalled ? (
          <footer className="install-footer">
            <button className="install-button" type="button" onClick={handleInstallShortcut}>
              <span className="install-icon" aria-hidden="true">
                <Smartphone size={20} />
                <Plus size={13} />
              </span>
              <span>Zum Startbildschirm hinzufügen</span>
            </button>
            {installHint ? <p className="install-hint" role="status">{installHint}</p> : null}
          </footer>
        ) : null}
      </section>
    </main>
  );
}
