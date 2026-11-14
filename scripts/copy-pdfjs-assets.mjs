// Copies pdf.js runtime data (CMaps, standard fonts, wasm decoders, ICC profiles) into
// public/pdfjs/ so they are served same-origin (CSP `connect-src 'self'`). Without them,
// scanned books with JPEG2000/JBIG2 images, CJK text or non-embedded fonts render badly.
// Runs automatically before `dev` and `build`; the output folder is git-ignored.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', 'pdfjs-dist');
const target = path.join(root, 'public', 'pdfjs');

for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const from = path.join(source, dir);
  if (!fs.existsSync(from)) {
    console.warn(`[pdfjs-assets] missing ${from}, skipped`);
    continue;
  }
  fs.cpSync(from, path.join(target, dir), { recursive: true });
}
console.log('[pdfjs-assets] copied to public/pdfjs');
