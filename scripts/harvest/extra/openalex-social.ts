/**
 * OpenAlex curated high-reliability Social Sciences Books (`oa-books`) and
 * Peer-Reviewed Scientific Journals (`oa-journals`) — strictly limited to hosts
 * verified to serve direct `%PDF-` streams without third-party CDN/S3 redirects.
 */
import { safeHttpUrl } from '../../../functions/security';
import { appendJsonl, loadState, readJsonl, saveState } from '../cache';
import { fetchWithRetry, QuotaError } from '../http';
import { emptyRec, normalizeDoi, squash, type DocType, type Rec } from '../model';
import { abstractFromInverted } from '../openalex';
import { langFromIso, type SourceResult } from './common';

const SELECT = [
  'id',
  'doi',
  'title',
  'type',
  'publication_year',
  'publication_date',
  'language',
  'primary_location',
  'best_oa_location',
  'authorships',
  'abstract_inverted_index',
  'cited_by_count',
  'keywords',
  'primary_topic'
].join(',');

interface SourceSpec {
  id: string;
  label: string;
  countryHint?: string;
  docType: DocType;
  max: number;
  pdfHost: RegExp;
  preferSocial?: boolean;
}

export const OA_BOOK_ALLOW =
  /^(?:www\.cambridge\.org|researchonline\.lse\.ac\.uk|www\.editoracrv\.com\.br|www\.editoracientifica\.com\.br|downloads\.editoracientifica\.com\.br|real\.mtak\.hu|repository\.unad\.edu\.co|pure\.iiasa\.ac\.at|doi\.org)$/i;

export const OA_JOURNAL_ALLOW =
  /^(?:ciencialatina\.org|revistasonline\.inap\.es|revistas\.upsa\.es|doi\.org)$/i;

const OA_BOOK_PDF_HOST =
  /^(?:www\.cambridge\.org|researchonline\.lse\.ac\.uk|www\.editoracrv\.com\.br|www\.editoracientifica\.com\.br|downloads\.editoracientifica\.com\.br|real\.mtak\.hu|repository\.unad\.edu\.co|pure\.iiasa\.ac\.at)$/i;

const OA_JOURNAL_PDF_HOST =
  /^(?:ciencialatina\.org|revistasonline\.inap\.es|revistas\.upsa\.es)$/i;

const BOOK_SPECS: SourceSpec[] = [
  { id: 'S4306462995', label: 'Cambridge Univ. Press OA', docType: 'book', max: 1400, pdfHost: OA_BOOK_PDF_HOST, preferSocial: true },
  { id: 'S4306401593', label: 'LSE Research Online', docType: 'book', max: 800, pdfHost: OA_BOOK_PDF_HOST, preferSocial: true },
  { id: 'S4306463187', label: 'Editora CRV eBooks', countryHint: 'Brasil', docType: 'book', max: 800, pdfHost: OA_BOOK_PDF_HOST },
  { id: 'S4306486877', label: 'Editora Científica Digital', countryHint: 'Brasil', docType: 'book', max: 700, pdfHost: OA_BOOK_PDF_HOST },
  { id: 'S4306401253', label: 'UNAD Colombia', countryHint: 'Colombia', docType: 'book', max: 450, pdfHost: OA_BOOK_PDF_HOST },
  { id: 'S4306400081', label: 'MTA Library', docType: 'book', max: 400, pdfHost: OA_BOOK_PDF_HOST, preferSocial: true },
  { id: 'S4306401423', label: 'IIASA PURE', docType: 'book', max: 150, pdfHost: OA_BOOK_PDF_HOST }
];

const JOURNAL_SPECS: SourceSpec[] = [
  { id: 'S4210182600', label: 'Ciencia Latina', countryHint: 'México', docType: 'article', max: 2600, pdfHost: OA_JOURNAL_PDF_HOST, preferSocial: false },
  { id: 'S4306508241', label: 'Documentación Administrativa (INAP)', countryHint: 'España', docType: 'article', max: 350, pdfHost: OA_JOURNAL_PDF_HOST },
  { id: 'S4210201428', label: 'REALA (INAP)', countryHint: 'España', docType: 'article', max: 350, pdfHost: OA_JOURNAL_PDF_HOST },
  { id: 'S4306527282', label: 'Rev. Española Derecho Canónico (UPSA)', countryHint: 'España', docType: 'article', max: 300, pdfHost: OA_JOURNAL_PDF_HOST }
];

interface OaLocation {
  landing_page_url?: string | null;
  pdf_url?: string | null;
  source?: { display_name?: string | null } | null;
}

interface OaWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  language?: string | null;
  primary_location?: OaLocation | null;
  best_oa_location?: OaLocation | null;
  authorships?: Array<{ author?: { display_name?: string } | null }> | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  cited_by_count?: number;
  keywords?: Array<{ display_name?: string }> | null;
  primary_topic?: { display_name?: string; field?: { display_name?: string }; domain?: { id?: string } } | null;
}

const WANTED_LANG = new Set(['es', 'pt', 'en', 'fr', '']);

function convertWork(
  w: OaWork,
  spec: SourceSpec,
  collectionCode: string,
  collection: string,
  allow: RegExp
): Rec | null {
  const oaId = w.id.split('/').pop();
  const title = squash(w.title || '');
  if (!oaId || !title) return null;

  const lang = langFromIso(w.language || '');
  if (!WANTED_LANG.has(lang)) return null;

  const pdfCandidates = [w.primary_location?.pdf_url, w.best_oa_location?.pdf_url];
  const pdfUrl = pdfCandidates
    .map((u) => safeHttpUrl(u, spec.pdfHost)?.toString())
    .find(Boolean);
  if (!pdfUrl) return null;

  const doi = normalizeDoi(w.doi);
  const landingCandidates = [
    w.primary_location?.landing_page_url,
    w.best_oa_location?.landing_page_url,
    doi ? `https://doi.org/${doi}` : undefined,
    pdfUrl
  ];
  const scieloUrl = landingCandidates
    .map((u) => safeHttpUrl(u, allow)?.toString())
    .find(Boolean);
  if (!scieloUrl) return null;

  const rawSource = squash(w.primary_location?.source?.display_name || w.best_oa_location?.source?.display_name || '') || spec.label;
  const keywords = (w.keywords || []).map((k) => squash(k.display_name || '')).filter(Boolean).slice(0, 12);
  if (w.primary_topic?.field?.display_name && !keywords.includes(w.primary_topic.field.display_name)) {
    keywords.unshift(squash(w.primary_topic.field.display_name));
  }

  return emptyRec({
    title,
    docType: spec.docType,
    externalId: `${collectionCode}-${oaId}`,
    openalexId: oaId,
    doi,
    authors: (w.authorships || []).map((a) => squash(a.author?.display_name || '')).filter(Boolean).slice(0, 20),
    publisher: rawSource,
    journal: spec.countryHint ? `${rawSource} ${spec.countryHint}` : rawSource,
    year: w.publication_year ?? null,
    publicationDate: w.publication_date || undefined,
    language: lang === 'es' || lang === 'pt' || lang === 'en' ? lang : '',
    abstract: abstractFromInverted(w.abstract_inverted_index),
    keywords: keywords.slice(0, 12),
    cited: w.cited_by_count || 0,
    fieldName: w.primary_topic?.field?.display_name || undefined,
    domainId: w.primary_topic?.domain?.id || undefined,
    scieloUrl,
    pdfUrl,
    collection,
    collectionCode,
    setSpec: spec.id,
    origins: ['openalex']
  });
}

async function harvestGroup(opts: {
  sourceName: string;
  collectionCode: string;
  collection: string;
  specs: SourceSpec[];
  allow: RegExp;
  cap: number;
  log: (msg: string) => void;
}): Promise<SourceResult> {
  const { sourceName, collectionCode, collection, specs, allow, cap, log } = opts;
  const cacheName = `extra-${collectionCode}`;
  const byId = new Map<string, Rec>();
  for (const r of readJsonl<Rec>(cacheName)) if (r.externalId) byId.set(r.externalId, r);

  const apiKey = (process.env.OPENALEX_API_KEY || '').trim();
  const keyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';
  const email = (process.env.HARVEST_CONTACT_EMAIL || '').trim();
  const mailParam = email ? `&mailto=${encodeURIComponent(email)}` : '';

  let scanned = 0;
  let stoppedNote = '';

  for (const spec of specs) {
    if (byId.size >= cap) break;
    const stateKey = `extra:${collectionCode}:${spec.id}`;
    const st = loadState()[stateKey] || {};
    if (st.done) continue;

    let page = Number(st.cursor || '1');
    if (!Number.isFinite(page) || page < 1) page = 1;
    let sourceKept = 0;
    for (const r of byId.values()) if (r.setSpec === spec.id) sourceKept += 1;

    const filterParts = [
      'is_oa:true',
      `type:${spec.docType}`,
      'has_pdf_url:true',
      'publication_year:2015-2026',
      `primary_location.source.id:${spec.id}`
    ];
    if (spec.preferSocial) filterParts.push('primary_topic.domain.id:domains/2');

    while (byId.size < cap && sourceKept < spec.max && page <= 50) {
      const url = `https://api.openalex.org/works?filter=${filterParts.join(',')}&per-page=200&page=${page}&sort=publication_date:desc&select=${SELECT}${keyParam}${mailParam}`;
      let res: Response;
      try {
        res = await fetchWithRetry(url, { timeoutMs: 45_000, maxRetries: 3 });
      } catch (err) {
        if (err instanceof QuotaError) {
          stoppedNote = `OpenAlex quota reached (${err.message}); partial results kept`;
          break;
        }
        throw err;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 160);
        if (res.status === 429 || res.status === 403 || res.status === 401) {
          stoppedNote = `OpenAlex HTTP ${res.status}: ${body}`;
          break;
        }
        throw new Error(`OpenAlex ${spec.id} HTTP ${res.status}: ${body}`);
      }
      const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
      const json = (await res.json()) as { meta?: { count?: number }; results?: OaWork[] };
      const results = json.results || [];
      scanned += results.length;

      const batch: Rec[] = [];
      for (const w of results) {
        if (byId.size >= cap || sourceKept >= spec.max) break;
        const rec = convertWork(w, spec, collectionCode, collection, allow);
        if (!rec?.externalId || byId.has(rec.externalId)) continue;
        byId.set(rec.externalId, rec);
        batch.push(rec);
        sourceKept += 1;
      }
      appendJsonl(cacheName, batch);

      const total = json.meta?.count ?? 0;
      const done = results.length < 200 || page * 200 >= Math.min(total, 10_000) || sourceKept >= spec.max;
      page += 1;
      saveState({ [stateKey]: { cursor: done ? null : String(page), count: sourceKept, done } });

      if (batch.length > 0 || done) {
        log(`${sourceName} [${spec.label}] p${page - 1}: +${batch.length} (group total ${byId.size})`);
      }
      if (Number.isFinite(remaining) && remaining <= 2) {
        stoppedNote = `OpenAlex budget nearly exhausted (remaining=${remaining}); partial results kept`;
        break;
      }
      if (done) break;
    }
    if (stoppedNote) break;
  }

  const records = [...byId.values()].slice(0, cap);
  return {
    report: {
      source: sourceName,
      endpoint: 'https://api.openalex.org/works',
      status: 'ok',
      note: stoppedNote || `OpenAlex verified repositories (${specs.map((s) => s.label).join(', ')}).`,
      scanned,
      harvested: records.length
    },
    records,
    allow,
    allowNonExtPdf: true
  };
}

export async function harvestOaBooks(opts: { cap: number; log: (msg: string) => void }): Promise<SourceResult> {
  return harvestGroup({
    sourceName: 'OpenAlex Social Books',
    collectionCode: 'oa-books',
    collection: 'Libros Ciencias Sociales',
    specs: BOOK_SPECS,
    allow: OA_BOOK_ALLOW,
    cap: opts.cap,
    log: opts.log
  });
}

export async function harvestOaJournals(opts: { cap: number; log: (msg: string) => void }): Promise<SourceResult> {
  return harvestGroup({
    sourceName: 'OpenAlex Scientific Journals',
    collectionCode: 'oa-journals',
    collection: 'Revistas científicas OA',
    specs: JOURNAL_SPECS,
    allow: OA_JOURNAL_ALLOW,
    cap: opts.cap,
    log: opts.log
  });
}
