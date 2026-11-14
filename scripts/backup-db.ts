/**
 * Full SQL backup of the D1 database, compatible with the FTS5 index.
 *
 * `wrangler d1 export` refuses databases that contain virtual tables, so this script:
 *   1. drops the FTS5 index + triggers (the API transparently falls back to LIKE search),
 *   2. exports schema + data to ../backups/coleebri-db-<timestamp>.sql (outside the repo),
 *   3. recreates and rebuilds the index from migrations/0006_fts.sql.
 *
 *   tsx scripts/backup-db.ts --remote          # production (run deliberately)
 *   tsx scripts/backup-db.ts --local [--persist-to=DIR]
 *
 * If step 2 fails, step 3 still runs. Cloudflare D1 Time Travel is an additional safety net.
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
  console.error('Usage: tsx scripts/backup-db.ts --local | --remote');
  process.exit(2);
}
const persist = args.find((a) => a.startsWith('--persist-to='));
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const target = remote ? ['--remote'] : ['--local', ...(persist ? [persist] : [])];
if (persist) {
  // `wrangler d1 export` has no --persist-to: exporting would silently read another local DB.
  console.error('--persist-to is not supported by `wrangler d1 export`; use the default local state or --remote.');
  process.exit(2);
}

function wranglerRun(extra: string[]): boolean {
  const res = spawnSync(process.execPath, [wrangler, 'd1', ...extra], { cwd: root, stdio: 'inherit' });
  return res.status === 0;
}

const backupsDir = path.resolve(root, '..', 'backups');
fs.mkdirSync(backupsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(backupsDir, `coleebri-db-${remote ? 'remote' : 'local'}-${stamp}.sql`);

console.log('1/3 Dropping FTS index (search falls back to LIKE meanwhile)…');
wranglerRun([
  'execute',
  'coleebri-db',
  ...target,
  '--command=DROP TRIGGER IF EXISTS publications_fts_ai; DROP TRIGGER IF EXISTS publications_fts_ad; DROP TRIGGER IF EXISTS publications_fts_au; DROP TABLE IF EXISTS publications_fts;'
]);

console.log(`2/3 Exporting to ${output}…`);
const exported = wranglerRun(['export', 'coleebri-db', ...target, `--output=${output}`]);

console.log('3/3 Recreating FTS index…');
const rebuilt = wranglerRun(['execute', 'coleebri-db', ...target, '--file=migrations/0006_fts.sql']);

if (!exported || !rebuilt) {
  console.error(`Backup ${exported ? 'OK' : 'FAILED'}, index ${rebuilt ? 'OK' : 'FAILED — re-run: wrangler d1 execute coleebri-db --file=migrations/0006_fts.sql'}`);
  process.exit(1);
}
console.log(`Done. Backup: ${output} (${(fs.statSync(output).size / 1024 / 1024).toFixed(1)} MB)`);
