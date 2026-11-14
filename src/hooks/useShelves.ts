import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Publication, Shelf, ShelfItem } from '../types/publication';
import { getOwnerKey } from '../lib/ownerKey';
import {
  normalizeShelfItems,
  normalizeShelves,
  timestamp
} from '../lib/publication';
import { safeHexColor } from '../lib/safeUrl';
import { readJson, writeJson } from '../lib/storage';

const SHELVES_KEY = 'coleebri:shelves:v1';
const ITEMS_KEY = 'coleebri:shelf-items:v1';
const LEGACY_SHELVES_KEY = 'scielo-open-library:shelves:v1';
const LEGACY_ITEMS_KEY = 'scielo-open-library:shelf-items:v1';

export const MAX_SHELVES = 40;
export const MAX_ITEMS = 1500;
export const DEFAULT_SHELF_IDS: readonly string[] = ['favorites', 'research-queue'];
const MAX_PUSH_PER_SESSION = 300;
const PAGE_SYNC_DELAY_MS = 2000;

function defaultShelves(): Shelf[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'favorites',
      name: 'Lecturas esenciales',
      description: 'Libros y artículos que quieres tener siempre a mano.',
      accent: '#1758C4',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'research-queue',
      name: 'Tesis y marco teórico',
      description: 'Fuentes para citar y contrastar en tu investigación.',
      accent: '#B8863B',
      createdAt: now,
      updatedAt: now
    }
  ];
}

function loadShelves(): Shelf[] {
  const stored = normalizeShelves(readJson(SHELVES_KEY) ?? readJson(LEGACY_SHELVES_KEY));
  const known = new Set(stored.map((s) => s.id));
  const missing = defaultShelves().filter((s) => !known.has(s.id));
  return [...missing, ...stored];
}

function loadItems(): ShelfItem[] {
  return normalizeShelfItems(readJson(ITEMS_KEY) ?? readJson(LEGACY_ITEMS_KEY));
}

interface ApiResult {
  ok: boolean;
  status: number;
  data: unknown;
}

async function shelvesRequest(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<ApiResult> {
  try {
    const headers: Record<string, string> = { 'X-Coleebri-Owner': getOwnerKey() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // not JSON (e.g. the dev server answering with index.html)
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only the failures the visitor can act on; offline / dev-server failures stay silent. */
function noticeFor(result: ApiResult): string | null {
  if (result.ok) return null;
  const data = isRecord(result.data) ? result.data : {};
  if (result.status === 409 && data.error === 'quota_exceeded') {
    return typeof data.message === 'string' && data.message
      ? data.message + ' Se conserva solo en este dispositivo.'
      : 'Llegaste al límite de la sincronización. Se conserva solo en este dispositivo.';
  }
  if (result.status === 429) return 'Hay demasiadas solicitudes. Tus cambios se guardan en este dispositivo.';
  return null;
}

function newer(a: { updatedAt: string }, b: { updatedAt: string }): boolean {
  return timestamp(a.updatedAt) > timestamp(b.updatedAt);
}

function mergeShelves(local: Shelf[], remote: Shelf[]): Shelf[] {
  const byId = new Map(local.map((s) => [s.id, s]));
  for (const incoming of remote) {
    const current = byId.get(incoming.id);
    if (!current) byId.set(incoming.id, incoming);
    else if (newer(incoming, current)) byId.set(incoming.id, { ...incoming, createdAt: current.createdAt });
  }
  return [...byId.values()];
}

function mergeItems(local: ShelfItem[], remote: ShelfItem[]): ShelfItem[] {
  const byId = new Map(local.map((i) => [i.id, i]));
  for (const incoming of remote) {
    const current = byId.get(incoming.id);
    if (!current) byId.set(incoming.id, incoming);
    else if (newer(incoming, current)) {
      // the server snapshot of the publication is trimmed: keep the richer local one
      byId.set(incoming.id, { ...incoming, publication: current.publication, addedAt: current.addedAt });
    }
  }
  return [...byId.values()].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
}

export function useShelves() {
  const [shelves, setShelves] = useState<Shelf[]>(loadShelves);
  const [shelfItems, setShelfItems] = useState<ShelfItem[]>(loadItems);
  const [syncedWithD1, setSyncedWithD1] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const shelvesRef = useRef(shelves);
  const itemsRef = useRef(shelfItems);
  const pageTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pushedRef = useRef(false);

  // Commit helpers keep the refs in sync synchronously, so rapid consecutive calls see fresh data
  // and no state updater ever has side effects.
  const commitShelves = useCallback((next: Shelf[]) => {
    shelvesRef.current = next;
    setShelves(next);
  }, []);
  const commitItems = useCallback((next: ShelfItem[]) => {
    itemsRef.current = next;
    setShelfItems(next);
  }, []);

  useEffect(() => {
    writeJson(SHELVES_KEY, shelves);
  }, [shelves]);
  useEffect(() => {
    writeJson(ITEMS_KEY, shelfItems);
  }, [shelfItems]);

  useEffect(() => {
    const timers = pageTimers.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const reportFailure = useCallback((result: ApiResult) => {
    const message = noticeFor(result);
    if (message) setNotice(message);
  }, []);

  // Hydrate: MERGE the server copy into the local one (localStorage stays the source of truth).
  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await shelvesRequest('GET', '/api/shelves');
      if (!active || !result.ok || !isRecord(result.data) || result.data.source !== 'd1') return;
      setSyncedWithD1(true);

      const remoteShelves = normalizeShelves(result.data.shelves);
      const remoteItems = normalizeShelfItems(result.data.items);
      commitShelves(mergeShelves(shelvesRef.current, remoteShelves));
      commitItems(mergeItems(itemsRef.current, remoteItems));

      if (pushedRef.current) return;
      pushedRef.current = true;
      const remoteShelfIds = new Set(remoteShelves.map((s) => s.id));
      const remoteItemIds = new Set(remoteItems.map((i) => i.id));
      let budget = MAX_PUSH_PER_SESSION;

      for (const shelf of shelvesRef.current) {
        if (!active || budget-- <= 0) return;
        if (remoteShelfIds.has(shelf.id)) continue;
        const res = await shelvesRequest('POST', '/api/shelves', {
          action: 'create_shelf',
          id: shelf.id,
          name: shelf.name,
          description: shelf.description,
          accent: safeHexColor(shelf.accent)
        });
        if (!res.ok && (res.status === 0 || res.status === 401 || res.status === 429)) return;
      }
      for (const item of itemsRef.current) {
        if (!active || budget-- <= 0) return;
        if (remoteItemIds.has(item.id)) continue;
        const res = await shelvesRequest('POST', '/api/shelves', {
          action: 'upsert_item',
          shelfId: item.shelfId,
          publication: item.publication,
          note: item.note,
          readingPage: item.readingPage
        });
        if (!res.ok && (res.status === 0 || res.status === 401 || res.status === 429 || res.status === 409)) {
          reportFailure(res);
          return;
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [commitItems, commitShelves, reportFailure]);

  const savedPublicationIds = useMemo(() => new Set(shelfItems.map((i) => i.publicationId)), [shelfItems]);

  const getPublicationShelves = useCallback(
    (publicationId: string) => itemsRef.current.filter((i) => i.publicationId === publicationId),
    []
  );

  const createShelf = useCallback(
    (name: string, description?: string, accent?: string): Shelf | null => {
      const clean = name.trim().slice(0, 80);
      if (!clean) return null;
      if (shelvesRef.current.length >= MAX_SHELVES) {
        setNotice('Alcanzaste el máximo de ' + MAX_SHELVES + ' estanterías. Elimina una para crear otra.');
        return null;
      }
      const now = new Date().toISOString();
      const suffix = Math.random().toString(36).slice(2, 6);
      const shelf: Shelf = {
        id: 'shelf-' + Date.now().toString(36) + '-' + suffix,
        name: clean,
        description: description?.trim().slice(0, 240) || undefined,
        accent: safeHexColor(accent),
        createdAt: now,
        updatedAt: now
      };
      commitShelves([...shelvesRef.current, shelf]);
      void shelvesRequest('POST', '/api/shelves', {
        action: 'create_shelf',
        id: shelf.id,
        name: shelf.name,
        description: shelf.description,
        accent: shelf.accent
      }).then(reportFailure);
      return shelf;
    },
    [commitShelves, reportFailure]
  );

  const deleteShelf = useCallback(
    (shelfId: string) => {
      if (DEFAULT_SHELF_IDS.includes(shelfId)) return;
      commitShelves(shelvesRef.current.filter((s) => s.id !== shelfId));
      commitItems(itemsRef.current.filter((i) => i.shelfId !== shelfId));
      void shelvesRequest('DELETE', '/api/shelves?shelfId=' + encodeURIComponent(shelfId));
    },
    [commitItems, commitShelves]
  );

  /** Adds or removes the publication; returns true when it is now on the shelf. */
  const toggleInShelf = useCallback(
    (shelfId: string, publication: Publication): boolean => {
      const existing = itemsRef.current.some((i) => i.shelfId === shelfId && i.publicationId === publication.id);
      if (existing) {
        commitItems(itemsRef.current.filter((i) => !(i.shelfId === shelfId && i.publicationId === publication.id)));
        void shelvesRequest(
          'DELETE',
          '/api/shelves?shelfId=' + encodeURIComponent(shelfId) + '&publicationId=' + encodeURIComponent(publication.id)
        );
        return false;
      }
      if (itemsRef.current.length >= MAX_ITEMS) {
        setNotice('Alcanzaste el máximo de ' + MAX_ITEMS + ' obras guardadas. Quita alguna para guardar otra.');
        return false;
      }
      const now = new Date().toISOString();
      const item: ShelfItem = {
        id: shelfId + '::' + publication.id,
        shelfId,
        publicationId: publication.id,
        publication,
        note: '',
        readingPage: 1,
        addedAt: now,
        updatedAt: now
      };
      commitItems([item, ...itemsRef.current]);
      // note / readingPage omitted: the server keeps whatever it already stored
      void shelvesRequest('POST', '/api/shelves', { action: 'upsert_item', shelfId, publication }).then(reportFailure);
      return true;
    },
    [commitItems, reportFailure]
  );

  /** Saves (or clears, with '') the note; creates the item if the publication was not on the shelf. */
  const updateNote = useCallback(
    (shelfId: string, publication: Publication, note: string) => {
      const cleanNote = note.slice(0, 4000);
      const now = new Date().toISOString();
      const current = itemsRef.current;
      if (current.some((i) => i.shelfId === shelfId && i.publicationId === publication.id)) {
        commitItems(
          current.map((i) =>
            i.shelfId === shelfId && i.publicationId === publication.id ? { ...i, note: cleanNote, updatedAt: now } : i
          )
        );
      } else {
        if (current.length >= MAX_ITEMS) {
          setNotice('Alcanzaste el máximo de ' + MAX_ITEMS + ' obras guardadas.');
          return;
        }
        commitItems([
          {
            id: shelfId + '::' + publication.id,
            shelfId,
            publicationId: publication.id,
            publication,
            note: cleanNote,
            readingPage: 1,
            addedAt: now,
            updatedAt: now
          },
          ...current
        ]);
      }
      void shelvesRequest('POST', '/api/shelves', {
        action: 'upsert_item',
        shelfId,
        publication,
        note: cleanNote // '' explicitly clears the stored note
      }).then(reportFailure);
    },
    [commitItems, reportFailure]
  );

  /** Remembers the page on every shelf that holds the publication (local at once, server debounced). */
  const setReadingPage = useCallback(
    (publication: Publication, page: number) => {
      if (!Number.isFinite(page) || page < 1) return;
      const target = Math.trunc(page);
      const holders = itemsRef.current.filter((i) => i.publicationId === publication.id && i.readingPage !== target);
      if (holders.length === 0) return;
      const now = new Date().toISOString();
      const holderIds = new Set(holders.map((h) => h.id));
      commitItems(itemsRef.current.map((i) => (holderIds.has(i.id) ? { ...i, readingPage: target, updatedAt: now } : i)));

      for (const holder of holders) {
        const timers = pageTimers.current;
        const previous = timers.get(holder.id);
        if (previous) clearTimeout(previous);
        timers.set(
          holder.id,
          setTimeout(() => {
            timers.delete(holder.id);
            void shelvesRequest('POST', '/api/shelves', {
              action: 'update_note',
              shelfId: holder.shelfId,
              publicationId: holder.publicationId,
              readingPage: target
            });
          }, PAGE_SYNC_DELAY_MS)
        );
      }
    },
    [commitItems]
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    shelves,
    shelfItems,
    syncedWithD1,
    notice,
    dismissNotice,
    savedPublicationIds,
    getPublicationShelves,
    createShelf,
    deleteShelf,
    toggleInShelf,
    updateNote,
    setReadingPage
  };
}
