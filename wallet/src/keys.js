// Keys and addresses for the ZP network.
// Matches the node (src/Wallet): BIP39 mnemonic (no passphrase) -> BIP32 secp256k1,
// account path m/44'/258'/0', receive keys m/44'/258'/0'/0/i, change m/44'/258'/0'/1/i.
// PK hash = SHA3-256(compressed public key). Address = bech32(hrp, [version 0] + toWords(hash)).
import { mnemonicToSeedSync, validateMnemonic, generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bech32 } from '@scure/base';

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
