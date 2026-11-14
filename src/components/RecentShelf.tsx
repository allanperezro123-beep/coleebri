import { memo, useMemo, type CSSProperties } from 'react';
import { hasRealCover } from '../lib/cover';
import type { Publication } from '../types/publication';
import { BookCover } from './BookCover';

interface RecentShelfProps {
  /** Current first page of results; only works with a real cover are shown. */
  items: Publication[];
  /** First load: reserve the shelf's height so nothing jumps when the covers arrive. */
  loading?: boolean;
  onSelect: (pub: Publication) => void;
}

const MAX_BOOKS = 12;
const MIN_BOOKS = 4;
const SHELF_COVER_SIZES = '(min-width: 1280px) 7.5rem, (min-width: 640px) 6.75rem, 4.75rem';

function ShelfSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="skeleton h-6 w-36" />
      <div className="shelf-scroll">
        <ul className="shelf-books">
          {Array.from({ length: 8 }).map((_, i) => (
            <li key={i}>
              <div className="cover skeleton-cover" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Covers standing on a shelf line: the newest works of the current results, as a visual way in. */
export const RecentShelf = memo(function RecentShelf({ items, loading = false, onSelect }: RecentShelfProps) {
  const books = useMemo(() => items.filter(hasRealCover).slice(0, MAX_BOOKS), [items]);
  if (loading && books.length === 0) return <ShelfSkeleton />;
  if (books.length < MIN_BOOKS) return null;

  return (
    <section aria-labelledby="recent-shelf-title">
      <h2 id="recent-shelf-title" className="font-editorial text-lg font-semibold sm:text-xl">
        Recién llegados
      </h2>
      <div className="shelf-scroll">
        <ul className="shelf-books">
          {books.map((pub, index) => (
            <li key={pub.id} style={{ '--stagger-i': index } as CSSProperties}>
              <button
                type="button"
                className="shelf-book"
                onClick={() => onSelect(pub)}
                aria-label={`Ver ficha: ${pub.title}`}
              >
                <BookCover publication={pub} variant="shelf" sizes={SHELF_COVER_SIZES} priority={index < 3} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
});
