// Keys and addresses for the ZP network.
// Matches the node (src/Wallet): BIP39 mnemonic (no passphrase) -> BIP32 secp256k1,
// account path m/44'/258'/0', receive keys m/44'/258'/0'/0/i, change m/44'/258'/0'/1/i.
// PK hash = SHA3-256(compressed public key). Address = bech32(hrp, [version 0] + toWords(hash)).
import { mnemonicToSeedSync, validateMnemonic, generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bech32, createBase58check } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const ACCOUNT_PATH = "m/44'/258'/0'";
const HRP = { main: 'zen', test: 'tzn' };

export function newMnemonic() {
  return generateMnemonic(wordlist, 256);                 // 24 words
}

export function checkMnemonic(words) {
  return validateMnemonic(normalize(words), wordlist);
}

const normalize = words => (Array.isArray(words) ? words.join(' ') : words).trim().toLowerCase().split(/\s+/).join(' ');

export function accountFromMnemonic(words) {
  const phrase = normalize(words);
  if (!validateMnemonic(phrase, wordlist)) throw new Error('Invalid recovery phrase');
  return HDKey.fromMasterSeed(mnemonicToSeedSync(phrase)).derive(ACCOUNT_PATH);
}

export function pkHash(publicKey) {
  return sha3_256(publicKey);                             // publicKey: 33-byte compressed
}

export function encodeAddress(hash, chain = 'main', contract = false) {
  const words = bech32.toWords(hash);
  return bech32.encode((contract ? 'c' : '') + HRP[chain], [0, ...words], 120);
}

export function decodeAddress(address) {
  const { prefix, words } = bech32.decode(address, 120);
  const contract = prefix.startsWith('c');
  const chain = Object.keys(HRP).find(k => HRP[k] === (contract ? prefix.slice(1) : prefix));
  if (!chain || words[0] !== 0) throw new Error('Not a ZP address');
  return { chain, contract, hash: Uint8Array.from(bech32.fromWords(words.slice(1))) };
}

// branch 0 = receive (External), 1 = change, 2 = payment
export function deriveKey(account, branch, index) {
  const key = account.deriveChild(branch).deriveChild(index);
  return { path: `${ACCOUNT_PATH}/${branch}/${index}`, privateKey: key.privateKey, publicKey: key.publicKey,
           pkHash: pkHash(key.publicKey) };
}

export function receiveAddress(account, index = 0, chain = 'main') {
  return encodeAddress(deriveKey(account, 0, index).pkHash, chain);
}

// --- importing a single key or an extended key ------------------------------------------------

const b58c = createBase58check(sha256);
const isHex64 = s => /^[0-9a-fA-F]{64}$/.test(s);
const hexToBytes = s => Uint8Array.from(s.match(/../g), h => parseInt(h, 16));

// A key the user pastes: 64 hex chars (raw secp256k1 private key) or a BIP32 extended private key
// (any version prefix). Returns { kind: 'single', key } or { kind: 'account', account (HDKey) }.
export function parsePrivateKey(text) {
  const s = text.trim();
  if (isHex64(s)) {
    const privateKey = hexToBytes(s);
    if (!secp256k1.utils.isValidSecretKey(privateKey)) throw new Error('Not a valid private key');
    return { kind: 'single', key: singleKey(privateKey) };
  }
  let raw;
  try { raw = b58c.decode(s); } catch { throw new Error('Not a private key (expected 64 hex characters or an extended key)'); }
  if (raw.length !== 78 || raw[45] !== 0) throw new Error('Not an extended private key');
  const depth = raw[4];
  const node = new HDKey({ depth, index: new DataView(raw.buffer, raw.byteOffset).getUint32(9),
    parentFingerprint: new DataView(raw.buffer, raw.byteOffset).getUint32(5),
    chainCode: raw.slice(13, 45), privateKey: raw.slice(46, 78) });
  if (depth === 0) return { kind: 'account', account: node.derive(ACCOUNT_PATH) };
  if (depth === 3) return { kind: 'account', account: node };
  return { kind: 'single', key: singleKey(node.privateKey) };
}

export function singleKey(privateKey) {
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return { path: null, privateKey, publicKey, pkHash: pkHash(publicKey) };
}

export function isValidAddress(address, chain) {
  try { const d = decodeAddress(address); return d.chain === chain && !d.contract && d.hash.length === 32; }
  catch { return false; }
}
