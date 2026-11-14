/**
 * Applies migrations/seed/seed_*.sql to D1 one file at a time (Windows-safe: no shell globbing).
 *
 *   tsx scripts/apply-seed-chunks.ts --local     # local D1 (safe, for validation)
 *   tsx scripts/apply-seed-chunks.ts --remote    # PRODUCTION D1 — run it yourself, deliberately
 *
 * Chunks are idempotent UPSERTs (ON CONFLICT(id) DO UPDATE), so a failed run can simply be re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const remote = args.includes('--remote');
const local = args.includes('--local');
if (remote === local) {
  console.error('Usage: tsx scripts/apply-seed-chunks.ts --local | --remote');
  process.exit(2);
}
const dbName = (args.find((a) => a.startsWith('--db='))?.split('=')[1]) || 'coleebri-db';
const persist = args.find((a) => a.startsWith('--persist-to='));
const dir = path.join(root, 'migrations', 'seed');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^seed_\d+\.sql$/.test(f)).sort() : [];
if (!files.length) {
  console.error(`No chunks found in ${dir}. Run "npm run harvest" first.`);
  process.exit(1);
}
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
console.log(`Applying ${files.length} chunk(s) to ${dbName} (${remote ? 'REMOTE' : 'local'})`);

let i = 0;
for (const f of files) {
  i += 1;
  const rel = path.posix.join('migrations', 'seed', f);
  const res = spawnSync(process.execPath, [wrangler, 'd1', 'execute', dbName, remote ? '--remote' : '--local', `--file=${rel}`, ...(persist && !remote ? [persist] : [])], {
    cwd: root,
    stdio: 'inherit'
  });
  if (res.status !== 0) {
    console.error(`\nFAILED on ${f} (${i}/${files.length}). Fix and re-run; chunks are idempotent.`);
    process.exit(res.status ?? 1);
  }
  console.log(`  ok ${f} (${i}/${files.length})`);
}
console.log('All chunks applied.');
