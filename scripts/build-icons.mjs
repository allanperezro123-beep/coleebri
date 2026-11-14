// Generates the favicon (SVG) and PWA / Apple icons (PNG) from `public/coleebri-logo.svg`.
// Run: node scripts/build-icons.mjs   (needs `sharp`, already used by scripts/build-covers.ts)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logoCandidates = [path.join(root, 'public/coleebri-logo.svg'), path.join(root, '../coleebri logo.svg')];
const logoPath = logoCandidates.find((p) => fs.existsSync(p));
if (!logoPath) throw new Error('Missing coleebri-logo.svg source');

const raw = fs.readFileSync(logoPath, 'utf8');
const defsMatch = raw.match(/<defs>[\s\S]*?<\/defs>/);
const iconMatch = raw.match(/<g id="coleebri-icon"[\s\S]*?<\/g>\s*(?=<!--.*?LOGOTIPO|<g id="coleebri-wordmark"|<\/svg>)/);
if (!defsMatch || !iconMatch) throw new Error('Could not parse <defs> or #coleebri-icon from coleebri logo.svg');

const defs = defsMatch[0];
const icon = iconMatch[0];
const IVORY = '#FAF9F6';
const NAVY = '#092E63';

// Tile & maskable centered cleanly around #coleebri-icon center (512, 441).
const fitTile = 'translate(50 50) scale(0.140) translate(-512 -441)';
const fitMaskable = 'translate(50 50) scale(0.116) translate(-512 -441)';

const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${defs}${inner}</svg>`;

const tile = wrap(
  `<rect x="1.5" y="1.5" width="97" height="97" rx="22" fill="${IVORY}" stroke="${NAVY}" stroke-opacity="0.14" stroke-width="2.5"/><g transform="${fitTile}">${icon}</g>`
);
const maskable = wrap(`<rect width="100" height="100" fill="${IVORY}"/><g transform="${fitMaskable}">${icon}</g>`);

fs.writeFileSync(path.join(root, 'public/favicon.svg'), tile + '\n');
const out = path.join(root, 'public/icons');
fs.mkdirSync(out, { recursive: true });
await sharp(Buffer.from(tile)).resize(192, 192).png().toFile(path.join(out, 'icon-192.png'));
await sharp(Buffer.from(tile)).resize(512, 512).png().toFile(path.join(out, 'icon-512.png'));
await sharp(Buffer.from(maskable)).resize(512, 512).png().toFile(path.join(out, 'maskable-512.png'));
await sharp(Buffer.from(maskable)).resize(180, 180).png().toFile(path.join(out, 'apple-touch-icon.png'));
await sharp(Buffer.from(tile)).resize(32, 32).png().toFile(path.join(out, 'favicon-32.png'));
console.log('icons written to public/favicon.svg and public/icons/');
