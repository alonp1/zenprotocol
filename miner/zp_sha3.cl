// ZP proof of work: SHA3-256 (FIPS 202) of the 100-byte block header, which must be <= target
// (both read as big-endian 256-bit numbers).
//
// Header layout (all integers big-endian):
//   0 version(4) | 4 parent(32) | 36 blockNumber(4) | 40 commitments(32) | 72 timestamp(8)
//   80 difficulty(4) | 84 nonce1(8) | 92 nonce2(8)
// One SHA3-256 block (rate 136 bytes): bytes 100 = 0x06, 135 |= 0x80.
// The host packs lanes 0..10 and the low half of lane 11 (fixed for a work unit, nonce1 included);
// each work item sets nonce2 = base + global id.

#define ROTL(x, n) rotate((ulong)(x), (ulong)(n))

__constant ulong RC[24] = {
  0x0000000000000001UL, 0x0000000000008082UL, 0x800000000000808aUL, 0x8000000080008000UL,
  0x000000000000808bUL, 0x0000000080000001UL, 0x8000000080008081UL, 0x8000000000008009UL,
  0x000000000000008aUL, 0x0000000000000088UL, 0x0000000080008009UL, 0x000000008000000aUL,
  0x000000008000808bUL, 0x800000000000008bUL, 0x8000000000008089UL, 0x8000000000008003UL,
  0x8000000000008002UL, 0x8000000000000080UL, 0x000000000000800aUL, 0x800000008000000aUL,
  0x8000000080008081UL, 0x8000000000008080UL, 0x0000000080000001UL, 0x8000000080008008UL };

inline ulong bswap64(ulong x) {
  return ((x & 0x00000000000000ffUL) << 56) | ((x & 0x000000000000ff00UL) << 40) |
         ((x & 0x0000000000ff0000UL) << 24) | ((x & 0x00000000ff000000UL) <<  8) |
         ((x & 0x000000ff00000000UL) >>  8) | ((x & 0x0000ff0000000000UL) >> 24) |
         ((x & 0x00ff000000000000UL) >> 40) | ((x & 0xff00000000000000UL) >> 56);
}

inline void keccakf(ulong *a) {
  ulong b0, b1, b2, b3, b4, t;
  #pragma unroll 1
  for (int r = 0; r < 24; r++) {
    // theta
    b0 = a[0] ^ a[5] ^ a[10] ^ a[15] ^ a[20];
    b1 = a[1] ^ a[6] ^ a[11] ^ a[16] ^ a[21];
    b2 = a[2] ^ a[7] ^ a[12] ^ a[17] ^ a[22];
    b3 = a[3] ^ a[8] ^ a[13] ^ a[18] ^ a[23];
    b4 = a[4] ^ a[9] ^ a[14] ^ a[19] ^ a[24];
    t = b4 ^ ROTL(b1, 1); a[0] ^= t; a[5] ^= t; a[10] ^= t; a[15] ^= t; a[20] ^= t;
    t = b0 ^ ROTL(b2, 1); a[1] ^= t; a[6] ^= t; a[11] ^= t; a[16] ^= t; a[21] ^= t;
    t = b1 ^ ROTL(b3, 1); a[2] ^= t; a[7] ^= t; a[12] ^= t; a[17] ^= t; a[22] ^= t;
    t = b2 ^ ROTL(b4, 1); a[3] ^= t; a[8] ^= t; a[13] ^= t; a[18] ^= t; a[23] ^= t;
    t = b3 ^ ROTL(b0, 1); a[4] ^= t; a[9] ^= t; a[14] ^= t; a[19] ^= t; a[24] ^= t;
    // rho + pi
    t = a[1];
    b0 = a[10]; a[10] = ROTL(t,  1); t = b0;
    b0 = a[7];  a[7]  = ROTL(t,  3); t = b0;
    b0 = a[11]; a[11] = ROTL(t,  6); t = b0;
    b0 = a[17]; a[17] = ROTL(t, 10); t = b0;
    b0 = a[18]; a[18] = ROTL(t, 15); t = b0;
    b0 = a[3];  a[3]  = ROTL(t, 21); t = b0;
    b0 = a[5];  a[5]  = ROTL(t, 28); t = b0;
    b0 = a[16]; a[16] = ROTL(t, 36); t = b0;
    b0 = a[8];  a[8]  = ROTL(t, 45); t = b0;
    b0 = a[21]; a[21] = ROTL(t, 55); t = b0;
    b0 = a[24]; a[24] = ROTL(t,  2); t = b0;
    b0 = a[4];  a[4]  = ROTL(t, 14); t = b0;
    b0 = a[15]; a[15] = ROTL(t, 27); t = b0;
    b0 = a[23]; a[23] = ROTL(t, 41); t = b0;
    b0 = a[19]; a[19] = ROTL(t, 56); t = b0;
    b0 = a[13]; a[13] = ROTL(t,  8); t = b0;
    b0 = a[12]; a[12] = ROTL(t, 25); t = b0;
    b0 = a[2];  a[2]  = ROTL(t, 43); t = b0;
    b0 = a[20]; a[20] = ROTL(t, 62); t = b0;
    b0 = a[14]; a[14] = ROTL(t, 18); t = b0;
    b0 = a[22]; a[22] = ROTL(t, 39); t = b0;
    b0 = a[9];  a[9]  = ROTL(t, 61); t = b0;
    b0 = a[6];  a[6]  = ROTL(t, 20); t = b0;
    a[1] = ROTL(t, 44);
    // chi
    for (int y = 0; y < 25; y += 5) {
      b0 = a[y]; b1 = a[y+1]; b2 = a[y+2]; b3 = a[y+3]; b4 = a[y+4];
      a[y]   = b0 ^ (~b1 & b2);
      a[y+1] = b1 ^ (~b2 & b3);
      a[y+2] = b2 ^ (~b3 & b4);
      a[y+3] = b3 ^ (~b4 & b0);
      a[y+4] = b4 ^ (~b0 & b1);
    }
    // iota
    a[0] ^= RC[r];
  }
}

// fixed: lanes 0..10 and lane 11 (low 32 bits used), little-endian as absorbed
// target_hi: first 8 bytes of the target as a big-endian number (cheap pre-filter; host re-checks)
// out[0] = count, out[1..] = nonce2 values of candidates
__kernel void search(__constant const ulong *fixed, const ulong base, const ulong target_hi,
                     __global volatile ulong *out, const uint max_out)
{
  ulong a[25];
  const ulong n = base + get_global_id(0);
  const ulong be = bswap64(n);
  #pragma unroll
  for (int i = 0; i < 11; i++) a[i] = fixed[i];
  a[11] = (fixed[11] & 0xffffffffUL) | (be << 32);
  a[12] = (be >> 32) | (0x06UL << 32);
  a[13] = 0; a[14] = 0; a[15] = 0;
  a[16] = 0x8000000000000000UL;
  #pragma unroll
  for (int i = 17; i < 25; i++) a[i] = 0;
  keccakf(a);
  if (bswap64(a[0]) <= target_hi) {
    uint i = atomic_inc((__global volatile uint *)out);
    if (i < max_out) out[1 + i] = n;
  }
}
