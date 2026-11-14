import type { Publication } from '../types/publication';

/** Lowercase + strip diacritics so "García" matches "garcia" and "educación" matches "EDUCACION". */
export function fold(input: string): string {
  return input.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * Splits a query into folded words. Punctuation is dropped except the characters that appear in
 * identifiers (DOI "10.7476/abc", ISBN "978-65-...") so those still match as one token.
 */
export function queryTokens(query: string): string[] {
  return fold(query)
    .replace(/[^\p{L}\p{N}./:_-]+/gu, ' ')
    .split(' ')
    .map((t) => t.replace(/^[./:_-]+|[./:_-]+$/g, ''))
    .filter(Boolean);
}

const haystackCache = new WeakMap<Publication, string>();
const titleCache = new WeakMap<Publication, string>();

/** Normalised text of everything searchable, computed once per publication object. */
export function haystackOf(p: Publication): string {
  let cached = haystackCache.get(p);
  if (cached === undefined) {
    cached = fold(
      [p.title, p.subtitle ?? '', p.authors.join(' '), p.publisher, p.doi ?? '', p.isbn ?? '', p.keywords.join(' '), p.abstract].join(' ')
    );
    haystackCache.set(p, cached);
  }
  return cached;
}

export function foldedTitleOf(p: Publication): string {
  let cached = titleCache.get(p);
  if (cached === undefined) {
    cached = fold(p.title);
    titleCache.set(p, cached);
  }
  return cached;
}

export function matchesTokens(haystack: string, tokens: string[]): boolean {
  for (const token of tokens) {
    if (!haystack.includes(token)) return false;
  }
  return true;
}
