import { ColeebriMark } from './ColeebriLogo';
import type { Publication } from '../types/publication';

export interface ReaderLoadingViewProps {
  publication: Pick<Publication, 'title' | 'authors' | 'publisher' | 'collection' | 'year'>;
  stage: 'chunk' | 'pdf';
  progressPct?: number | null;
  loadedBytes?: number;
  totalBytes?: number;
  onCancel?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Artisanal reading-room loading stage shared between the Suspense bundle boundary
 * and the PDF download/parse stage so opening any book feels seamless from the first tap.
 */
export function ReaderLoadingView({
  publication,
  stage,
  progressPct = null,
  loadedBytes = 0,
  totalBytes,
  onCancel
}: ReaderLoadingViewProps) {
  const pct = progressPct !== null ? Math.max(0, Math.min(100, progressPct)) : null;

  let statusLabel = 'Conectando con el repositorio…';
  if (stage === 'chunk') {
    statusLabel = 'Preparando sala de lectura…';
  } else if (pct !== null && pct >= 98) {
    statusLabel = 'Maquetando las primeras páginas…';
  } else if (pct !== null || loadedBytes > 0) {
    statusLabel = 'Descargando documento…';
  }

  let telemetry = 'Esto puede tardar unos segundos según el servidor de origen.';
  if (pct !== null && totalBytes && totalBytes > 0) {
    telemetry = `${pct}% · ${formatBytes(loadedBytes)} de ${formatBytes(totalBytes)}`;
  } else if (pct !== null) {
    telemetry = `${pct}% descargado`;
  } else if (loadedBytes > 0) {
    telemetry = `${formatBytes(loadedBytes)} recibidos…`;
  }

  const authorOrPublisher = publication.authors[0] || publication.publisher || 'Acceso abierto';
  const eyebrow = publication.collection
    ? `${publication.collection}${publication.year ? ` · ${publication.year}` : ''}`
    : publication.year
      ? `Edición ${publication.year}`
      : 'Sala de lectura';

  return (
    <div className="rd-loader-card" role="status" aria-live="polite">
      <div className="rd-loader-scene" aria-hidden="true">
        <div className="rd-loader-halo" />
        <ColeebriMark size={46} className="rd-loader-mark" />
        <div className="rd-loader-folio">
          <div className="rd-loader-page rd-loader-page--left">
            <span className="rd-loader-ink rd-loader-ink--a" />
            <span className="rd-loader-ink rd-loader-ink--b" />
            <span className="rd-loader-ink rd-loader-ink--c" />
          </div>
          <div className="rd-loader-spine" />
          <div className="rd-loader-page rd-loader-page--right">
            <span className="rd-loader-ink rd-loader-ink--b" />
            <span className="rd-loader-ink rd-loader-ink--a" />
            <span className="rd-loader-ink rd-loader-ink--d" />
          </div>
          <div className="rd-loader-leaf" />
          <span className="rd-loader-ribbon" />
        </div>
      </div>

      <p className="rd-loader-eyebrow">{eyebrow}</p>
      <h3 className="rd-loader-title">{publication.title}</h3>
      <p className="rd-loader-author">{authorOrPublisher}</p>

      <div className="rd-loader-progress-wrap">
        <div className="rd-loader-status-row">
          <span className="rd-loader-status">{statusLabel}</span>
          {pct !== null && <span className="rd-loader-pct">{pct}%</span>}
        </div>
        <div className="rd-loader-track" aria-hidden="true">
          {pct !== null ? (
            <span className="rd-loader-bar" style={{ width: `${pct}%` }} />
          ) : (
            <span className="rd-loader-bar rd-loader-bar--indeterminate" />
          )}
        </div>
        <p className="rd-loader-telemetry">{telemetry}</p>
      </div>

      {onCancel && (
        <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={onCancel}>
          Cancelar
        </button>
      )}
    </div>
  );
}
