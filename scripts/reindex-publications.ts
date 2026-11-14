/**
 * Re-indexes stored publications (idempotent, safe to re-run):
 *  1. fills `search_text` (migration 0005) where NULL, so search ignores accents/case
 *     ("educacion" finds "Educación");
 *  2. re-classifies `country` when STRONG evidence (ISBN group — falling back to the ISBN inside
 *     a 10.7476 DOI —, regional SciELO host or publisher) disagrees with the stored value.
 *
 *   tsx scripts/reindex-publications.ts --local [--persist-to=DIR]
 *   tsx scripts/reindex-publications.ts --remote      # PRODUCTION D1 — run it yourself, deliberately
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSearchText } from '../functions/security';
import { strongCountrySignal } from '../src/lib/taxonomy';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const remote = args.includes('--remote');
const local = args.includes('--local');
if (remote === local) {
  console.error('Usage: tsx scripts/reindex-publications.ts --local | --remote');
  process.exit(2);
}
const dbName = args.find((a) => a.startsWith('--db='))?.split('=')[1] || 'coleebri-db';
const persist = args.find((a) => a.startsWith('--persist-to='));
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const target = remote ? ['--remote'] : ['--local', ...(persist ? [persist] : [])];
const PAGE = 400;

interface Row {
  id: string;
  title: string;
  subtitle: string | null;
  authors_json: string;
  publisher: string;
  abstract: string | null;
  keywords_json: string;
  doi: string | null;
  isbn: string | null;
}

function wranglerJson<T = Row>(command: string): T[] {
  const res = spawnSync(process.execPath, [wrangler, 'd1', 'execute', dbName, ...target, '--json', `--command=${command}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status ?? 1);
  }
  const parsed = JSON.parse(res.stdout) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

function parseList(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

function applyStatements(statements: string[]): void {
  const file = path.join(tmpDir, 'reindex-batch.sql');
  fs.writeFileSync(file, statements.join('\n'), 'utf8');
  const res = spawnSync(process.execPath, [wrangler, 'd1', 'execute', dbName, ...target, `--file=${path.relative(root, file).split(path.sep).join('/')}`], {
    cwd: root,
    stdio: 'inherit'
  });
  if (res.status !== 0) {
    console.error('FAILED applying a reindex batch; re-run to continue (idempotent).');
    process.exit(res.status ?? 1);
  }
}
const tmpDir = path.join(root, 'scripts', '.harvest-cache');
fs.mkdirSync(tmpDir, { recursive: true });

let total = 0;
for (;;) {
  const rows = wranglerJson(
    `SELECT id, title, subtitle, authors_json, publisher, abstract, keywords_json, doi, isbn FROM publications WHERE search_text IS NULL LIMIT ${PAGE}`
  );
  if (rows.length === 0) break;
  const statements = rows.map((row) => {
    const text = buildSearchText({
      title: row.title,
      subtitle: row.subtitle ?? undefined,
      authors: parseList(row.authors_json),
      publisher: row.publisher,
      abstract: row.abstract ?? undefined,
      keywords: parseList(row.keywords_json),
      doi: row.doi ?? undefined,
      isbn: row.isbn ?? undefined
    });
    // Never leave NULL behind (would loop forever): empty index still marks the row as done.
    return `UPDATE publications SET search_text = ${sqlString(text || ' ')} WHERE id = ${sqlString(row.id)};`;
  });
  applyStatements(statements);
  total += rows.length;
  console.log(`  indexed ${total} rows…`);
}
console.log(`Search index complete (${total} rows updated).`);

// ---- 2. country re-classification from strong evidence ----
interface CountryRow {
  id: string;
  isbn: string | null;
  doi: string | null;
  publisher: string | null;
  scielo_url: string | null;
  pdf_url: string | null;
  country: string | null;
}
const isbnFromDoi = (doi: string | null) => {
  const m = /^10\.7476\/(97[89]\d{10})$/.exec((doi || '').trim());
  return m ? m[1] : null;
};
let reclassified = 0;
for (let offset = 0; ; offset += 1000) {
  const rows = wranglerJson<CountryRow>(
    `SELECT id, isbn, doi, publisher, scielo_url, pdf_url, country FROM publications ORDER BY id LIMIT 1000 OFFSET ${offset}`
  );
  if (rows.length === 0) break;
  const updates: string[] = [];
  for (const row of rows) {
    const strong = strongCountrySignal({
      isbn: [row.isbn, isbnFromDoi(row.doi)].filter(Boolean).join(' ') || null,
      scieloUrl: row.scielo_url,
      pdfUrl: row.pdf_url,
      publisher: row.publisher
    });
    if (strong && strong !== row.country) {
      updates.push(`UPDATE publications SET country = ${sqlString(strong)} WHERE id = ${sqlString(row.id)};`);
    }
  }
  if (updates.length > 0) applyStatements(updates);
  reclassified += updates.length;
  if (rows.length < 1000) break;
}
console.log(`Country re-classification complete (${reclassified} rows changed, ${remote ? 'REMOTE' : 'local'}).`);
