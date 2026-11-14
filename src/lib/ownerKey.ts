import { readString, writeString } from './storage';

/**
 * Anonymous per-device key that scopes the user's private shelves on the server.
 * 32 random bytes, base64url (no padding). Lives in localStorage; if storage is unavailable it
 * is kept in memory for the session.
 */

const OWNER_KEY_STORAGE = 'coleebri:owner-key:v1';
const OWNER_KEY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

let memoryKey: string | null = null;

function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function getOwnerKey(): string {
  if (memoryKey) return memoryKey;
  const stored = readString(OWNER_KEY_STORAGE);
  if (stored && OWNER_KEY_PATTERN.test(stored)) {
    memoryKey = stored;
    return stored;
  }
  const fresh = generateKey();
  memoryKey = fresh;
  writeString(OWNER_KEY_STORAGE, fresh);
  return fresh;
}
