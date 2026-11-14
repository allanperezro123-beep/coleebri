import type { Publication } from '../types/publication';
import { normalizePublications } from './publication';

let cached: Promise<Publication[]> | null = null;

/**
 * The bundled catalogue (~230 kB) is only downloaded when the server API is unavailable
 * (plain `vite` dev, offline first visit, no database), so it stays out of the main bundle.
 */
export function loadSeedCatalog(): Promise<Publication[]> {
  if (!cached) {
    cached = import('../data/seedCatalog.json').then((module) => normalizePublications(module.default as unknown));
    cached.catch(() => {
      cached = null; // allow a retry after a failed chunk load
    });
  }
  return cached;
}
