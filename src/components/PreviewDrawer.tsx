import { useEffect, useId, useRef, useState } from 'react';
import { Bookmark, BookOpen, Check, Copy, ExternalLink, Quote, StickyNote, Tag } from 'lucide-react';
import { doiUrl, formatCitation } from '../lib/citations';
import {
  DOCTYPE_LABELS,
  LANGUAGE_LABELS,
  areaFillColor,
  areaTextColor,
  getArea,
  langAttr
} from '../lib/publication';
import { safeExternalUrl, safeHexColor } from '../lib/safeUrl';
import { sourceInfo } from '../lib/sources';
import type { CitationFormat, Publication, Shelf, ShelfItem } from '../types/publication';
import { Modal } from './Modal';
import { BookCover } from './BookCover';

interface PreviewDrawerProps {
  /** The parent mounts the drawer with `key={publication.id}`, so all local state resets per work. */
  publication: Publication;
  shelves: Shelf[];
  publicationShelfItems: ShelfItem[];
  resumePage?: number;
  onClose: () => void;
  onOpenReader: (pub: Publication, initialPage?: number) => void;
  onToggleShelf: (shelfId: string, pub: Publication) => void;
  onSaveNote: (shelfId: string, pub: Publication, note: string) => void;
  onKeywordClick: (kw: string) => void;
}

const CITATION_TABS: Array<{ id: CitationFormat; label: string }> = [
  { id: 'apa7', label: 'APA 7' },
  { id: 'ieee', label: 'IEEE' },
  { id: 'bibtex', label: 'BibTeX' }
];

type CopyState = 'idle' | 'ok' | 'error';

/** 12-13 rem wide: always the 640 px WebP on dense screens, the 320 px one on 1x. */
const DRAWER_COVER_SIZES = '(min-width: 640px) 13rem, 12rem';

export function PreviewDrawer({
  publication,
  shelves,
  publicationShelfItems,
  resumePage,
  onClose,
  onOpenReader,
  onToggleShelf,
  onSaveNote,
  onKeywordClick
}: PreviewDrawerProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [citationFormat, setCitationFormat] = useState<CitationFormat>('apa7');
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [activeShelfId, setActiveShelfId] = useState<string>(
    () => publicationShelfItems[0]?.shelfId || shelves[0]?.id || 'favorites'
  );
  // The draft is initialised once and only replaced by explicit user actions (B9): later
  // re-renders caused by unrelated shelf/progress updates never touch what the visitor typed.
  const [noteDraft, setNoteDraft] = useState<string>(
    () => publicationShelfItems.find((i) => i.shelfId === (publicationShelfItems[0]?.shelfId || shelves[0]?.id))?.note ?? ''
  );
  const [noteSaved, setNoteSaved] = useState(false);

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);

  useEffect(() => {
    if (!noteSaved) return;
    const timer = setTimeout(() => setNoteSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [noteSaved]);

  const area = getArea(publication.oecdArea);
  const memberShelfIds = new Set(publicationShelfItems.map((i) => i.shelfId));
  const noteFor = (shelfId: string) => publicationShelfItems.find((i) => i.shelfId === shelfId)?.note ?? '';
  const citationText = formatCitation(publication, citationFormat);
  const lang = langAttr(publication);
  const hasText = Boolean(publication.pdfUrl);
  const source = sourceInfo(publication.collectionCode, publication.collection);
  const scieloHref = safeExternalUrl(publication.scieloUrl);
  const doiHref = safeExternalUrl(doiUrl(publication.doi));
  const activeTab = CITATION_TABS.findIndex((t) => t.id === citationFormat);

  const handleCopyCitation = async () => {
    try {
      await navigator.clipboard.writeText(citationText);
      setCopyState('ok');
    } catch {
      setCopyState('error');
    }
  };

  const handleTabKey = (event: React.KeyboardEvent, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % CITATION_TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + CITATION_TABS.length) % CITATION_TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = CITATION_TABS.length - 1;
    else return;
    event.preventDefault();
    setCitationFormat(CITATION_TABS[next].id);
    setCopyState('idle');
    tabRefs.current[next]?.focus();
  };

  const handleToggleShelf = (shelf: Shelf, inShelf: boolean) => {
    onToggleShelf(shelf.id, publication);
    if (!inShelf) {
      setActiveShelfId(shelf.id);
      setNoteDraft('');
    } else if (activeShelfId === shelf.id) {
      setNoteDraft('');
    }
  };

  return (
    <Modal variant="side" labelledBy={titleId} onClose={onClose}>
      <div
        className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5 sm:px-5"
        style={{
          borderColor: 'var(--border-hairline)',
          backgroundColor: 'var(--bg-surface)',
          paddingTop: 'max(0.625rem, env(safe-area-inset-top))'
        }}
      >
        <p className="micro flex min-w-0 items-center gap-2" style={{ color: areaTextColor(area.id) }}>
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: areaFillColor(area.id) }}
            aria-hidden="true"
          />
          <span className="truncate">{area.label}</span>
        </p>
        <button type="button" onClick={onClose} className="btn btn-quiet btn-sm">
          Cerrar
        </button>
      </div>

      <div className="modal-body p-4 sm:p-6">
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
          <div className="cover-slot w-48 shrink-0 sm:w-52">
            <BookCover
              publication={publication}
              variant="drawer"
              sizes={DRAWER_COVER_SIZES}
              priority
              labelled
              className="drawer-cover"
            />
          </div>

          <div className="min-w-0 flex-1 self-stretch">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {[
                DOCTYPE_LABELS[publication.docType],
                publication.country,
                LANGUAGE_LABELS[publication.language],
                publication.year
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>

            <h2
              id={titleId}
              lang={lang}
              className="font-editorial mt-1 text-balance text-2xl font-semibold leading-tight sm:text-[1.75rem]"
            >
              {publication.title}
            </h2>

            <p className="mt-2 text-[0.9375rem] font-medium" style={{ color: 'var(--text-secondary)' }}>
              {publication.authors.length > 0 ? publication.authors.join(' · ') : publication.publisher}
            </p>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              Editorial: <span style={{ color: 'var(--text-secondary)' }}>{publication.publisher}</span>
              {publication.citedByCount ? ` · ${publication.citedByCount} citas` : ''}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span
                className="inline-flex min-h-7 items-center rounded border px-2 text-xs font-semibold"
                style={{ borderColor: 'var(--border-strong)', backgroundColor: 'var(--bg-surface)' }}
                title={source.description || undefined}
              >
                {source.label}
              </span>
              <span
                className="inline-flex min-h-7 items-center gap-1 text-xs font-semibold"
                style={{ color: hasText ? 'var(--accent-jade)' : 'var(--text-muted)' }}
              >
                {hasText ? <BookOpen className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                {hasText ? 'Texto completo' : 'Solo ficha'}
              </span>
            </div>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {hasText ? (
                <button
                  type="button"
                  onClick={() => onOpenReader(publication, resumePage)}
                  className="btn btn-primary btn-lg"
                >
                  <BookOpen className="h-5 w-5" aria-hidden="true" />
                  <span>{resumePage && resumePage > 1 ? `Continuar en la página ${resumePage}` : 'Leer ahora'}</span>
                </button>
              ) : null}
              {scieloHref ? (
                <a
                  href={scieloHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`btn btn-lg ${hasText ? 'btn-quiet' : 'btn-primary'}`}
                >
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  <span>Ver en {source.short}</span>
                </a>
              ) : null}
            </div>
            {!hasText ? (
              <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
                Esta obra no tiene texto completo disponible para leer aquí. Puedes consultarla en el sitio de origen.
              </p>
            ) : null}

            {(doiHref && publication.doi) || publication.isbn ? (
              <div className="font-code mt-4 flex flex-wrap gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                {doiHref && publication.doi ? (
                  <a
                    href={doiHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded border px-2 py-1 hover:underline"
                    style={{ borderColor: 'var(--border-hairline)', backgroundColor: 'var(--bg-surface)' }}
                  >
                    DOI: {publication.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')}
                  </a>
                ) : null}
                {publication.isbn ? (
                  <span
                    className="rounded border px-2 py-1"
                    style={{ borderColor: 'var(--border-hairline)', backgroundColor: 'var(--bg-surface)' }}
                  >
                    ISBN: {publication.isbn}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <section className="mt-6 border-t pt-5" style={{ borderColor: 'var(--border-hairline)' }}>
          <h3 className="micro mb-2">Resumen</h3>
          <p
            lang={lang}
            className="max-w-[65ch] text-[15px] leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}
          >
            {publication.abstract || 'Esta obra no incluye resumen. Consulta la ficha original para ver el índice completo.'}
          </p>
        </section>

        {publication.keywords.length > 0 ? (
          <section className="mt-5">
            <h3 className="micro mb-2 flex items-center gap-1.5">
              <Tag className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Palabras clave</span>
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {publication.keywords.map((kw) => (
                <button
                  key={kw}
                  type="button"
                  className="chip"
                  onClick={() => {
                    onKeywordClick(kw);
                    onClose();
                  }}
                >
                  {kw}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section
          className="mt-6 rounded-md border p-4"
          style={{ borderColor: 'var(--border-hairline)', backgroundColor: 'var(--bg-surface)' }}
          aria-labelledby={`${uid}-cite`}
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 id={`${uid}-cite`} className="micro flex items-center gap-1.5">
              <Quote className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
              <span>Citar esta obra</span>
            </h3>

            <div role="tablist" aria-label="Formato de cita" className="flex items-center gap-1">
              {CITATION_TABS.map((tab, index) => {
                const active = citationFormat === tab.id;
                return (
                  <button
                    key={tab.id}
                    ref={(el) => {
                      tabRefs.current[index] = el;
                    }}
                    type="button"
                    role="tab"
                    id={`${uid}-tab-${tab.id}`}
                    aria-selected={active}
                    aria-controls={`${uid}-panel`}
                    tabIndex={active ? 0 : -1}
                    onClick={() => {
                      setCitationFormat(tab.id);
                      setCopyState('idle');
                    }}
                    onKeyDown={(event) => handleTabKey(event, index)}
                    className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div
            role="tabpanel"
            id={`${uid}-panel`}
            aria-labelledby={`${uid}-tab-${CITATION_TABS[activeTab]?.id ?? 'apa7'}`}
            tabIndex={0}
          >
            <pre
              lang={citationFormat === 'bibtex' ? undefined : lang}
              className={`overflow-x-auto rounded border p-3 text-xs leading-relaxed whitespace-pre-wrap ${
                citationFormat === 'bibtex' ? 'font-code' : 'font-sans'
              }`}
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-card)',
                color: 'var(--text-primary)'
              }}
            >
              {citationText}
            </pre>
          </div>

          <div className="mt-3 flex items-center justify-end gap-3">
            <p role="status" className="text-xs" style={{ color: copyState === 'error' ? 'var(--danger)' : 'var(--accent-moss)' }}>
              {copyState === 'ok' ? 'Cita copiada' : copyState === 'error' ? 'No se pudo copiar. Selecciona el texto a mano.' : ''}
            </p>
            <button type="button" onClick={handleCopyCitation} className="btn btn-quiet btn-sm">
              {copyState === 'ok' ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              <span>Copiar cita</span>
            </button>
          </div>
        </section>

        <section
          className="mt-5 rounded-md border p-4"
          style={{ borderColor: 'var(--border-hairline)', backgroundColor: 'var(--bg-surface)' }}
          aria-labelledby={`${uid}-shelves`}
        >
          <h3 id={`${uid}-shelves`} className="micro mb-3 flex items-center gap-1.5">
            <Bookmark className="h-3.5 w-3.5" style={{ color: 'var(--accent-ochre)' }} aria-hidden="true" />
            <span>Estanterías y notas</span>
          </h3>

          <div className="mb-3 flex flex-wrap gap-1.5">
            {shelves.map((shelf) => {
              const inShelf = memberShelfIds.has(shelf.id);
              return (
                <button
                  key={shelf.id}
                  type="button"
                  className="chip"
                  aria-pressed={inShelf}
                  onClick={() => handleToggleShelf(shelf, inShelf)}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: safeHexColor(shelf.accent) }}
                    aria-hidden="true"
                  />
                  <span>{shelf.name}</span>
                  {inShelf ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={`${uid}-note`} className="flex items-center gap-1 text-sm font-medium">
              <StickyNote className="h-4 w-4" style={{ color: 'var(--accent-ochre)' }} aria-hidden="true" />
              Nota en
            </label>
            <select
              aria-label="Estantería de la nota"
              value={activeShelfId}
              onChange={(e) => {
                setActiveShelfId(e.target.value);
                setNoteDraft(noteFor(e.target.value));
              }}
              className="field min-w-0 flex-1 sm:flex-none"
            >
              {shelves.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <textarea
            id={`${uid}-note`}
            rows={3}
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="Escribe citas clave, capítulos útiles o ideas para tu investigación"
            className="field mt-2"
          />
          <div className="mt-2 flex items-center justify-end gap-3">
            <p role="status" className="text-xs" style={{ color: 'var(--accent-moss)' }}>
              {noteSaved ? 'Nota guardada' : ''}
            </p>
            <button
              type="button"
              onClick={() => {
                onSaveNote(activeShelfId, publication, noteDraft);
                setNoteSaved(true);
              }}
              className="btn btn-quiet btn-sm"
            >
              <StickyNote className="h-4 w-4" aria-hidden="true" />
              <span>Guardar nota</span>
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
