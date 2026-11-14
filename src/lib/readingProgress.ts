/**
 * Reading progress for EVERY book (not only shelved ones), stored locally on the device.
 * Shape in localStorage key `coleebri:progress:v1`:
 *   { [publicationId]: { page: number; totalPages?: number; updatedAt: number } }
 * Bounded to the most recent MAX_ENTRIES books. Never throws (private mode / quota safe).
 */

export interface ReadingProgress {
  page: number;
  totalPages?: number;
  updatedAt: number;
}

const STORAGE_KEY = 'coleebri:progress:v1';
const MAX_ENTRIES = 300;
const CHANGE_EVENT = 'coleebri:progress-change';

type ProgressMap = Record<string, ReadingProgress>;

function isProgress(value: unknown): value is ReadingProgress {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ReadingProgress>;
  return (
    typeof v.page === 'number' &&
    Number.isFinite(v.page) &&
    v.page >= 1 &&
    typeof v.updatedAt === 'number' &&
    (v.totalPages === undefined || (typeof v.totalPages === 'number' && v.totalPages >= 1))
  );
}

function readAll(): ProgressMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ProgressMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isProgress(value)) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(map: ProgressMap): void {
  try {
    const entries = Object.entries(map)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // storage unavailable — progress simply isn't remembered
  }
}

export function getReadingProgress(publicationId: string): ReadingProgress | null {
  return readAll()[publicationId] ?? null;
}

export function getAllReadingProgress(): ProgressMap {
  return readAll();
}

export function saveReadingProgress(publicationId: string, page: number, totalPages?: number): void {
  if (!publicationId || !Number.isFinite(page) || page < 1) return;
  const map = readAll();
  const previous = map[publicationId];
  if (previous && previous.page === page && previous.totalPages === totalPages) return;
  map[publicationId] = { page: Math.trunc(page), totalPages, updatedAt: Date.now() };
  writeAll(map);
}

export function clearReadingProgress(publicationId: string): void {
  const map = readAll();
  if (!(publicationId in map)) return;
  delete map[publicationId];
  writeAll(map);
}

/** Subscribe to progress changes (same tab via custom event, other tabs via `storage`). */
export function subscribeReadingProgress(callback: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener('storage', onStorage);
  };
}
