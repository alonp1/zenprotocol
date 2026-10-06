// Binary serialization of ZP transactions and blocks.
// Port of src/Consensus/Serialization.fs (zen-node 1.0.13). Every rule below mirrors that file;
// test/serialize.test.js round-trips real mainnet blocks and checks transaction hashes.
import { sha3_256 } from '@noble/hashes/sha3.js';

export const ZERO32 = new Uint8Array(32);
export const ZEN_ASSET = { contract: { version: 0, hash: ZERO32 }, subtype: ZERO32 };

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const isZero = a => a.every(x => x === 0);
export const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export const unhex = s => Uint8Array.from(s.match(/../g) || [], h => parseInt(h, 16));
const ascii = new TextEncoder(), unascii = new TextDecoder('ascii');

class SerializationError extends Error {}
const fail = m => { throw new SerializationError(m); };

// --- byte streams ---------------------------------------------------------------------------
export class Writer {
  constructor() { this.parts = []; this.len = 0; }
  bytes(b) { this.parts.push(b); this.len += b.length; }
  u8(n) { this.bytes(Uint8Array.of(n)); }
  u16(n) { this.bytes(Uint8Array.of((n >> 8) & 255, n & 255)); }
  u32(n) { this.bytes(Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)); }
  u64(n) { n = BigInt(n); const b = new Uint8Array(8);
           for (let i = 7; i >= 0; i--) { b[i] = Number(n & 0xffn); n >>= 8n; } this.bytes(b); }
  out() { const o = new Uint8Array(this.len); let p = 0; for (const b of this.parts) { o.set(b, p); p += b.length; } return o; }
}

export class Reader {
  constructor(buf) { this.b = buf; this.p = 0; }
  need(n) { if (this.p + n > this.b.length) fail('unexpected end of data'); }
  bytes(n) { this.need(n); const r = this.b.slice(this.p, this.p + n); this.p += n; return r; }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { const b = this.bytes(2); return (b[0] << 8) | b[1]; }
  u32() { const b = this.bytes(4); return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; }
  u64() { const b = this.bytes(8); let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; }
  done() { return this.p === this.b.length; }
}

// --- primitives -----------------------------------------------------------------------------
// Bitcoin-style VarInt (serialize.h WriteVarInt), uint32
export const VarInt = {
  write(w, x) {
    const tmp = []; let n = x >>> 0, len = 0;
    for (;;) {
      tmp[len] = (n & 0x7f) | (len ? 0x80 : 0);
      if (n <= 0x7f) break;
      n = (Math.floor(n / 128)) - 1; len++;
    }
    w.bytes(Uint8Array.from(tmp.reverse()));
  },
  read(r) {
    let n = 0;
    for (;;) {
      const d = r.u8();
      n = n * 128 + (d & 0x7f);
      if (n > 0xffffffff) fail('varint overflow');
      if (d & 0x80) n++; else return n;
    }
  },
};

const Bytes = {
  write(w, b) { VarInt.write(w, b.length); w.bytes(b); },
  read(r) { return r.bytes(VarInt.read(r)); },
};
const Str = {
  write(w, s) { Bytes.write(w, ascii.encode(s)); },
  read(r) { return unascii.decode(Bytes.read(r)); },
};
const List = {
  write(w, fn, xs) { VarInt.write(w, xs.length); for (const x of xs) fn(w, x); },
  read(r, fn) { const n = VarInt.read(r), out = []; for (let i = 0; i < n; i++) out.push(fn(r)); return out; },
};
const Opt = {
  write(w, fn, v) { if (v == null) w.u8(0); else { w.u8(1); fn(w, v); } },
  read(r, fn) { const d = r.u8(); if (d === 0) return null; if (d === 1) return fn(r); fail('bad option'); },
};
const Hash = { write: (w, h) => { if (h.length !== 32) fail('hash length'); w.bytes(h); }, read: r => r.bytes(32) };

// size of a value as written by fn (used for the length prefixes of locks, witnesses, contracts)
const sizeOf = (fn, v) => { const w = new Writer(); fn(w, v); return w.len; };

export const ContractId = {
  write(w, c) { VarInt.write(w, c.version); Hash.write(w, c.hash); },
  read(r) { return { version: VarInt.read(r), hash: Hash.read(r) }; },
};

// --- asset ----------------------------------------------------------------------------------
function versionBytes(v) {
  if ((v & 0xffffffe0) === 0) return [v];
  if ((v & 0xfffff000) === 0) return [0x20 | (v >>> 7), 0x7f & v];
  if ((v & 0xfff80000) === 0) return [0x20 | (v >>> 14), 0x80 | ((v >>> 7) & 0x7f), 0x7f & v];
  if ((v & 0xfc000000) === 0) return [0x20 | (v >>> 21), 0x80 | ((v >>> 14) & 0x7f), 0x80 | ((v >>> 7) & 0x7f), 0x7f & v];
  return [0x20 | (v >>> 28), 0x80 | ((v >>> 21) & 0x7f), 0x80 | ((v >>> 14) & 0x7f), 0x80 | ((v >>> 7) & 0x7f), 0x7f & v];
}
// byte casts: F# `byte (v >>> k)` keeps the low 8 bits, then the OR above adds the marker bits
const b8 = a => Uint8Array.from(a, x => x & 0xff);

export const Asset = {
  write(w, a) {
    const vbs = versionBytes(a.contract.version >>> 0);
    const cHash = a.contract.hash, sb = a.subtype;
    if (isZero(cHash) && isZero(sb)) { w.bytes(b8(vbs)); return; }
    let n = -1; for (let i = 31; i >= 0; i--) if (sb[i] !== 0) { n = i; break; }
    if (n < 0) { vbs[0] |= 0x80; w.bytes(b8(vbs)); Hash.write(w, cHash); }
    else if (n < 30) { vbs[0] |= 0x40; w.bytes(b8(vbs)); Hash.write(w, cHash); w.u8(n + 1); w.bytes(sb.slice(0, n + 1)); }
    else { vbs[0] |= 0xc0; w.bytes(b8(vbs)); Hash.write(w, cHash); Hash.write(w, sb); }
  },
  read(r) {
    const first = r.u8();
    if (first === 0) return ZEN_ASSET;
    let version = first & 0x1f;
    if (first & 0x20) {
      let v = version * 128, counter = 0;
      for (;;) {
        if (counter > 3 || (counter !== 0 && v === 0)) fail('asset version');
        const b = r.u8(), next = v + (b & 0x7f);
        if (!(b & 0x80)) { version = next; break; }
        if (next >= 2 ** 25) fail('asset version overflow');
        v = next * 128; counter++;
      }
    }
    const tag = first & 0xc0;
    const cHash = tag === 0 ? ZERO32 : Hash.read(r);
    let subtype = ZERO32;
    if (tag === 0xc0) subtype = Hash.read(r);
    else if (tag === 0x40) {
      const len = r.u8();
      subtype = new Uint8Array(32);
      if (len) subtype.set(r.bytes(len));
    }
    return { contract: { version: version >>> 0, hash: cHash }, subtype };
  },
};
export const assetToString = a => {
  const w = new Writer(); Asset.write(w, a);
  return isZero(a.contract.hash) && isZero(a.subtype) ? '00' : hex(w.out());
};

// --- amount (decimal floating point encoding, Serialization.fs Amount) ------------------------
const P10 = e => 10n ** BigInt(e);
export const Amount = {
  write(w, amount) {
    amount = BigInt(amount);
    let s = amount, e = 0, f = 0;
    if (amount !== 0n) {
      while (s % 10n === 0n) { s /= 10n; e++; }
      for (let t = s; t !== 0n; t /= 10n) f++;
    }
    if (f <= 3) {
      w.u16(Number(s | (BigInt(e) << 10n)) & 0xffff);
    } else if (f <= 8) {
      let s32 = s, e32 = BigInt(e);
      if (e > 12) { s32 = s * P10(e - 12); e32 = 12n; }
      const cutoff = 0x04000000n;
      if (s32 < cutoff) w.u32(Number(((s32 | (((0x20n | e32) << 26n))) & 0xffffffffn)));
      else w.u32(Number((((s32 - cutoff) | ((0x60n | e32) << 25n))) & 0xffffffffn));
    } else if (amount < 2n ** 56n) {
      w.u64((0x7en << 56n) | amount);
    } else {
      w.u8(0xfe); w.u64(amount);
    }
  },
  read(r) {
    const first = r.u8();
    if ((first & 0x7e) === 0x7c || (first & 0x7c) === 0x78) fail('amount NaN/Infinity');
    if ((first & 0x7e) === 0x7e) {
      if (first >= 0x80) return r.u64();
      const second = BigInt(r.u8()), third = BigInt(r.u16()), fourth = BigInt(r.u32());
      return fourth + (third << 32n) + (second << 48n);
    }
    if (first < 0x80) {
      const second = BigInt(r.u8());
      if ((first & 0x60) === 0x60) return (second + 0x400n) * P10(first & 0x1f);
      return (second + (BigInt(first & 0x03) << 8n)) * P10((first & 0x7c) >> 2);
    }
    const second = BigInt(r.u8()), lower = BigInt(r.u16());
    if ((first & 0x40) === 0)
      return (lower + (second << 16n) + (BigInt(first & 0x03) << 24n)) * P10((first & 0x3c) >> 2);
    return (lower + (second << 16n) + (BigInt(first & 0x01) << 24n) + 0x4000000n) * P10((first & 0x1e) >> 1);
  },
};

export const Spend = {
  write(w, s) { Asset.write(w, s.asset); Amount.write(w, s.amount); },
  read(r) { return { asset: Asset.read(r), amount: Amount.read(r) }; },
};
export const Outpoint = {
  write(w, o) { Hash.write(w, o.txHash); VarInt.write(w, o.index); },
  read(r) { return { txHash: Hash.read(r), index: VarInt.read(r) }; },
};
export const Input = {
  write(w, i) {
    if (i.type === 'outpoint') { w.u8(1); Outpoint.write(w, i.outpoint); }
    else if (i.type === 'mint') { w.u8(2); Spend.write(w, i.spend); }
    else fail('input type');
  },
  read(r) {
    const d = r.u8();
    if (d === 1) return { type: 'outpoint', outpoint: Outpoint.read(r) };
    if (d === 2) return { type: 'mint', spend: Spend.read(r) };
    fail('input discriminator');
  },
};

// --- lock -----------------------------------------------------------------------------------
const LOCK_ID = { Fee: 1, PK: 2, ActivationSacrifice: 3, Contract: 4, ExtensionSacrifice: 5, Coinbase: 6, Destroy: 7 };
function lockPayload(w, l) {
  switch (l.type) {
    case 'PK': Hash.write(w, l.hash); break;
    case 'Contract': case 'ExtensionSacrifice': ContractId.write(w, l.contractId); break;
    case 'Fee': case 'ActivationSacrifice': case 'Destroy': break;
    case 'Coinbase': w.u32(l.blockNumber); Hash.write(w, l.pkHash); break;
    case 'HighV': w.bytes(l.bytes); break;
    default: fail('lock type');
  }
}
export const Lock = {
  write(w, l) {
    VarInt.write(w, l.type === 'HighV' ? l.id : LOCK_ID[l.type]);
    VarInt.write(w, sizeOf(lockPayload, l));
    lockPayload(w, l);
  },
  read(r) {
    const id = VarInt.read(r), count = VarInt.read(r);
    let l;
    switch (id) {
      case 2: l = { type: 'PK', hash: Hash.read(r) }; break;
      case 4: l = { type: 'Contract', contractId: ContractId.read(r) }; break;
      case 6: l = { type: 'Coinbase', blockNumber: r.u32(), pkHash: Hash.read(r) }; break;
      case 1: l = { type: 'Fee' }; break;
      case 3: l = { type: 'ActivationSacrifice' }; break;
      case 7: l = { type: 'Destroy' }; break;
      case 5: l = { type: 'ExtensionSacrifice', contractId: ContractId.read(r) }; break;
      default: l = { type: 'HighV', id, bytes: r.bytes(count) };
    }
    if (sizeOf(lockPayload, l) !== count) fail('lock size');
    return l;
  },
};
export const Output = {
  write(w, o) { Lock.write(w, o.lock); Spend.write(w, o.spend); },
  read(r) { return { lock: Lock.read(r), spend: Spend.read(r) }; },
};

// --- contract data (Zen.Types.Data) ---------------------------------------------------------
export const Data = {
  write(w, d) {
    switch (d.t) {
      case 'I64': w.u8(1); w.u64(BigInt.asUintN(64, BigInt(d.v))); break;
      case 'Byte': w.u8(2); w.u8(d.v); break;
      case 'ByteArray': w.u8(3); Bytes.write(w, d.v); break;
      case 'U32': w.u8(4); w.u32(d.v); break;
      case 'U64': w.u8(5); w.u64(d.v); break;
      case 'String': w.u8(6); Str.write(w, d.v); break;
      case 'Hash': w.u8(7); Hash.write(w, d.v); break;
      case 'Lock': w.u8(8); Lock.write(w, d.v); break;
      case 'Signature': w.u8(9); w.bytes(d.v); break;
      case 'PublicKey': w.u8(10); w.bytes(d.v); break;
      case 'Array': w.u8(11); List.write(w, Data.write, d.v); break;
      case 'Dict': {
        w.u8(12);
        const entries = [...d.v].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        List.write(w, (w, [k, v]) => { Str.write(w, k); Data.write(w, v); }, entries);
        break;
      }
      case 'List': w.u8(13); List.write(w, Data.write, d.v); break;
      default: fail('data type');
    }
  },
  read(r) {
    const d = r.u8();
    switch (d) {
      case 1: return { t: 'I64', v: BigInt.asIntN(64, r.u64()) };
      case 2: return { t: 'Byte', v: r.u8() };
      case 3: return { t: 'ByteArray', v: Bytes.read(r) };
      case 4: return { t: 'U32', v: r.u32() };
      case 5: return { t: 'U64', v: r.u64() };
      case 6: return { t: 'String', v: Str.read(r) };
      case 7: return { t: 'Hash', v: Hash.read(r) };
      case 8: return { t: 'Lock', v: Lock.read(r) };
      case 9: return { t: 'Signature', v: r.bytes(64) };
      case 10: return { t: 'PublicKey', v: r.bytes(33) };
      case 11: return { t: 'Array', v: List.read(r, Data.read) };
      case 12: {
        const entries = List.read(r, r => [Str.read(r), Data.read(r)]);
        for (let i = 1; i < entries.length; i++) if (!(entries[i - 1][0] <= entries[i][0])) fail('dict not sorted');
        return { t: 'Dict', v: entries };
      }
      case 13: return { t: 'List', v: List.read(r, Data.read) };
      default: fail('data discriminator ' + d);
    }
  },
};

// --- witnesses ------------------------------------------------------------------------------
const SIGHASH = { TxHash: 1, FollowingWitnesses: 3 };
const StateCommitment = {
  write(w, s) {
    if (s.type === 'NoState') w.u8(1);
    else if (s.type === 'State') { w.u8(2); Hash.write(w, s.hash); }
    else if (s.type === 'NotCommitted') w.u8(3);
    else fail('state commitment');
  },
  read(r) {
    const d = r.u8();
    if (d === 1) return { type: 'NoState' };
    if (d === 2) return { type: 'State', hash: Hash.read(r) };
    if (d === 3) return { type: 'NotCommitted' };
    fail('state commitment discriminator');
  },
};
function witnessPayload(w, x) {
  if (x.type === 'PK') {
    w.u8(typeof x.sigHash === 'number' ? x.sigHash : SIGHASH[x.sigHash]);
    w.bytes(x.publicKey); w.bytes(x.signature);
  } else if (x.type === 'Contract') {
    ContractId.write(w, x.contractId);
    Str.write(w, x.command);
    Opt.write(w, Data.write, x.messageBody);
    StateCommitment.write(w, x.stateCommitment);
    VarInt.write(w, x.beginInputs); VarInt.write(w, x.beginOutputs);
    VarInt.write(w, x.inputsLength); VarInt.write(w, x.outputsLength);
    Opt.write(w, (w, s) => { w.bytes(s.publicKey); w.bytes(s.signature); }, x.signature);
    w.u64(x.cost);
  } else if (x.type === 'HighV') w.bytes(x.bytes);
  else fail('witness type');
}
export const Witness = {
  write(w, x) {
    VarInt.write(w, x.type === 'PK' ? 1 : x.type === 'Contract' ? 2 : x.id);
    VarInt.write(w, sizeOf(witnessPayload, x));
    witnessPayload(w, x);
  },
  read(r) {
    const id = VarInt.read(r), count = VarInt.read(r);
    let x;
    if (id === 1) {
      const sh = r.u8();
      x = { type: 'PK', sigHash: sh === 1 ? 'TxHash' : sh === 3 ? 'FollowingWitnesses' : sh,
            publicKey: r.bytes(33), signature: r.bytes(64) };
    } else if (id === 2) {
      x = { type: 'Contract', contractId: ContractId.read(r), command: Str.read(r),
            messageBody: Opt.read(r, Data.read), stateCommitment: StateCommitment.read(r),
            beginInputs: VarInt.read(r), beginOutputs: VarInt.read(r),
            inputsLength: VarInt.read(r), outputsLength: VarInt.read(r),
            signature: Opt.read(r, r => ({ publicKey: r.bytes(33), signature: r.bytes(64) })),
            cost: r.u64() };
    } else x = { type: 'HighV', id, bytes: r.bytes(count) };
    if (sizeOf(witnessPayload, x) !== count) fail('witness size');
    return x;
  },
};

// --- contract (deploy) ----------------------------------------------------------------------
function contractPayload(w, c) {
  if (c.version === 0) { Str.write(w, c.code); Str.write(w, c.hints); VarInt.write(w, c.rlimit); VarInt.write(w, c.queries); }
  else w.bytes(c.bytes);
}
export const Contract = {
  write(w, c) { VarInt.write(w, c.version); VarInt.write(w, sizeOf(contractPayload, c)); contractPayload(w, c); },
  read(r) {
    const version = VarInt.read(r), count = VarInt.read(r);
    const c = version === 0
      ? { version, code: Str.read(r), hints: Str.read(r), rlimit: VarInt.read(r), queries: VarInt.read(r) }
      : { version, bytes: r.bytes(count) };
    if (sizeOf(contractPayload, c) !== count) fail('contract size');
    return c;
  },
};

// --- transaction ----------------------------------------------------------------------------
export const Transaction = {
  write(w, tx, full = true) {
    w.u32(tx.version);
    List.write(w, Input.write, tx.inputs);
    List.write(w, Output.write, tx.outputs);
    Opt.write(w, Contract.write, tx.contract);
    if (full) List.write(w, Witness.write, tx.witnesses);
  },
  read(r, full = true) {
    const tx = { version: r.u32(), inputs: List.read(r, Input.read), outputs: List.read(r, Output.read),
                 contract: Opt.read(r, Contract.read) };
    tx.witnesses = full ? List.read(r, Witness.read) : [];
    return tx;
  },
};

export function serializeTx(tx, full = true) { const w = new Writer(); Transaction.write(w, tx, full); return w.out(); }
export function deserializeTx(bytes) {
  const r = new Reader(bytes), tx = Transaction.read(r);
  if (!r.done()) fail('trailing bytes');
  return tx;
}
export const txHash = tx => sha3_256(serializeTx(tx, false));
export const witnessesHash = ws => { const w = new Writer(); List.write(w, Witness.write, ws); return sha3_256(w.out()); };

// --- block (for tests and explorers) --------------------------------------------------------
export function deserializeBlock(bytes) {
  const r = new Reader(bytes);
  const header = r.bytes(100);
  const commitments = List.read(r, Hash.read);
  const txs = List.read(r, r => {
    const start = r.p, tx = Transaction.read(r);
    return { tx, raw: r.b.slice(start, r.p) };
  });
  if (!r.done()) fail('trailing bytes in block');
  return { header, commitments, txs };
}

export const bytesEqual = eq;
