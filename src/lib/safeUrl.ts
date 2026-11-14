/**
 * Client-side URL guards. Every URL that comes from the catalogue (D1, OpenAlex, Crossref,
 * localStorage) is untrusted: it must be an absolute https URL before it is used in an
 * href / src / window.open. This blocks `javascript:`, `data:` and similar schemes.
 */

const TRUSTED_CONTENT_HOST =
  /^(?:(?:[a-z0-9-]+\.)*(?:scielo\.(?:org|br|cl|pt|edu\.uy|sa\.cr|sld\.cu|isciii\.es)|scielo\.org\.(?:ar|bo|co|ec|mx|pe|py|ve)|scielo\.iics\.una\.py|doabooks\.org|oapen\.org|doi\.org|openalex\.org)|assets\.verlag\.gta\.arch\.ethz\.ch|ciencialatina\.org|downloads\.editoracientifica\.com\.br|e-archivo\.uc3m\.es|editorialmarcaribe\.es|edizionicafoscari\.unive\.it|eladd\.org|intech-files\.s3\.amazonaws\.com|melusina-pubs\.fra1\.digitaloceanspaces\.com|mts\.intechopen\.com|portalcris\.vdu\.lt|pure\.iiasa\.ac\.at|real\.mtak\.hu|repository\.unad\.edu\.co|researchonline\.lse\.ac\.uk|revistas\.upsa\.es|revistasonline\.inap\.es|sauyayinlari\.sakarya\.edu\.tr|skyfox\.co|sophiaeditions\.com|www\.berghahnbooks\.com|www\.cambridge\.org|www\.editoracientifica\.com\.br|www\.editoracrv\.com\.br|www\.ledizioni\.it|www\.logos-verlag\.de|www\.redalyc\.org|www\.sav\.sk|www\.seankingston\.co\.uk|www\.vdu\.lt|www\.viella\.it|www\.zaphon\.de)$/i;

/** Returns a normalized https URL string, or undefined if the value is not a safe web link. */
export function safeExternalUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username || url.password) return undefined;
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Like safeExternalUrl but additionally restricted to the academic hosts the proxy accepts. */
export function trustedContentUrl(raw: unknown): string | undefined {
  const safe = safeExternalUrl(raw);
  if (!safe) return undefined;
  return TRUSTED_CONTENT_HOST.test(new URL(safe).hostname) ? safe : undefined;
}

/** `#rrggbb` only — anything else (e.g. `url(...)`) falls back to the brand cobalt. */
export function safeHexColor(raw: unknown, fallback = '#1758C4'): string {
  return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw : fallback;
}
