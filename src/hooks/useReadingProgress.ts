import { useEffect, useState } from 'react';
import { getAllReadingProgress, subscribeReadingProgress, type ReadingProgress } from '../lib/readingProgress';

export type ProgressMap = Record<string, ReadingProgress>;

/** Keeps object identity for unchanged entries so memoised cards do not re-render on every page turn. */
function mergeStable(prev: ProgressMap, next: ProgressMap): ProgressMap {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  let same = prevKeys.length === nextKeys.length;
  const out: ProgressMap = {};
  for (const key of nextKeys) {
    const before = prev[key];
    const now = next[key];
    if (before && before.page === now.page && before.totalPages === now.totalPages && before.updatedAt === now.updatedAt) {
      out[key] = before;
    } else {
      out[key] = now;
      same = false;
    }
  }
  return same ? prev : out;
}

/** Reading progress of every book, live-updated while the reader saves pages. */
export function useReadingProgress(): ProgressMap {
  const [map, setMap] = useState<ProgressMap>(() => getAllReadingProgress());

  useEffect(() => {
    const refresh = () => setMap((prev) => mergeStable(prev, getAllReadingProgress()));
    refresh();
    return subscribeReadingProgress(refresh);
  }, []);

  return map;
}
