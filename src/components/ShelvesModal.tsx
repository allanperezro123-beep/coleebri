import { useId, useMemo, useState } from 'react';
import { Bookmark, BookOpen, Download, Eye, Plus, StickyNote, Trash2 } from 'lucide-react';
import { DEFAULT_SHELF_IDS } from '../hooks/useShelves';
import { formatBibtexCollection } from '../lib/citations';
import { langAttr } from '../lib/publication';
import { safeHexColor } from '../lib/safeUrl';
import type { Publication, Shelf, ShelfItem } from '../types/publication';
import { Modal, ModalHeader } from './Modal';

interface ShelvesModalProps {
  onClose: () => void;
  shelves: Shelf[];
  shelfItems: ShelfItem[];
  syncedWithD1: boolean;
  notice: string | null;
  onCreateShelf: (name: string, description?: string, accent?: string) => void;
  onDeleteShelf: (shelfId: string) => void;
  onRemoveItem: (shelfId: string, pub: Publication) => void;
  onSelectPublication: (pub: Publication) => void;
  onOpenReader: (pub: Publication, page?: number) => void;
  onUpdateNote: (shelfId: string, pub: Publication, note: string) => void;
}

const SHELF_ACCENTS = [
  { value: '#1758C4', name: 'Cobalto' },
  { value: '#B8863B', name: 'Ocre' },
  { value: '#3F6A58', name: 'Musgo' },
  { value: '#46545B', name: 'Pizarra' },
  { value: '#7D4E57', name: 'Ciruela' }
];

export function ShelvesModal({
  onClose,
  shelves,
  shelfItems,
  syncedWithD1,
  notice,
  onCreateShelf,
  onDeleteShelf,
  onRemoveItem,
  onSelectPublication,
  onOpenReader,
  onUpdateNote
}: ShelvesModalProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const [selectedShelfId, setSelectedShelfId] = useState<string>(shelves[0]?.id || 'favorites');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newAccent, setNewAccent] = useState(SHELF_ACCENTS[0].value);
  const [showCreator, setShowCreator] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const activeShelf = shelves.find((s) => s.id === selectedShelfId) || shelves[0];

  const itemsInShelf = useMemo(
    () => shelfItems.filter((i) => i.shelfId === activeShelf?.id),
    [shelfItems, activeShelf?.id]
  );

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    onCreateShelf(newName, newDesc, newAccent);
    setNewName('');
    setNewDesc('');
    setShowCreator(false);
  };

  const handleExportBibtex = () => {
    if (itemsInShelf.length === 0) return;
    const bib = formatBibtexCollection(itemsInShelf.map((i) => i.publication));
    const blob = new Blob([bib], { type: 'application/x-bibtex;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeShelf?.id || 'coleebri'}.bib`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="shelves-dialog">
      <ModalHeader
        titleId={titleId}
        title="Mis estanterías"
        subtitle={
          syncedWithD1
            ? 'Guardadas en este dispositivo y respaldadas en línea'
            : 'Guardadas solo en este dispositivo'
        }
        icon={<Bookmark className="h-5 w-5 shrink-0" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />}
        onClose={onClose}
        closeLabel="Cerrar estanterías"
      />

      {notice ? (
        <div className="callout m-3" data-tone="warn" role="status">
          {notice}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Estanterías"
          className="shelves-nav w-full shrink-0 overflow-y-auto overscroll-contain border-b p-3 md:w-64 md:border-b-0 md:border-r md:p-4"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="micro">Colecciones</span>
            <button
              type="button"
              onClick={() => setShowCreator((v) => !v)}
              className="btn btn-quiet btn-sm"
              aria-expanded={showCreator}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>Nueva</span>
            </button>
          </div>

          {showCreator ? (
            <form
              onSubmit={handleCreate}
              className="mb-3 rounded border p-2.5"
              style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-hairline)' }}
            >
              <label htmlFor={`${uid}-name`} className="mb-1 block text-xs font-medium">
                Nombre
              </label>
              <input
                id={`${uid}-name`}
                type="text"
                value={newName}
                maxLength={80}
                onChange={(e) => setNewName(e.target.value)}
                className="field mb-2"
                required
              />
              <label htmlFor={`${uid}-desc`} className="mb-1 block text-xs font-medium">
                Descripción (opcional)
              </label>
              <input
                id={`${uid}-desc`}
                type="text"
                value={newDesc}
                maxLength={240}
                onChange={(e) => setNewDesc(e.target.value)}
                className="field mb-2"
              />
              <fieldset className="mb-3">
                <legend className="mb-1 text-xs font-medium">Color</legend>
                <div className="flex items-center gap-1.5">
                  {SHELF_ACCENTS.map((c) => (
                    <label key={c.value} className="relative inline-flex h-11 w-9 cursor-pointer items-center justify-center">
                      <input
                        type="radio"
                        name={`${uid}-accent`}
                        value={c.value}
                        checked={newAccent === c.value}
                        onChange={() => setNewAccent(c.value)}
                        className="peer sr-only"
                      />
                      <span className="sr-only">{c.name}</span>
                      <span
                        className="h-6 w-6 rounded-full border-2 peer-checked:ring-2 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2"
                        style={{
                          backgroundColor: c.value,
                          borderColor: newAccent === c.value ? 'var(--bg-page)' : 'transparent',
                          boxShadow: newAccent === c.value ? `0 0 0 2px ${c.value}` : undefined
                        }}
                        aria-hidden="true"
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
              <button type="submit" className="btn btn-primary btn-sm w-full">
                Crear estantería
              </button>
            </form>
          ) : null}

          <ul className="flex flex-col gap-1.5">
            {shelves.map((shelf) => {
              const count = shelfItems.filter((i) => i.shelfId === shelf.id).length;
              const active = shelf.id === activeShelf?.id;
              const deletable = !DEFAULT_SHELF_IDS.includes(shelf.id);
              const confirming = confirmDeleteId === shelf.id;
              return (
                <li
                  key={shelf.id}
                  className="rounded border"
                  style={{
                    borderColor: active ? safeHexColor(shelf.accent) : 'var(--border-hairline)',
                    backgroundColor: active ? 'var(--bg-card)' : 'transparent'
                  }}
                >
                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={() => setSelectedShelfId(shelf.id)}
                      aria-current={active ? 'true' : undefined}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2.5 text-left"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: safeHexColor(shelf.accent) }}
                        aria-hidden="true"
                      />
                      <span className="truncate text-sm font-semibold">{shelf.name}</span>
                      <span className="font-code ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
                        {count}
                      </span>
                    </button>
                    {deletable ? (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(confirming ? null : shelf.id)}
                        className="btn btn-ghost btn-icon btn-sm"
                        aria-label={`Eliminar la estantería ${shelf.name}`}
                        aria-expanded={confirming}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                  {confirming ? (
                    <div className="flex flex-wrap items-center gap-2 border-t px-2.5 py-2" style={{ borderColor: 'var(--border-hairline)' }}>
                      <span className="text-xs">¿Eliminar con sus {count} obras?</span>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => {
                          onDeleteShelf(shelf.id);
                          setConfirmDeleteId(null);
                        }}
                      >
                        Eliminar
                      </button>
                      <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirmDeleteId(null)}>
                        Cancelar
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="modal-body flex min-h-0 flex-1 flex-col p-4 sm:p-5">
          {activeShelf ? (
            <div
              className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b pb-3"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <div className="min-w-0">
                <h3 className="font-editorial text-lg font-semibold">{activeShelf.name}</h3>
                {activeShelf.description ? (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {activeShelf.description}
                  </p>
                ) : null}
              </div>
              {itemsInShelf.length > 0 ? (
                <button type="button" onClick={handleExportBibtex} className="btn btn-quiet btn-sm">
                  <Download className="h-4 w-4" aria-hidden="true" />
                  <span>Exportar BibTeX</span>
                </button>
              ) : null}
            </div>
          ) : null}

          {itemsInShelf.length === 0 ? (
            <div className="my-auto py-12 text-center">
              <p className="font-editorial text-lg font-medium">Esta estantería está vacía</p>
              <p className="mx-auto mt-1 max-w-sm text-sm" style={{ color: 'var(--text-muted)' }}>
                Usa el marcador de cualquier libro o artículo para guardarlo aquí y añadirle notas.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {itemsInShelf.map((item) => {
                const pub = item.publication;
                return (
                  <li
                    key={item.id}
                    className="rounded-md border p-3.5"
                    style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-hairline)' }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => {
                            onSelectPublication(pub);
                            onClose();
                          }}
                          lang={langAttr(pub)}
                          className="font-editorial text-left text-base font-semibold hover:underline"
                        >
                          {pub.title}
                        </button>
                        <p className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {pub.authors.join('; ') || pub.publisher} · {pub.year || 's. f.'}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            if (pub.pdfUrl) onOpenReader(pub, item.readingPage);
                            else onSelectPublication(pub);
                            onClose();
                          }}
                          className="btn btn-primary btn-sm"
                        >
                          {pub.pdfUrl ? (
                            <BookOpen className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <Eye className="h-4 w-4" aria-hidden="true" />
                          )}
                          <span>{pub.pdfUrl ? (item.readingPage > 1 ? `Leer (pág. ${item.readingPage})` : 'Leer') : 'Ver ficha'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveItem(item.shelfId, pub)}
                          className="btn btn-quiet btn-icon btn-sm"
                          aria-label={`Quitar de la estantería: ${pub.title}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    <div className="mt-2.5 flex items-start gap-2">
                      <StickyNote className="mt-3 h-4 w-4 shrink-0" style={{ color: 'var(--accent-ochre)' }} aria-hidden="true" />
                      <textarea
                        rows={2}
                        defaultValue={item.note}
                        aria-label={`Nota de lectura: ${pub.title}`}
                        onBlur={(e) => {
                          if (e.target.value !== item.note) onUpdateNote(item.shelfId, pub, e.target.value);
                        }}
                        placeholder="Escribe una nota; se guarda al salir del campo"
                        className="field"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
