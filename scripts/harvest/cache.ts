/**
 * Resumable on-disk cache. Everything lives in scripts/.harvest-cache/ (git-ignored):
 *   state.json            cursors / done-flags per source
 *   <name>.jsonl          append-only normalized records (one JSON per line)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = path.resolve(HERE, '..');
export const ROOT_DIR = path.resolve(SCRIPTS_DIR, '..');
export const CACHE_DIR = path.join(SCRIPTS_DIR, '.harvest-cache');
export const OUT_DIR = path.join(SCRIPTS_DIR, 'out');

export function ensureDirs(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

export function resetCache(): void {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  ensureDirs();
}

export function readJsonl<T>(name: string): T[] {
  const file = path.join(CACHE_DIR, `${name}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn last line after a crash: ignore it, the record is re-fetched on the next run
    }
  }
  return out;
}

export function appendJsonl(name: string, items: unknown[]): void {
  if (!items.length) return;
  fs.appendFileSync(path.join(CACHE_DIR, `${name}.jsonl`), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
}

export interface SourceState {
  cursor?: string | null;
  done?: boolean;
  count?: number;
  note?: string;
}
export type HarvestState = Record<string, SourceState>;

const STATE_FILE = () => path.join(CACHE_DIR, 'state.json');

export function loadState(): HarvestState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) as HarvestState;
  } catch {
    return {};
  }
}

export function saveState(state: HarvestState): void {
  const tmp = `${STATE_FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE());
}
