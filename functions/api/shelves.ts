import type { Env } from '../types';
import { normalizeDocType, normalizeLanguageCode, normalizeOecdArea } from '../types';
import type { Publication, Shelf, ShelfItem } from '../../src/types/publication';
import { OECD_AREA_MAP } from '../../src/lib/taxonomy';
import { HttpError, cleanText, errorResponse, json, readJsonBody, resolveOwnerHash, safeUrlString } from '../security';

/**
 * Private shelves & notes. Every query is scoped by `owner_hash` = SHA-256 of the anonymous
 * per-device key sent in `X-Coleebri-Owner`. A visitor can only ever see or modify their own rows.
 */

const MAX_SHELVES_PER_OWNER = 40;
const MAX_ITEMS_PER_OWNER = 1500;
const MAX_NOTE_LENGTH = 4000;
const ID_PATTERN = /^[A-Za-z0-9:._-]{1,120}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

interface ShelfRow {
  id: string;
  name: string;
  description: string | null;
  accent: string;
  created_at: string;
  updated_at: string;
}

interface ShelfItemRow {
  shelf_id: string;
  publication_id: string;
  publication_json: string;
  note: string;
  reading_page: number;
  added_at: string;
  updated_at: string;
}

function assertId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new HttpError(400, 'invalid_field', `Campo inválido: ${field}`);
  }
  return value;
}

/** Stores only a small, sanitized snapshot of the publication (never arbitrary client JSON). */
function publicationSnapshot(p: Partial<Publication> | undefined): Publication {
  if (!p || typeof p !== 'object') throw new HttpError(400, 'invalid_field', 'Campo inválido: publication');
  const id = assertId(p.id, 'publication.id');
  const title = cleanText(p.title, 400);
  const scieloUrl = safeUrlString(p.scieloUrl);
  if (!title || !scieloUrl) throw new HttpError(400, 'invalid_field', 'Campo inválido: publication');
  const oecdArea = normalizeOecdArea(p.oecdArea);
  return {
    id,
    title,
    authors: Array.isArray(p.authors) ? p.authors.map((a) => cleanText(a, 120)).filter(Boolean).slice(0, 8) : [],
    publisher: cleanText(p.publisher, 160) || 'SciELO',
    country: cleanText(p.country, 60) || undefined,
    collection: cleanText(p.collection, 120) || 'SciELO Books',
    collectionCode: cleanText(p.collectionCode, 40) || 'books',
    year: typeof p.year === 'number' && p.year >= 1500 && p.year <= 2100 ? Math.trunc(p.year) : null,
    language: normalizeLanguageCode(p.language),
    docType: normalizeDocType(p.docType),
    oecdArea,
    oecdAreaLabel: OECD_AREA_MAP[oecdArea].label,
    abstract: cleanText(p.abstract, 600),
    keywords: [],
    doi: cleanText(p.doi, 200) || undefined,
    isbn: cleanText(p.isbn, 40) || undefined,
    scieloUrl,
    pdfUrl: safeUrlString(p.pdfUrl),
    coverUrl: safeUrlString(p.coverUrl),
    citedByCount: typeof p.citedByCount === 'number' && p.citedByCount >= 0 ? Math.trunc(p.citedByCount) : 0,
    sourceOrigin: p.sourceOrigin === 'opds' || p.sourceOrigin === 'oai-pmh' ? p.sourceOrigin : 'openalex'
  };
}

function readingPageOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100_000, Math.max(1, Math.trunc(value)));
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ source: 'local-only', shelves: [], items: [] });
  const owner = await resolveOwnerHash(request);

  const [shelvesRes, itemsRes] = await env.DB.batch([
    env.DB.prepare(
      'SELECT id, name, description, accent, created_at, updated_at FROM owner_shelves WHERE owner_hash = ? ORDER BY created_at ASC LIMIT ?'
    ).bind(owner, MAX_SHELVES_PER_OWNER),
    env.DB.prepare(
      'SELECT shelf_id, publication_id, publication_json, note, reading_page, added_at, updated_at FROM owner_shelf_items WHERE owner_hash = ? ORDER BY updated_at DESC LIMIT ?'
    ).bind(owner, MAX_ITEMS_PER_OWNER)
  ]);

  const shelves: Shelf[] = ((shelvesRes.results || []) as unknown as ShelfRow[]).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? undefined,
    accent: s.accent,
    createdAt: s.created_at,
    updatedAt: s.updated_at
  }));

  const items: ShelfItem[] = [];
  for (const row of (itemsRes.results || []) as unknown as ShelfItemRow[]) {
    try {
      items.push({
        id: `${row.shelf_id}::${row.publication_id}`,
        shelfId: row.shelf_id,
        publicationId: row.publication_id,
        publication: JSON.parse(row.publication_json) as Publication,
        note: row.note || '',
        readingPage: row.reading_page || 1,
        addedAt: row.added_at,
        updatedAt: row.updated_at
      });
    } catch {
      // skip malformed row
    }
  }
  return json({ source: 'd1', shelves, items });
};

type ShelfMutation = {
  action?: 'create_shelf' | 'upsert_item' | 'update_note';
  id?: string;
  name?: string;
  description?: string;
  accent?: string;
  shelfId?: string;
  publicationId?: string;
  publication?: Partial<Publication>;
  note?: string;
  readingPage?: number;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ source: 'local-only', ok: true });
  const owner = await resolveOwnerHash(request);
  const body = await readJsonBody<ShelfMutation>(request, 32 * 1024);

  if (body.action === 'create_shelf') {
    const id = assertId(body.id, 'id');
    const name = cleanText(body.name, 80);
    if (!name) throw new HttpError(400, 'invalid_field', 'El nombre es obligatorio.');
    const description = cleanText(body.description, 240) || null;
    const accent = typeof body.accent === 'string' && HEX_COLOR.test(body.accent) ? body.accent : '#1758C4';

    const count = await env.DB.prepare('SELECT COUNT(*) as c FROM owner_shelves WHERE owner_hash = ?').bind(owner).first<{ c: number }>();
    const exists = await env.DB.prepare('SELECT 1 FROM owner_shelves WHERE owner_hash = ? AND id = ?').bind(owner, id).first();
    if (!exists && (count?.c ?? 0) >= MAX_SHELVES_PER_OWNER) {
      throw new HttpError(409, 'quota_exceeded', `Máximo ${MAX_SHELVES_PER_OWNER} estanterías por dispositivo.`);
    }
    await env.DB.prepare(
      `INSERT INTO owner_shelves (owner_hash, id, name, description, accent) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_hash, id) DO UPDATE SET name = excluded.name, description = excluded.description,
         accent = excluded.accent, updated_at = datetime('now')`
    )
      .bind(owner, id, name, description, accent)
      .run();
    return json({ ok: true, id });
  }

  if (body.action === 'upsert_item' || body.action === 'update_note') {
    const shelfId = assertId(body.shelfId, 'shelfId');
    const note = typeof body.note === 'string' ? cleanText(body.note, MAX_NOTE_LENGTH) : null;
    const readingPage = readingPageOf(body.readingPage);

    if (body.action === 'update_note') {
      const publicationId = assertId(body.publicationId ?? body.publication?.id, 'publicationId');
      await env.DB.prepare(
        `UPDATE owner_shelf_items SET note = COALESCE(?, note), reading_page = COALESCE(?, reading_page), updated_at = datetime('now')
         WHERE owner_hash = ? AND shelf_id = ? AND publication_id = ?`
      )
        .bind(note, readingPage, owner, shelfId, publicationId)
        .run();
      return json({ ok: true });
    }

    const snapshot = publicationSnapshot(body.publication);
    const shelf = await env.DB.prepare('SELECT 1 FROM owner_shelves WHERE owner_hash = ? AND id = ?').bind(owner, shelfId).first();
    if (!shelf) {
      // Default shelves exist client-side from the first visit; create them lazily server-side.
      const defaults: Record<string, string> = { favorites: 'Lecturas esenciales', 'research-queue': 'Tesis y marco teórico' };
      if (!defaults[shelfId]) throw new HttpError(404, 'shelf_not_found');
      await env.DB.prepare('INSERT OR IGNORE INTO owner_shelves (owner_hash, id, name) VALUES (?, ?, ?)')
        .bind(owner, shelfId, defaults[shelfId])
        .run();
    }
    const count = await env.DB.prepare('SELECT COUNT(*) as c FROM owner_shelf_items WHERE owner_hash = ?').bind(owner).first<{ c: number }>();
    if ((count?.c ?? 0) >= MAX_ITEMS_PER_OWNER) {
      const exists = await env.DB.prepare(
        'SELECT 1 FROM owner_shelf_items WHERE owner_hash = ? AND shelf_id = ? AND publication_id = ?'
      )
        .bind(owner, shelfId, snapshot.id)
        .first();
      if (!exists) throw new HttpError(409, 'quota_exceeded', `Máximo ${MAX_ITEMS_PER_OWNER} obras guardadas por dispositivo.`);
    }

    // note/readingPage = null → keep the stored value (fixes the "page resets to 1" bug).
    await env.DB.prepare(
      `INSERT INTO owner_shelf_items (owner_hash, shelf_id, publication_id, publication_json, note, reading_page)
       VALUES (?, ?, ?, ?, COALESCE(?, ''), COALESCE(?, 1))
       ON CONFLICT(owner_hash, shelf_id, publication_id) DO UPDATE SET
         publication_json = excluded.publication_json,
         note = COALESCE(?, owner_shelf_items.note),
         reading_page = COALESCE(?, owner_shelf_items.reading_page),
         updated_at = datetime('now')`
    )
      .bind(owner, shelfId, snapshot.id, JSON.stringify(snapshot), note, readingPage, note, readingPage)
      .run();
    return json({ ok: true, id: `${shelfId}::${snapshot.id}` });
  }

  return errorResponse(400, 'invalid_action');
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ source: 'local-only', ok: true });
  const owner = await resolveOwnerHash(request);
  const url = new URL(request.url);
  const shelfId = assertId(url.searchParams.get('shelfId'), 'shelfId');
  const publicationId = url.searchParams.get('publicationId');

  if (publicationId) {
    await env.DB.prepare('DELETE FROM owner_shelf_items WHERE owner_hash = ? AND shelf_id = ? AND publication_id = ?')
      .bind(owner, shelfId, assertId(publicationId, 'publicationId'))
      .run();
  } else {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM owner_shelf_items WHERE owner_hash = ? AND shelf_id = ?').bind(owner, shelfId),
      env.DB.prepare('DELETE FROM owner_shelves WHERE owner_hash = ? AND id = ?').bind(owner, shelfId)
    ]);
  }
  return json({ ok: true });
};
