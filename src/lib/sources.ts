/**
 * Repositories ("colecciones de origen") the catalogue is harvested from.
 *
 * The API exposes them as the `collections` facet (`{ value, label, count }`). This module maps
 * the raw codes to a display label, a one-line description and an optional accent. Unknown codes
 * fall back to the label the API sent, so a new repository never breaks the UI.
 */

export interface SourceInfo {
  /** Stable code as stored in the catalogue (`collectionCode`). */
  code: string;
  /** Full name, used in lists and the preview. */
  label: string;
  /** Short name, used on covers and in compact chips. */
  short: string;
  /** What the repository is, in one sentence. */
  description: string;
  /** Optional identity colour (graphic use only; never for text). */
  accent?: string;
}

const SOURCES: Record<string, Omit<SourceInfo, 'code'>> = {
  books: {
    label: 'SciELO Books',
    short: 'SciELO Books',
    description: 'Libros académicos de editoriales universitarias de Iberoamérica.'
  },
  dialnet: {
    label: 'Dialnet',
    short: 'Dialnet',
    description: 'Portal de la Universidad de La Rioja con artículos, tesis y libros en español.'
  },
  doab: {
    label: 'DOAB',
    short: 'DOAB',
    description: 'Directory of Open Access Books: libros arbitrados de acceso abierto.'
  },
  redalyc: {
    label: 'Redalyc',
    short: 'Redalyc',
    description: 'Red de revistas científicas de América Latina, el Caribe, España y Portugal.'
  },
  upn: {
    label: 'Repositorio UPN',
    short: 'Repositorio UPN',
    description: 'Producción de la Universidad Pedagógica Nacional de Colombia.',
    accent: '#1758C4'
  },
  clacso: {
    label: 'CLACSO',
    short: 'CLACSO',
    description: 'Biblioteca virtual del Consejo Latinoamericano de Ciencias Sociales.'
  },
  'oa-books': {
    label: 'Libros Ciencias Sociales OA',
    short: 'Ciencias Sociales OA',
    description: 'Libros universitarios y de ciencias sociales de Cambridge, LSE, UNAD Colombia y editoriales abiertas.'
  },
  'oa-journals': {
    label: 'Revistas científicas OA',
    short: 'Revistas OA',
    description: 'Artículos arbitrados de revistas científicas iberoamericanas (Ciencia Latina, INAP y UPSA).'
  }
};

/** Order in which the quick-filter chips are shown. */
export const SOURCE_ORDER = ['books', 'doab', 'oa-books', 'redalyc', 'oa-journals', 'dialnet', 'upn', 'clacso'] as const;

const SCIELO_PREFIX = 'scielo-';

/** Journal collections of SciELO (`scielo-col`, `scielo-mex`, …). */
export function isScieloJournalCode(code: string): boolean {
  return code.startsWith(SCIELO_PREFIX);
}

/** Resolves a collection code (and, optionally, the label the API gave it) to display info. */
export function sourceInfo(code: string | undefined | null, fallbackLabel?: string): SourceInfo {
  const key = (code ?? '').trim().toLowerCase();
  const known = SOURCES[key];
  if (known) return { code: key, ...known };

  const label = fallbackLabel?.trim() || key || 'SciELO';
  if (isScieloJournalCode(key)) {
    return {
      code: key,
      label,
      short: label,
      description: 'Revistas científicas de la colección regional de SciELO.'
    };
  }
  return { code: key, label, short: label, description: '' };
}
