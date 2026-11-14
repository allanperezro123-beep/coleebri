/**
 * Builds sharp, lightweight cover images for SciELO Books.
 *
 * SciELO only publishes a 111×160 thumbnail (blurry on any modern screen) and a ~750 KB
 * 2000×2875 original. We download the original ONCE, and emit two WebP renditions that the
 * catalogue serves as static assets (free, CDN-cached, immutable):
 *
 *   public/covers/<bookId>-320.webp   (~10-15 KB, cards on phones / 1x)
 *   public/covers/<bookId>-640.webp   (~25-40 KB, 2x screens and the preview drawer)
 *
 * Originals are cached in scripts/.harvest-cache/covers-src/ so re-runs are incremental.
 * `public/covers/` is git-ignored: it is regenerated before each deploy (`predeploy`).
 *
 *   tsx scripts/build-covers.ts [--source=remote|local] [--persist-to=DIR] [--concurrency=4] [--max=N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const source = arg('source') === 'local' ? 'local' : 'remote';
const persist = arg('persist-to');
const concurrency = Math.min(8, Math.max(1, Number(arg('concurrency') || 4)));
const max = Number(arg('max') || Infinity);

const srcDir = path.join(root, 'scripts', '.harvest-cache', 'covers-src');
const outDir = path.join(root, 'public', 'covers');
fs.mkdirSync(srcDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

type Sharp = typeof import('sharp');
let sharp: Sharp;
try {
  sharp = (await import('sharp')).default as unknown as Sharp;
} catch {
  console.error('This script needs "sharp" (npm i -D sharp).');
  process.exit(1);
}

function listBookIds(): string[] {
  const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const target = source === 'remote' ? ['--remote'] : ['--local', ...(persist ? [`--persist-to=${persist}`] : [])];
  const res = spawnSync(
    process.execPath,
    [wrangler, 'd1', 'execute', 'coleebri-db', ...target, '--json', "--command=SELECT id FROM publications WHERE id LIKE 'scielo-book-%' ORDER BY id"],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(1);
  }
  const rows = (JSON.parse(res.stdout) as Array<{ results?: Array<{ id: string }> }>)[0]?.results ?? [];
  return rows
    .map((r) => r.id.replace(/^scielo-book-/, ''))
    .filter((id) => /^[a-z0-9]{2,20}$/i.test(id));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function download(bookId: string): Promise<Buffer | null> {
  const cached = path.join(srcDir, `${bookId}.jpg`);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 1024) return fs.readFileSync(cached);
  const url = `https://books.scielo.org/id/${bookId}/cover/cover.jpeg`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Coleebri-Covers/1.0 (+https://coleebri.pages.dev)' },
        signal: AbortSignal.timeout(45_000)
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > 15 * 1024 * 1024) return null;
      fs.writeFileSync(cached, buf);
      return buf;
    } catch {
      await sleep(1000 * 2 ** attempt + Math.random() * 500);
    }
  }
  return null;
}

async function render(bookId: string, original: Buffer): Promise<boolean> {
  try {
    for (const width of [320, 640]) {
      const out = path.join(outDir, `${bookId}-${width}.webp`);
      if (fs.existsSync(out)) continue;
      await sharp(original, { failOn: 'none' })
        .rotate()
        .resize({ width, withoutEnlargement: false })
        .sharpen({ sigma: 0.5 })
        .webp({ quality: width === 320 ? 72 : 70, effort: 5 })
        .toFile(out);
    }
    return true;
  } catch {
    return false;
  }
}

const ids = listBookIds().slice(0, max);
const todo = ids.filter((id) => !fs.existsSync(path.join(outDir, `${id}-640.webp`)));
console.log(`${ids.length} SciELO books, ${todo.length} covers to build (source=${source}, concurrency=${concurrency})`);

let done = 0;
let missing = 0;
let failed = 0;
let cursor = 0;
async function worker() {
  while (cursor < todo.length) {
    const id = todo[cursor];
    cursor += 1;
    const original = await download(id);
    if (!original) missing += 1;
    else if (!(await render(id, original))) failed += 1;
    done += 1;
    if (done % 100 === 0) console.log(`  ${done}/${todo.length} (missing ${missing}, failed ${failed})`);
    await sleep(250);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.webp'));
const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(outDir, f)).size, 0);
console.log(`Covers ready: ${files.length / 2} books, ${(bytes / 1024 / 1024).toFixed(1)} MB in public/covers (missing ${missing}, failed ${failed}).`);
