/**
 * Safe wrappers around localStorage / sessionStorage. Storage can throw (private mode, blocked
 * site data, quota) or hold garbage written by older versions, so every access is guarded.
 */

export const STORAGE_PREFIX = 'coleebri:';
/** Keys written by earlier versions that `clearLocalData` must also remove. */
const LEGACY_PREFIXES = ['scielo-open-library:'];

export function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota or unavailable storage: the feature simply isn't remembered
  }
}

export function readString(key: string, store: 'local' | 'session' = 'local'): string | null {
  try {
    return (store === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string | null, store: 'local' | 'session' = 'local'): void {
  try {
    const target = store === 'local' ? localStorage : sessionStorage;
    if (value === null) target.removeItem(key);
    else target.setItem(key, value);
  } catch {
    // ignore
  }
}

/** Removes ONLY Coleebri keys (current and legacy) from local and session storage. */
export function clearLocalData(): void {
  for (const store of ['local', 'session'] as const) {
    try {
      const target = store === 'local' ? localStorage : sessionStorage;
      const doomed: string[] = [];
      for (let i = 0; i < target.length; i++) {
        const key = target.key(i);
        if (key && (key.startsWith(STORAGE_PREFIX) || LEGACY_PREFIXES.some((p) => key.startsWith(p)))) {
          doomed.push(key);
        }
      }
      doomed.forEach((key) => target.removeItem(key));
    } catch {
      // ignore
    }
  }
}
