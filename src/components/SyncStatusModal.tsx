import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { CheckCircle2, Database, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { readString, writeString } from '../lib/storage';
import { Modal, ModalHeader } from './Modal';

interface SyncStatusModalProps {
  onClose: () => void;
  onSyncCompleted: () => void;
  /** Number of works in the catalogue and how many can be read in the app. */
  catalogSize: number;
  withPdf: number;
  /** 'server' = live database; 'seed' = bundled starter catalogue. */
  source: 'server' | 'seed' | 'pending';
}

interface SyncLog {
  id: number;
  source: string;
  records_synced: number;
  status: string;
  synced_at: string;
}

const ADMIN_TOKEN_KEY = 'coleebri:admin-token';

const SOURCE_LABELS: Record<string, string> = {
  opds: 'SciELO Libros (novedades)',
  'books-oai': 'SciELO Libros (catálogo completo)',
  'scielo-mx': 'SciELO México',
  'scielo-pe': 'SciELO Perú'
};

const SYNC_TARGETS = ['opds', 'books-oai', 'scielo-mx', 'scielo-pe'] as const;

function isLog(value: unknown): value is SyncLog {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'number' &&
    typeof v.source === 'string' &&
    typeof v.records_synced === 'number' &&
    typeof v.status === 'string' &&
    typeof v.synced_at === 'string'
  );
}

function formatDate(value: string): string {
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(parsed)) return 'fecha desconocida';
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

export function SyncStatusModal({ onClose, onSyncCompleted, catalogSize, withPdf, source }: SyncStatusModalProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [d1Connected, setD1Connected] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [statusUnavailable, setStatusUnavailable] = useState(false);

  const [token, setToken] = useState(() => readString(ADMIN_TOKEN_KEY, 'session') ?? '');
  const [syncingTarget, setSyncingTarget] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/scielo-sync', { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data: unknown = await res.json();
      if (typeof data !== 'object' || data === null) throw new Error('bad response');
      const record = data as Record<string, unknown>;
      setLogs(Array.isArray(record.logs) ? record.logs.filter(isLog) : []);
      setD1Connected(record.d1Connected === true);
      setStatusUnavailable(false);
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setStatusUnavailable(true);
    } finally {
      if (!signal?.aborted) setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus]);

  // last successful run of each source
  const lastBySource = useMemo(() => {
    const map = new Map<string, SyncLog>();
    for (const log of logs) {
      const current = map.get(log.source);
      if (!current || log.id > current.id) map.set(log.source, log);
    }
    return [...map.values()].sort((a, b) => b.id - a.id);
  }, [logs]);

  const lastOk = logs.find((l) => l.status === 'ok');

  const updateToken = (value: string) => {
    setToken(value);
    writeString(ADMIN_TOKEN_KEY, value.trim() ? value.trim() : null, 'session');
  };

  const runSync = async (target: (typeof SYNC_TARGETS)[number]) => {
    const bearer = token.trim();
    if (!bearer) {
      setFeedback({ tone: 'error', text: 'Escribe primero el token de administración.' });
      return;
    }
    setSyncingTarget(target);
    setFeedback(null);
    try {
      const res = await fetch('/api/scielo-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
        body: JSON.stringify({ target })
      });
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = await res.json();
        if (typeof parsed === 'object' && parsed !== null) data = parsed as Record<string, unknown>;
      } catch {
        // body was not JSON
      }
      if (res.ok && data.ok === true) {
        const synced = typeof data.synced === 'number' ? data.synced : 0;
        setFeedback({ tone: 'ok', text: `Se actualizaron ${synced} registros desde ${SOURCE_LABELS[target]}.` });
        onSyncCompleted();
        void loadStatus();
      } else if (res.status === 401 || res.status === 403) {
        setFeedback({ tone: 'error', text: 'El token no es válido o no tiene permisos de administración.' });
      } else if (res.status === 429) {
        setFeedback({ tone: 'error', text: 'Hay que esperar un poco antes de volver a sincronizar.' });
      } else {
        setFeedback({ tone: 'error', text: `No se pudo actualizar ${SOURCE_LABELS[target]}. Inténtalo más tarde.` });
      }
    } catch {
      setFeedback({ tone: 'error', text: 'No hay conexión con el servidor. Inténtalo de nuevo.' });
    } finally {
      setSyncingTarget(null);
    }
  };

  return (
    <Modal variant="center" size="sm" labelledBy={titleId} onClose={onClose}>
      <ModalHeader
        titleId={titleId}
        title="Estado del catálogo"
        icon={<Database className="h-5 w-5 shrink-0" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />}
        onClose={onClose}
        closeLabel="Cerrar estado del catálogo"
      />

      <div className="modal-body space-y-5 p-4 text-sm sm:p-5">
        <dl className="grid grid-cols-2 gap-3">
          <div className="rounded border p-3" style={{ borderColor: 'var(--border-hairline)', backgroundColor: 'var(--bg-surface)' }}>
            <dt className="micro">Obras en el catálogo</dt>
            <dd className="font-code mt-1 text-xl font-semibold">{source === 'pending' ? '…' : catalogSize}</dd>
          </div>
          <div className="rounded border p-3" style={{ borderColor: 'var(--border-hairline)', backgroundColor: 'var(--bg-surface)' }}>
            <dt className="micro">Con texto completo</dt>
            <dd className="font-code mt-1 text-xl font-semibold">{source === 'pending' ? '…' : withPdf}</dd>
          </div>
        </dl>

        {source === 'seed' ? (
          <p className="callout" data-tone="warn">
            Estás viendo un catálogo de muestra guardado en la aplicación. La colección completa se carga cuando hay
            conexión con el servidor.
          </p>
        ) : null}

        <section aria-labelledby={`${uid}-updates`}>
          <h3 id={`${uid}-updates`} className="micro mb-2">
            Últimas actualizaciones
          </h3>
          {loadingStatus ? (
            <p style={{ color: 'var(--text-muted)' }} role="status">
              Consultando el estado…
            </p>
          ) : statusUnavailable ? (
            <p style={{ color: 'var(--text-muted)' }}>El historial de actualizaciones no está disponible ahora.</p>
          ) : lastBySource.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>Todavía no hay actualizaciones registradas.</p>
          ) : (
            <>
              {lastOk ? (
                <p className="mb-2" style={{ color: 'var(--text-secondary)' }}>
                  Última actualización correcta: <strong>{formatDate(lastOk.synced_at)}</strong>
                  {d1Connected ? '' : ' (base de datos no conectada)'}
                </p>
              ) : null}
              <ul className="space-y-1.5">
                {lastBySource.map((log) => (
                  <li
                    key={log.id}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded border px-3 py-2"
                    style={{ borderColor: 'var(--border-hairline)', backgroundColor: 'var(--bg-card)' }}
                  >
                    <span className="font-medium">{SOURCE_LABELS[log.source] ?? log.source}</span>
                    <span className="text-xs" style={{ color: log.status === 'ok' ? 'var(--text-secondary)' : 'var(--danger)' }}>
                      {formatDate(log.synced_at)} ·{' '}
                      {log.status === 'ok' ? `${log.records_synced} registros` : 'no se completó'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <details className="rounded border" style={{ borderColor: 'var(--border-hairline)' }}>
          <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">Administración</summary>
          <div className="space-y-3 border-t p-3" style={{ borderColor: 'var(--border-hairline)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Solo para quien administra el sitio. El token se guarda únicamente en esta pestaña y se borra al
              cerrarla.
            </p>
            <div>
              <label htmlFor={`${uid}-token`} className="mb-1 block text-xs font-medium">
                Token de administración
              </label>
              <input
                id={`${uid}-token`}
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => updateToken(e.target.value)}
                className="field font-code"
              />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {SYNC_TARGETS.map((target) => (
                <button
                  key={target}
                  type="button"
                  disabled={syncingTarget !== null}
                  onClick={() => void runSync(target)}
                  className="btn btn-quiet btn-sm justify-between"
                >
                  <span>{SOURCE_LABELS[target]}</span>
                  {syncingTarget === target ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
            {token ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => updateToken('')}>
                Olvidar token
              </button>
            ) : null}
            {feedback ? (
              <div
                className="callout"
                data-tone={feedback.tone}
                role={feedback.tone === 'error' ? 'alert' : 'status'}
              >
                {feedback.tone === 'ok' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--accent-moss)' }} aria-hidden="true" />
                ) : (
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--danger)' }} aria-hidden="true" />
                )}
                <span>{feedback.text}</span>
              </div>
            ) : null}
          </div>
        </details>
      </div>
    </Modal>
  );
}
