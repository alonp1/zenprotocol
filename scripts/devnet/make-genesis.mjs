#!/usr/bin/env node
// Makes the genesis block of a ZP test network from the genesis block of the built-in `local` chain:
// same transactions (so the merkle commitments stay valid), but its own timestamp, difficulty and nonce, hence its own hash.
// A genesis block is accepted by its hash alone (Consensus/BlockValidation.fs), no proof of work is needed.
//
//   node scripts/devnet/make-genesis.mjs [--time 2026-10-07T00:00:00Z] [--difficulty 1dffffff] [--nonce 1]
// Prints the block hex (put it in Consensus/Chain.fs) and the block hash (genesisHashHash is computed from it).
import { sha3_256 } from '../../wallet/node_modules/@noble/hashes/sha3.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const TIME = Date.parse(arg('time', '2026-10-07T00:00:00Z'));
const DIFF = parseInt(arg('difficulty', '1dffffff'), 16);
const NONCE = BigInt(arg('nonce', '1'));
const LOCAL = '000000000000000000000000000000000000000000000000000000000000000000000000000000013ca83bcc8483b5a8706a8fed28e4ec64952d7d6b65624c8e8026f48cf177176700000160e073fe8f20ffffff0000000000000000000000000000000003b01098756bcf637bef2a161bd49412cad0a10adf12e64a694c41f9c5b971642029f0999def953f2a14ad6c143e2a0ebf3b4f794d8b17fc1203c12365427c09d3be653064be80f760b9d471dc9afbac2b24236c9f2eb0f08b7427942852dc780201000000000001022030759b07ca01caf8e524fc279946a1e96afc3546ee5f1fd4a1cfaf644763c2b4002c010000';
const b = Uint8Array.from(LOCAL.match(/../g), x => parseInt(x,16));
const dv = new DataView(b.buffer);
// header: version 4 | parent 32 | number 4 | commitments 32 | timestamp 8 | difficulty 4 | nonce 16 (two u64)
dv.setBigUint64(72, BigInt(TIME));
dv.setUint32(80, DIFF);
dv.setBigUint64(84, 0n); dv.setBigUint64(92, NONCE);
const hex = a => Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
console.log('genesis time     ', TIME, new Date(TIME).toISOString());
console.log('difficulty       ', '0x' + DIFF.toString(16));
console.log('block hash       ', hex(sha3_256(b.slice(0, 100))));
console.log('genesis block hex', hex(b));
