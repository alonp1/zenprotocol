// Encrypted local storage for wallet secrets (recovery phrases, private keys).
// WebCrypto only: PBKDF2-SHA256 (600,000 iterations) -> AES-256-GCM, a fresh 12-byte IV per secret.
// Nothing here ever leaves the device; the node never sees a secret.

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const subtle = () => globalThis.crypto.subtle;
const rand = n => globalThis.crypto.getRandomValues(new Uint8Array(n));

export const KDF_ITERATIONS = 600_000;
const CHECK = 'zp-wallet-vault-v1';

async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(key, value) {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function open(key, box) {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

// New vault header protected by the password.
export async function createVault(password) {
  if (!password || password.length < 8) throw new Error('Use a password of at least 8 characters');
  const salt = rand(16);
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  return { vault: { v: 1, kdf: { name: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: b64(salt) },
                    check: await seal(key, CHECK), wallets: [] }, key };
}

export async function unlockVault(vault, password) {
  const key = await deriveKey(password, unb64(vault.kdf.salt), vault.kdf.iterations);
  try { if (await open(key, vault.check) === CHECK) return key; } catch { /* wrong password */ }
  throw new Error('Wrong password');
}

// Persistence: localStorage in the browser, a plain object elsewhere (tests).
const STORAGE_KEY = 'zp-wallet.vault.v1';
export const storage = {
  load() {
    try { const s = globalThis.localStorage?.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
  },
  save(vault) {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(vault));
  },
  clear() { globalThis.localStorage?.removeItem(STORAGE_KEY); },
};
