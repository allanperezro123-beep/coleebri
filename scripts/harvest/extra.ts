/**
 * Coleebri "extra" harvester — Dialnet, DOAB/OAPEN, Redalyc, UPN repository, CLACSO (resumable, polite).
 *
 *   npm run harvest:extra -- [--sources=dialnet,redalyc,doab,upn,clacso]
 *       [--max-dialnet=15000 --max-doab=15000 --max-redalyc=10000 --max-upn=5000 --max-clacso=5000]
 *       [--max-doab-en=3000] [--doab-pages=800] [--dialnet-scan-factor=2] [--sample=25] [--skip-verify] [--fresh]
 *
 * Writes (never touches any remote database):
 *   scripts/out/seed-extra/<source>_NNN.sql   chunks of <= 200 rows (idempotent UPSERT incl. search_text)
 *   scripts/out/extra-report.json             per-source report, host allowlist, totals
 * Cache / cursors: scripts/.harvest-cache/ (keys `extra:*`, files `extra-*.jsonl`). `--fresh` only wipes those.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Publication } from '../../src/types/publication';
import { CACHE_DIR, OUT_DIR, ensureDirs, loadState, saveState } from './cache';
import { stats as httpStats } from './http';
import type { Rec } from './model';
import {
  EXTRA_OUT_DIR,
  dedupeKeys,
  hostOf,
  loadExistingKeys,
  pdfPassRate,
  probeImageSize,
  sampleRandom,
  toExtraPublication,
  writeExtraChunks,
  type SourceReport,
  type SourceResult
} from './extra/common';
import { harvestClacso } from './extra/clacso';
import { harvestDialnet } from './extra/dialnet';
import { harvestDoab } from './extra/doab';
import { harvestOaBooks, harvestOaJournals } from './extra/openalex-social';
import { harvestRedalyc } from './extra/redalyc';
import { harvestUpn } from './extra/upn';

function parseArgs(argv: string[]) {
  const val = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const num = (name: string, fallback: number) => {
    const raw = val(name);
    const v = Number(raw);
    return raw !== undefined && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    sources: new Set((val('sources') || 'dialnet,redalyc,doab,upn,clacso,oa-books,oa-journals').split(',').map((s) => s.trim()).filter(Boolean)),
    maxDialnet: num('max-dialnet', 15_000),
    maxDoab: num('max-doab', 15_000),
    maxRedalyc: num('max-redalyc', 10_000),
    maxUpn: num('max-upn', 5_000),
    maxClacso: num('max-clacso', 5_000),
    maxOaBooks: num('max-oa-books', 4_500),
    maxOaJournals: num('max-oa-journals', 4_000),
    maxDoabEn: num('max-doab-en', 3_000),
    doabPages: num('doab-pages', 800),
    dialnetScanFactor: num('dialnet-scan-factor', 2),
    sample: num('sample', 25),
    skipVerify: argv.includes('--skip-verify'),
    fresh: argv.includes('--fresh')
  };
}

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${msg}`);

function wipeExtraCache(): void {
  const state = loadState();
  for (const k of Object.keys(state)) if (k.startsWith('extra:')) delete state[k];
  saveState(state);
  for (const f of fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : []) if (/^extra-.*\.jsonl$/.test(f)) fs.rmSync(path.join(CACHE_DIR, f));
}

function tally<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDirs();
  fs.mkdirSync(EXTRA_OUT_DIR, { recursive: true });
  if (args.fresh) {
    wipeExtraCache();
    log('--fresh: extra cache wiped (SciELO cache untouched)');
  }
  if (process.env.HARVEST_CONTACT_EMAIL) log('NOTE: HARVEST_CONTACT_EMAIL is set; it would be appended to the User-Agent. Unset it to keep the contact private.');

  /* ---- 1. harvest every source (different hosts => safe to overlap; per-host delay lives in http.ts) ---- */
  const jobs: Array<{ code: string; run: () => Promise<SourceResult> }> = [];
  if (args.sources.has('upn')) jobs.push({ code: 'upn', run: () => harvestUpn({ cap: args.maxUpn, log }) });
  if (args.sources.has('doab')) jobs.push({ code: 'doab', run: () => harvestDoab({ cap: args.maxDoab, capEnglish: args.maxDoabEn, doabPages: args.doabPages, log }) });
  if (args.sources.has('dialnet')) jobs.push({ code: 'dialnet', run: () => harvestDialnet({ cap: args.maxDialnet, scanFactor: args.dialnetScanFactor, log }) });
  if (args.sources.has('redalyc')) jobs.push({ code: 'redalyc', run: () => harvestRedalyc({ cap: args.maxRedalyc, log }) });
  if (args.sources.has('clacso')) jobs.push({ code: 'clacso', run: () => harvestClacso() });
  if (args.sources.has('oa-books')) jobs.push({ code: 'oa-books', run: () => harvestOaBooks({ cap: args.maxOaBooks, log }) });
  if (args.sources.has('oa-journals')) jobs.push({ code: 'oa-journals', run: () => harvestOaJournals({ cap: args.maxOaJournals, log }) });

  const settled = await Promise.all(
    jobs.map(async (j) => {
      try {
        return { code: j.code, result: await j.run() };
      } catch (err) {
        const report: SourceReport = { source: j.code, endpoint: '-', status: 'dropped', note: `crashed: ${(err as Error).message}`, harvested: 0 };
        return { code: j.code, result: { report, records: [], allow: /^$/ } as SourceResult };
      }
    })
  );
  log('harvest phase finished');

  /* ---- 2. convert, de-duplicate, verify, write ---- */
  const existing = loadExistingKeys();
  log(`existing catalog keys loaded: ${existing.size}`);
  const order = ['upn', 'doab', 'dialnet', 'redalyc', 'clacso', 'oa-books', 'oa-journals'];
  const seenKeys = new Set(existing);
  const finalByCode: Record<string, Publication[]> = {};
  const hostLines = { landing: new Set<string>(), pdf: new Set<string>(), cover: new Set<string>() };
  const dupStats: Record<string, { duplicatesDropped: number; rejected: number }> = {};
  const reports: SourceReport[] = [];
  const coverProbe: Record<string, string> = {};

  for (const code of order) {
    const item = settled.find((s) => s.code === code);
    if (!item) continue;
    const { result } = item;
    const rep = result.report;
    reports.push(rep);
    const pubs: Publication[] = [];
    let dups = 0;
    let rejected = 0;
    for (const rec of result.records as Rec[]) {
      const keys = dedupeKeys(rec);
      if (keys.some((k) => seenKeys.has(k))) {
        dups += 1;
        continue;
      }
      const pub = toExtraPublication(rec, result.allow, [], Boolean(result.allowNonExtPdf));
      if (!pub) {
        rejected += 1;
        continue;
      }
      keys.forEach((k) => seenKeys.add(k));
      pubs.push(pub);
    }
    dupStats[code] = { duplicatesDropped: dups, rejected };

    if (pubs.length && !args.skipVerify) {
      rep.pdfSample = await pdfPassRate(pubs.map((p) => p.pdfUrl!), args.sample);
      log(`${rep.source}: PDF sample ${rep.pdfSample.ok}/${rep.pdfSample.tested}`);
      if (rep.pdfSample.rate < 0.7) {
        rep.status = 'dropped';
        rep.note += ` DROPPED: PDF pass rate ${(rep.pdfSample.rate * 100).toFixed(0)}% < 70% (${rep.pdfSample.failures.join('; ')}).`;
        pubs.length = 0;
      }
    }
    if (pubs.some((p) => p.coverUrl)) {
      const covers = sampleRandom(pubs.filter((p) => p.coverUrl).map((p) => p.coverUrl!), 3);
      const sizes = [];
      for (const c of covers) {
        const s = await probeImageSize(c);
        sizes.push(s.ok ? `${s.type} ${s.width ?? '?'}x${s.height ?? '?'}` : `unavailable (${s.detail})`);
      }
      coverProbe[code] = sizes.join(', ');
    }

    rep.harvested = pubs.length;
    finalByCode[code] = pubs;
    for (const p of pubs) {
      for (const [bucket, url] of [['landing', p.scieloUrl], ['pdf', p.pdfUrl], ['cover', p.coverUrl]] as const) {
        const h = hostOf(url);
        if (h) hostLines[bucket].add(h);
      }
    }
    if (pubs.length) {
      const w = writeExtraChunks(code, pubs);
      log(`${rep.source}: ${pubs.length} rows → ${w.files.length} chunk(s), max statement ${w.maxStatementBytes} bytes`);
      if (w.maxStatementBytes > 90_000) log(`WARNING: statement over 90 KB in ${code}`);
    } else {
      writeExtraChunks(code, []); // clears stale chunks of a previous run
    }
  }

  /* ---- 3. report ---- */
  const all = Object.values(finalByCode).flat();
  const hostRegexLines = [...new Set([...hostLines.landing, ...hostLines.pdf, ...hostLines.cover])].sort().map((h) => `^${h.replace(/\./g, '\\.')}$`);
  const summary = {
    generatedAt: new Date().toISOString(),
    args: { ...args, sources: [...args.sources] },
    totals: {
      rows: all.length,
      withPdf: all.filter((p) => p.pdfUrl).length,
      withCover: all.filter((p) => p.coverUrl).length,
      byCollectionCode: tally(all, (p) => p.collectionCode),
      byLanguage: tally(all, (p) => p.language),
      byDocType: tally(all, (p) => p.docType),
      byCountryTop10: Object.fromEntries(Object.entries(tally(all, (p) => p.country || 'Internacional')).slice(0, 10))
    },
    reports,
    dupStats,
    coverProbe,
    hosts: { landing: [...hostLines.landing].sort(), pdf: [...hostLines.pdf].sort(), cover: [...hostLines.cover].sort(), regexLines: hostRegexLines },
    http: httpStats,
    elapsedSec: Math.round((Date.now() - t0) / 1000)
  };
  fs.writeFileSync(path.join(OUT_DIR, 'extra-report.json'), JSON.stringify(summary, null, 2));
  log(`done: ${all.length} rows in ${summary.elapsedSec}s — report: scripts/out/extra-report.json`);
  console.log(JSON.stringify({ totals: summary.totals, reports: reports.map((r) => ({ source: r.source, status: r.status, harvested: r.harvested, pdf: r.pdfSample && `${r.pdfSample.ok}/${r.pdfSample.tested}`, note: r.note.slice(0, 300) })), hosts: hostRegexLines }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
