// API keys at rest: AES-GCM encrypted with a key derived from the user's PIN (PBKDF2-SHA256).
// The decrypted copy lives only in chrome.storage.session (memory, cleared when the browser closes,
// not readable by content scripts).

const ITERATIONS = 310_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const KEY_LIFETIME_DAYS = 90;
export const KEY_WARN_DAYS = 10;

async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function hasVault() {
  const { vault } = await chrome.storage.local.get('vault');
  return !!vault;
}

/** Encrypts and stores credentials, and unlocks them for this browser session. */
export async function saveVault(creds, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(creds)));
  await chrome.storage.local.set({ vault: { v: 1, salt: b64(salt), iv: b64(iv), data: b64(data) } });
  await chrome.storage.session.set({ creds });
}

/** Throws on a wrong PIN. */
export async function unlockVault(pin) {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) throw new Error('Chưa lưu API Key');
  const key = await deriveKey(pin, unb64(vault.salt));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.data));
  } catch {
    throw new Error('Sai mã PIN');
  }
  const creds = JSON.parse(dec.decode(plain));
  await chrome.storage.session.set({ creds });
  return creds;
}

export async function sessionCreds() {
  const { creds } = await chrome.storage.session.get('creds');
  return creds ?? null;
}

export const lockVault = () => chrome.storage.session.remove('creds');

export async function deleteVault() {
  await chrome.storage.local.remove('vault');
  await chrome.storage.session.remove('creds');
}

export function daysLeft(creds) {
  return Math.ceil(KEY_LIFETIME_DAYS - (Date.now() - creds.createdAt) / 86_400_000);
}
