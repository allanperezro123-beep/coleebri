import { useEffect, useState } from 'react';
import { WifiOff, X } from 'lucide-react';

/** Small dismissible notice shown while the browser reports no connection. */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      setDismissed(false);
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  if (online || dismissed) return null;

  return (
    <div className="toast" role="status" data-offline-banner>
      <WifiOff className="h-4 w-4 shrink-0" style={{ color: 'var(--accent-ochre)' }} aria-hidden="true" />
      <span>Sin conexión — mostrando lo guardado</span>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        onClick={() => setDismissed(true)}
        aria-label="Cerrar aviso de conexión"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
