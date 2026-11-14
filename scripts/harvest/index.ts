/**
 * Coleebri harvester — resumable pipeline for SciELO Books (OpenAlex → Crossref → OPDS → landing pages).
 *
 *   npm run harvest -- --types=book [--max=N] [--skip-landing] [--fresh] [--with-articles --max-articles=500]
 *                      [--max-landing=1500] [--skip-verify]
 *
 * Writes (never touches the remote database):
 *   migrations/0004_country_backfill.sql, migrations/seed/seed_NNN.sql,
 *   scripts/out/featured.json, scripts/out/harvest-report.json
 * Cache / cursors: scripts/.harvest-cache/ (use --fresh to ignore it).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Publication } from '../../src/types/publication';
import { harvestArticles } from './articles';
import { CACHE_DIR, OUT_DIR, ROOT_DIR, ensureDirs, resetCache } from './cache';
import { crossrefStats, harvestCrossref } from './crossref';
import { stats as httpStats } from './http';
import { loadDoiCache, loadLandingCache, resolveDois, scrapeLandings, type LandingResult } from './landing';
import { dedupe } from './merge';
import { fullTextPdf, scieloLanding, type Rec } from './model';
import { harvestOpds } from './opds';
import { harvestOpenAlex } from './openalex';
import { buildCountryBackfill, legacySeedOai, pickFeaturedCandidates, toPublication, writeSeedChunks } from './output';
import { checkImage, checkMany } from './verify';

function parseArgs(argv: string[]) {
  const flag = (name: string) => argv.includes(`--${name}`);
  const val = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const num = (name: string, fallback: number) => {
    const v = Number(val(name));
    return Number.isFinite(v) && v >= 0 && val(name) !== undefined ? v : fallback;
  };
  const types = (val('types') || 'book').split(',').map((t) => t.trim()).filter(Boolean);
  return {
    types: new Set(types),
    max: val('max') !== undefined ? num('max', Infinity) : Infinity,
    skipLanding: flag('skip-landing'),
    fresh: flag('fresh'),
    withArticles: flag('with-articles'),
    maxArticles: num('max-articles', 500),
    maxLanding: num('max-landing', 1500),
    maxDoi: num('max-doi', 1500),
    skipVerify: flag('skip-verify'),
    sample: num('sample', 30),
    featured: num('featured', 60)
  };
}

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${msg}`);

function count<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function applyLanding(r: Rec, l: LandingResult): void {
  if (!l.ok) return;
  const pdf = fullTextPdf(l.pdfUrl);
  if (pdf) r.pdfUrl = pdf;
  r.epubUrl ||= l.epubUrl;
  if (l.isbns?.length) r.isbns = [...new Set([...l.isbns, ...r.isbns])];
  r.doi ||= l.doi;
  if (l.language && l.language !== 'other') r.language = l.language;
  else if (!r.language && l.language) r.language = 'other';
  r.pageCount ||= l.pages;
  r.year ??= l.year ?? null;
  if (l.publisher && (!r.publisher || /^scielo/i.test(r.publisher))) r.publisher = l.publisher;
  r.coverUrl ||= l.coverUrl;
  if (!r.origins.includes('landing')) r.origins.push('landing');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDirs();
  if (args.fresh) {
    resetCache();
    log('--fresh: cache wiped');
  }
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    args: { types: [...args.types], max: Number.isFinite(args.max) ? args.max : 'unlimited', skipLanding: args.skipLanding, withArticles: args.withArticles, maxLanding: args.maxLanding }
  };
  const skipped: Array<{ source: string; reason: string }> = [
    {
      source: 'oai.books.scielo.org (OAI-PMH)',
      reason: 'Expired TLS certificate. The old script bypassed it with rejectUnauthorized:false; that bypass was removed and the source is not used.'
    }
  ];
  const perSource: Record<string, unknown> = {};
  let all: Rec[] = [];

  /* ---- 1. OpenAlex ---- */
  const quotaNotes: string[] = [];
  for (const t of ['book', 'chapter'] as const) {
    if (!args.types.has(t)) continue;
    log(`OpenAlex ${t}s ...`);
    const r = await harvestOpenAlex(t, args.max, args.fresh);
    perSource[`openalex_${t}`] = { records: r.records.length, pagesThisRun: r.pages, withPdf: r.records.filter((x) => x.pdfUrl).length };
    if (r.quota) {
      quotaNotes.push(r.quota);
      skipped.push({ source: `OpenAlex ${t} (remaining pages)`, reason: r.quota });
    }
    all.push(...r.records);
  }

  /* ---- 2. Crossref ---- */
  if (args.types.has('book')) {
    log('Crossref monographs ...');
    const r = await harvestCrossref(args.max);
    perSource.crossref = { records: r.records.length, pagesThisRun: r.pages, withPdf: r.records.filter((x) => x.pdfUrl).length, pdfLinkIdMismatchDiscarded: crossrefStats.pdfIdMismatch };
    if (r.note) skipped.push({ source: 'Crossref (partial)', reason: r.note });
    all.push(...r.records);
  }

  /* ---- 3. OPDS (best effort) ---- */
  if (args.types.has('book')) {
    log('OPDS (best effort) ...');
    const r = await harvestOpds(args.max);
    perSource.opds = { records: r.records.length };
    if (r.skipped) skipped.push({ source: 'OPDS', reason: r.skipped });
    all.push(...r.records);
  }

  /* ---- 4. optional articles ---- */
  if (args.withArticles) {
    log(`Regional articles (cap ${args.maxArticles}) ...`);
    const r = await harvestArticles(args.maxArticles);
    perSource.articles = { records: r.records.length };
    for (const s of r.skipped) skipped.push({ source: 'regional OAI-PMH', reason: s });
    all.push(...r.records);
  }
  skipped.push({ source: 'scielo.org.co OAI-PMH', reason: 'Times out (journal articles only; out of scope for this run).' });
  report.rawRecords = all.length;

  /* ---- 5. de-dupe #1, doi.org → SciELO id, landing pages ---- */
  let dd = dedupe(all);
  let merges = dd.merges;
  const mergesByKey: Record<string, number> = { ...dd.mergesByKey };
  const addMerges = (m: Record<string, number>) => { for (const [k, v] of Object.entries(m)) mergesByKey[k] = (mergesByKey[k] || 0) + v; };
  let recs = dd.records;
  log(`after first de-dupe: ${recs.length} (merged ${merges})`);

  const doiCache = loadDoiCache();
  const noId = recs.filter((r) => r.docType === 'book' && !r.scieloId && r.doi?.startsWith('10.7476/'));
  const toResolve = noId.filter((r) => !doiCache.has(r.doi!)).slice(0, args.maxDoi).map((r) => r.doi!);
  let doiStats = { resolved: 0, failed: 0 };
  if (toResolve.length && !args.skipLanding) {
    log(`resolving ${toResolve.length} DOIs via doi.org ...`);
    doiStats = await resolveDois(toResolve, doiCache);
  }
  for (const r of noId) {
    const hit = doiCache.get(r.doi!);
    if (hit?.id) {
      r.scieloId = hit.id;
      r.scieloUrl = scieloLanding(hit.id);
    }
  }
  report.doiResolution = { candidates: noId.length, requestedThisRun: toResolve.length, ...doiStats };

  dd = dedupe(recs);
  merges += dd.merges;
  addMerges(dd.mergesByKey);
  recs = dd.records;

  const landingCache = loadLandingCache();
  let landingRun = { fetched: 0, ok: 0, failed: 0 };
  let landingCandidates = 0;
  if (!args.skipLanding) {
    const books = recs.filter((r) => r.docType === 'book' && r.scieloId);
    const usable = (id: string) => {
      const c = landingCache.get(id);
      return !(c && (c.ok || c.attempts >= 2 || c.error === 'HTTP 404' || c.error === 'HTTP 410'));
    };
    const needPdf = books.filter((r) => !fullTextPdf(r.pdfUrl)).map((r) => r.scieloId!);
    const needLang = books.filter((r) => fullTextPdf(r.pdfUrl) && !r.language).map((r) => r.scieloId!);
    const queue = [...new Set([...needPdf, ...needLang])].filter(usable);
    landingCandidates = queue.length;
    const batch = queue.slice(0, args.maxLanding);
    if (queue.length > batch.length) {
      skipped.push({ source: 'books.scielo.org landing pages (remainder)', reason: `capped at --max-landing=${args.maxLanding}; ${queue.length - batch.length} more candidates left for a re-run (resumable)` });
    }
    log(`landing pages: ${batch.length} to fetch (${queue.length} candidates; ${needPdf.length} lack a direct PDF)`);
    landingRun = await scrapeLandings(batch, landingCache, (d, n) => log(`landing ${d}/${n}`));
  }
  for (const r of recs) if (r.scieloId) {
    const l = landingCache.get(r.scieloId);
    if (l) applyLanding(r, l);
  }
  report.landing = { cachedTotal: landingCache.size, cachedOk: [...landingCache.values()].filter((l) => l.ok).length, candidates: landingCandidates, ...landingRun };

  dd = dedupe(recs);
  merges += dd.merges;
  addMerges(dd.mergesByKey);
  recs = dd.records;

  /* ---- 6. Rec → Publication through the server sanitizer ---- */
  const legacyOai = legacySeedOai();
  const pubs: Publication[] = [];
  const seenIds = new Set<string>();
  const seenOai = new Map<string, string>();
  const dropped: Record<string, number> = {};
  for (const r of recs) {
    const { pub, reason } = toPublication(r);
    if (!pub) {
      dropped[reason || 'unknown'] = (dropped[reason || 'unknown'] || 0) + 1;
      continue;
    }
    if (seenIds.has(pub.id)) {
      dropped['duplicate-id'] = (dropped['duplicate-id'] || 0) + 1;
      continue;
    }
    // oai_identifier is UNIQUE in D1: never collide with another id (in this batch or the legacy seed)
    const oai = pub.oaiIdentifier ?? pub.id;
    const other = seenOai.get(oai) ?? legacyOai.get(oai);
    if (other && other !== pub.id) pub.oaiIdentifier = pub.id;
    seenOai.set(pub.oaiIdentifier ?? pub.id, pub.id);
    seenIds.add(pub.id);
    pubs.push(pub);
  }
  pubs.sort((a, b) => a.id.localeCompare(b.id));
  const withPdf = pubs.filter((p) => p.pdfUrl);
  log(`publications: ${pubs.length} (full text: ${withPdf.length}, dropped: ${JSON.stringify(dropped)})`);

  /* ---- 7. verification (first 5 bytes only) ---- */
  let sampleReport: Record<string, unknown> = { skipped: true };
  let featured: Publication[] = [];
  const checked = new Map<string, boolean>();
  if (!args.skipVerify && withPdf.length) {
    const cands = pickFeaturedCandidates(pubs, Math.round(args.featured * 1.6));
    log(`verifying ${cands.length} featured candidates ...`);
    for (const c of await checkMany(cands.map((p) => p.pdfUrl!))) checked.set(c.url, c.ok);
    featured = cands.filter((p) => checked.get(p.pdfUrl!)).slice(0, args.featured);

    const shuffled = [...withPdf].sort(() => Math.random() - 0.5).slice(0, args.sample);
    log(`sample-verifying ${shuffled.length} random PDFs ...`);
    const fresh = shuffled.filter((p) => !checked.has(p.pdfUrl!));
    const results = await checkMany(fresh.map((p) => p.pdfUrl!));
    for (const c of results) checked.set(c.url, c.ok);
    const sampleResults = shuffled.map((p) => ({ id: p.id, url: p.pdfUrl!, ok: checked.get(p.pdfUrl!) ?? false }));
    const failedDetail = results.filter((c) => !c.ok).map((c) => ({ url: c.url, detail: c.detail }));
    const coverSample = withPdf.filter((p) => p.coverUrl).sort(() => Math.random() - 0.5).slice(0, 10);
    const coverOk = (await Promise.all(coverSample.map((p) => checkImage(p.coverUrl!)))).filter(Boolean).length;
    sampleReport = {
      sampleSize: sampleResults.length,
      passed: sampleResults.filter((s) => s.ok).length,
      passRate: sampleResults.length ? +(sampleResults.filter((s) => s.ok).length / sampleResults.length).toFixed(3) : null,
      failures: failedDetail.slice(0, 15),
      featuredCandidatesChecked: cands.length,
      featuredCandidatesPassed: cands.filter((p) => checked.get(p.pdfUrl!)).length,
      coverSample: { size: coverSample.length, ok: coverOk }
    };
  } else {
    featured = pickFeaturedCandidates(pubs, args.featured);
  }

  /* ---- 8. write outputs ---- */
  const seedDir = path.join(ROOT_DIR, 'migrations', 'seed');
  const seed = writeSeedChunks(pubs, seedDir, 200);
  const backfill = buildCountryBackfill();
  fs.writeFileSync(path.join(ROOT_DIR, 'migrations', '0004_country_backfill.sql'), backfill.sql, 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'featured.json'), JSON.stringify(featured, null, 2), 'utf8');

  const stripped = pubs.filter((p) => !p.pdfUrl);
  Object.assign(report, {
    perSource,
    skippedSources: skipped,
    quota: quotaNotes,
    dedupe: { inputRecords: all.length, finalRecords: recs.length, merges, mergesByKey },
    sanitizerDropped: dropped,
    totals: {
      publications: pubs.length,
      withFullText: withPdf.length,
      withoutFullText: stripped.length,
      withEpub: pubs.filter((p) => p.epubUrl).length,
      withAbstract: pubs.filter((p) => p.abstract).length
    },
    perCountry: count(pubs, (p) => p.country || 'Internacional'),
    perCountryWithFullText: count(withPdf, (p) => p.country || 'Internacional'),
    perLanguage: count(pubs, (p) => p.language),
    perDocType: count(pubs, (p) => p.docType),
    perArea: count(pubs, (p) => p.oecdArea),
    seed: { chunks: seed.files.length, files: seed.files, maxStatementBytes: seed.maxStatementBytes },
    backfill: { legacyRows: backfill.total, updates: backfill.updated, byCountry: backfill.byCountry },
    featured: { count: featured.length, byCountry: count(featured, (p) => p.country || ''), byLanguage: count(featured, (p) => p.language), byArea: count(featured, (p) => p.oecdArea) },
    pdfSampleVerification: sampleReport,
    http: httpStats,
    elapsedSeconds: Math.round((Date.now() - t0) / 1000),
    cacheDir: path.relative(ROOT_DIR, CACHE_DIR)
  });
  fs.writeFileSync(path.join(OUT_DIR, 'harvest-report.json'), JSON.stringify(report, null, 2), 'utf8');
  log(`done. ${pubs.length} publications → ${seed.files.length} chunks; report: scripts/out/harvest-report.json`);
}

main().catch((err) => {
  console.error('[harvest] FATAL', err);
  process.exit(1);
});
