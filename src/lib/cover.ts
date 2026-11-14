import { buildCoverProxyUrl } from './pdfWorker';
import { safeExternalUrl, trustedContentUrl } from './safeUrl';
import type { Publication } from '../types/publication';

/**
 * Cover resolution chain (best first):
 *   1. `local`  – static WebP renditions generated at build time: /covers/<bookId>-320.webp and
 *                 -640.webp, for every `scielo-book-<bookId>` publication (SciELO only ships a
 *                 111×160 px thumbnail, which looks blurry once upscaled);
 *   2. `remote` – the publication's own cover when it is a trusted https raster image;
 *   3. nothing  – the caller draws the typographic cover.
 */

export type CoverVariant = 'grid' | 'list' | 'drawer' | 'shelf';

export interface LocalCover {
  src: string;
  srcSet: string;
}

export interface CoverPlan {
  local?: LocalCover;
  remote?: string;
}

const SCIELO_BOOK_ID = /^scielo-book-([a-z0-9]{3,16})$/i;
const RASTER_EXTENSION = /\.(?:jpe?g|png|webp|gif|avif)$/i;
/** SciELO's 111×160 thumbnail: only acceptable where it is shown ≤ ~120 CSS px wide. */
const SCIELO_THUMBNAIL = /\/cover_thumbnail\.[a-z]+$/i;
const DIRECT_COVER_HOST = 'books.scielo.org';

export const COVER_WIDTHS = { small: 320, large: 640 } as const;

export function scieloBookId(id: string): string | null {
  const match = SCIELO_BOOK_ID.exec(id);
  return match ? match[1].toLowerCase() : null;
}

export function localCoverFor(publication: Pick<Publication, 'id'>): LocalCover | undefined {
  const bookId = scieloBookId(publication.id);
  if (!bookId) return undefined;
  const small = `/covers/${bookId}-${COVER_WIDTHS.small}.webp`;
  const large = `/covers/${bookId}-${COVER_WIDTHS.large}.webp`;
  return { src: small, srcSet: `${small} ${COVER_WIDTHS.small}w, ${large} ${COVER_WIDTHS.large}w` };
}

function remoteCoverFor(publication: Pick<Publication, 'coverUrl'>, variant: CoverVariant): string | undefined {
  const safe = safeExternalUrl(publication.coverUrl);
  if (!safe) return undefined;

  let url: URL;
  try {
    url = new URL(safe);
  } catch {
    return undefined;
  }

  // The thumbnail is fine for the 56 px list cover and nowhere else.
  if (SCIELO_THUMBNAIL.test(url.pathname) && variant !== 'list') return undefined;
  if (!RASTER_EXTENSION.test(url.pathname)) return undefined;

  const trusted = trustedContentUrl(publication.coverUrl);
  if (!trusted) return undefined;
  // books.scielo.org is allowed by the CSP; any other academic host goes through our proxy.
  return url.hostname.toLowerCase() === DIRECT_COVER_HOST ? trusted : buildCoverProxyUrl(trusted);
}

export function planCover(
  publication: Pick<Publication, 'id' | 'coverUrl'>,
  variant: CoverVariant
): CoverPlan {
  return { local: localCoverFor(publication), remote: remoteCoverFor(publication, variant) };
}

/** True when the work has (or very probably has) a real cover image, not a generated one. */
export function hasRealCover(publication: Pick<Publication, 'id' | 'coverUrl'>): boolean {
  const plan = planCover(publication, 'shelf');
  return Boolean(plan.local ?? plan.remote);
}
