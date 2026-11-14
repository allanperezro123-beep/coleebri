import type { CitationFormat, Publication } from '../types/publication';

/* ---------- name handling ---------- */

interface PersonName {
  family: string;
  given: string;
}

const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'da', 'das', 'do', 'dos', 'di', 'du', 'van', 'von', 'der', 'le', 'y', 'e']);

/** Handles "Apellido, Nombre", "Nombre Apellido" and single-token names. */
function parsePerson(raw: string): PersonName {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return { family: '', given: '' };
  const comma = clean.indexOf(',');
  if (comma >= 0) {
    return { family: clean.slice(0, comma).trim(), given: clean.slice(comma + 1).trim() };
  }
  const parts = clean.split(' ');
  if (parts.length === 1) return { family: parts[0], given: '' };
  let familyStart = parts.length - 1;
  while (familyStart > 1 && PARTICLES.has(parts[familyStart - 1].toLowerCase())) familyStart--;
  return { family: parts.slice(familyStart).join(' '), given: parts.slice(0, familyStart).join(' ') };
}

function initials(given: string): string {
  return given
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((token) => {
      const letter = Array.from(token.replace(/^[^\p{L}]+/u, ''))[0];
      return letter ? letter.toLocaleUpperCase('es') + '.' : '';
    })
    .filter(Boolean)
    .join(' ');
}

function withTrailingPeriod(text: string): string {
  return /[.!?]$/.test(text) ? text : text + '.';
}

function foldAscii(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/* ---------- identifiers ---------- */

/** Returns an https URL for a DOI given either as "10.xxx/yyy" or as a full URL. */
export function doiUrl(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const trimmed = doi.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^http:\/\//i, 'https://');
  const bare = trimmed.replace(/^doi:\s*/i, '');
  return /^10\.\d{4,9}\//.test(bare) ? 'https://doi.org/' + bare : undefined;
}

function bareDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  return doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '') || undefined;
}

function linkOf(pub: Publication): string {
  return doiUrl(pub.doi) ?? pub.scieloUrl;
}

/* ---------- APA 7 ---------- */

function apaAuthors(pub: Publication): string {
  if (pub.authors.length === 0) return withTrailingPeriod(pub.publisher);
  const names = pub.authors.map((raw) => {
    const { family, given } = parsePerson(raw);
    const ini = initials(given);
    return ini ? family + ', ' + ini : family;
  });
  let joined: string;
  if (names.length === 1) joined = names[0];
  else if (names.length <= 20) joined = names.slice(0, -1).join(', ') + ', & ' + names[names.length - 1];
  else joined = names.slice(0, 19).join(', ') + ', . . . ' + names[names.length - 1];
  return withTrailingPeriod(joined);
}

/* ---------- IEEE ---------- */

function ieeeAuthors(pub: Publication): string {
  if (pub.authors.length === 0) return pub.publisher;
  const names = pub.authors.map((raw) => {
    const { family, given } = parsePerson(raw);
    const ini = initials(given);
    return ini ? ini + ' ' + family : family;
  });
  if (names.length > 6) return names[0] + ' et al.';
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + ' and ' + names[1];
  return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
}

/* ---------- BibTeX ---------- */

const LATEX_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}'
};

export function escapeBibtex(text: string): string {
  return text.replace(/[\\&%$#_{}~^]/g, (ch) => LATEX_ESCAPES[ch] ?? ch);
}

function citeKey(pub: Publication): string {
  const first = pub.authors[0] ? parsePerson(pub.authors[0]).family : '';
  const surname = foldAscii(first).toLowerCase().replace(/[^a-z0-9]/g, '') || 'scielo';
  const word =
    foldAscii(pub.title)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .find((w) => w.length > 3) ?? 'work';
  return surname + (pub.year ?? 'nd') + word;
}

function bibtexEntry(pub: Publication, key: string): string {
  const entryType = pub.docType === 'article' ? 'article' : pub.docType === 'chapter' ? 'incollection' : 'book';
  const authors =
    pub.authors.length > 0
      ? pub.authors
          .map((raw) => {
            const { family, given } = parsePerson(raw);
            return given ? family + ', ' + given : family;
          })
          .map(escapeBibtex)
          .join(' and ')
      : escapeBibtex(pub.publisher);
  const doi = bareDoi(pub.doi);

  const fields = [
    '  author    = {' + authors + '}',
    '  title     = {{' + escapeBibtex(pub.title) + '}}',
    pub.docType === 'article'
      ? '  journal   = {' + escapeBibtex(pub.publisher) + '}'
      : '  publisher = {' + escapeBibtex(pub.publisher) + '}',
    pub.year ? '  year      = {' + pub.year + '}' : null,
    pub.isbn ? '  isbn      = {' + escapeBibtex(pub.isbn) + '}' : null,
    doi ? '  doi       = {' + escapeBibtex(doi) + '}' : null,
    pub.scieloUrl ? '  url       = {' + pub.scieloUrl.replace(/[{}\\]/g, encodeURIComponent) + '}' : null,
    '  language  = {' + pub.language + '}'
  ].filter((f): f is string => f !== null);

  return '@' + entryType + '{' + key + ',\n' + fields.join(',\n') + '\n}';
}

/** Several entries in one .bib file, de-duplicating cite keys with a/b/c suffixes. */
export function formatBibtexCollection(pubs: Publication[]): string {
  const used = new Map<string, number>();
  return pubs
    .map((pub) => {
      const base = citeKey(pub);
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      const key = count === 0 ? base : base + String.fromCharCode(96 + Math.min(count, 26));
      return bibtexEntry(pub, key);
    })
    .join('\n\n');
}

/* ---------- public API ---------- */

export function formatCitation(pub: Publication, format: CitationFormat): string {
  const link = linkOf(pub);
  const linkPart = link ? ' ' + link : '';

  if (format === 'apa7') {
    const year = pub.year ? String(pub.year) : 's. f.';
    return apaAuthors(pub) + ' (' + year + '). ' + withTrailingPeriod(pub.title) + ' ' + withTrailingPeriod(pub.publisher) + linkPart;
  }

  if (format === 'ieee') {
    const year = pub.year ? String(pub.year) : 's. f.';
    const authors = ieeeAuthors(pub);
    const tail = link ? ' [En línea]. Disponible: ' + link : '';
    if (pub.docType === 'article') {
      const title = pub.title.replace(/[.,]+$/, '');
      return authors + ', "' + title + ',"' + ' ' + pub.publisher + ', ' + year + '.' + tail;
    }
    return authors + ', ' + withTrailingPeriod(pub.title) + ' ' + pub.publisher + ', ' + year + '.' + tail;
  }

  return bibtexEntry(pub, citeKey(pub));
}
