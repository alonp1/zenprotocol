# Zen Protocol light wallet: byte-level protocol specification

Target: an independent JavaScript light wallet that runs in a browser, keeps keys on the device, talks to a Zen Protocol node over HTTP, and is 100% compatible with mainnet.

Source of truth: the F# node in `src/` (repository HEAD `a07401e`). Every rule below cites `path:line` relative to `src/`. Nothing in this document modifies the repository.

## 0. Conventions and how much of this is verified

Provenance tags used throughout:

| Tag | Meaning |
|---|---|
| **[FIXTURE]** | Verified byte-for-byte against a value hard-coded in the F# test suite or source (the F# test asserts it). |
| **[MAINNET]** | Verified against real mainnet data embedded in the repo (mainnet block #11249 in `SerializationBenchmark/Program.fs:10`): an independent decoder parsed all 12 transactions, re-encoded them byte-identically, recomputed every txHash, and verified all 234 PK-witness signatures. |
| **[CODE]** | Derived by reading the F# code; not covered by a fixture. Needs a cross-check (Section 9). |
| **[LIB]** | Behaviour of an external library that is not in the repo (NBitcoin 4.1.1.72, FsBech32 0.1.5, BouncyCastle 1.8.4, FSharp.Core, zen_secp256k1 0.1.0.26). Verified indirectly by a fixture where noted. |

Notation: `||` is byte concatenation. `BE32(x)` is a 4-byte big-endian unsigned integer, and `BE64(x)` is 8 bytes. `SHA3(x)` is FIPS-202 SHA3-256. Hex is lowercase.

### 0.1 Summary of primitives

| Item | Rule | Status |
|---|---|---|
| Mnemonic to seed | BIP39, PBKDF2-HMAC-SHA512, 2048 iterations, salt `"mnemonic"` and empty passphrase, 64 bytes | [FIXTURE] |
| Seed to master key | BIP32 (`HMAC-SHA512(key="Bitcoin seed")`), secp256k1 | [FIXTURE] |
| Account path | `m/44'/258'/0'` | [FIXTURE] |
| Address paths | `.../0/0` main receive address, `.../1/0` the only change address, `.../2/i` "new" addresses | [CODE]; `0/0` and `1/0` are [FIXTURE] |
| Public key | 33-byte compressed SEC1 | [FIXTURE] |
| Hash | SHA3-256 (FIPS 202, padding 0x06), not Keccak-256 | [FIXTURE] |
| pkHash | `SHA3(compressedPubKey33)` | [FIXTURE] |
| Address | Original Bech32 (BIP-173 checksum, not bech32m). HRP is `zen` on mainnet and `tzn` on testnet; contract addresses use `czen` and `ctzn`. Data is `[0x00] ++ toWords(payload)` | [FIXTURE] |
| Tx hash | `SHA3(serialize(tx WITHOUT witnesses))`. The contract field is included. | [FIXTURE] [MAINNET] |
| Signature | ECDSA secp256k1 over the raw 32-byte message (no extra hashing), RFC6979 deterministic nonce, low-S, 64-byte compact `r‖s` | [FIXTURE] [MAINNET] |
| PK witness | `VarInt(1) VarInt(98) sighash(1) pubkey(33) sig(64)`, with `sighash` 0x01 (TxHash) or 0x03 (FollowingWitnesses) | [FIXTURE] [MAINNET] |
| Fee | An explicit output with the `Fee` lock. Consensus has no minimum fee, and the mempool and miner do not set one either. | [CODE] |

---

## 1. Mnemonic, seed and keys

### 1.1 Code path

`Wallet/ExtendedKey.fs:58-65`:

```fsharp
let fromMnemonicPhrase (mnemonicPhrase:string) =
    try
         let mnemonicSentence = new NBitcoin.Mnemonic(mnemonicPhrase, NBitcoin.Wordlist.English)
         mnemonicSentence.DeriveSeed ()
         |> create
    with _ as ex ->
        Error ex.Message
```

`Wallet/ExtendedKey.fs:50-56`: `create seed = ExtendedPrivateKey (new ExtKey(seed))`, which is NBitcoin's BIP32 master key.

`Wallet/ExtendedKey.fs:16-17` defines `preSeed = "Bitcoin seed"`, but the literal is **unused**. The HMAC key comes from NBitcoin's `ExtKey(seed)`, which uses the BIP32 constant `"Bitcoin seed"`.

### 1.2 Rules

1. **Wordlist.** BIP39 English (`ExtendedKey.fs:60`). The node API joins the words with a single space (`Wallet/Account.fs:42`: `String.concat " " mnemonicPhrase`).
2. **Seed.** `DeriveSeed()` is called with no passphrase (`ExtendedKey.fs:62`). [LIB] NBitcoin uses PBKDF2-HMAC-SHA512, the NFKD-normalized mnemonic as the password, `"mnemonic" + ""` as the salt, 2048 iterations and a 64-byte output. This is standard BIP39 with an **empty passphrase**. The node never uses a BIP39 passphrase anywhere: `fromMnemonicPhrase` has no passphrase parameter.
3. **Master key.** Standard BIP32: `I = HMAC-SHA512(key = "Bitcoin seed", data = seed)`, with `IL` as the master private key and `IR` as the chain code. The curve is secp256k1.
4. **Child derivation.** Standard BIP32 `CKDpriv` and `CKDpub` (`ExtendedKey.fs:67-83` calls NBitcoin `ExtKey.Derive(uint32 i)`). An index `>= 0x80000000` is hardened. Deriving a hardened child from an extended *public* key fails.
5. **Path syntax** (`Wallet/KeyPathParser.fs`):
   - The path must start with `m/` (`:56-57`).
   - Each component is decimal digits, optionally followed by `'`, which adds `0x80000000` (`:26-27`).
   - `h` and `H` are **not** accepted as hardened markers.
   - A trailing `/` is allowed (`zenKeyPath` is `"m/44'/258'/0'/"`). Values that overflow `int32` are rejected (`:10-11`).
6. **Account key.** `zenKeyPath = "m/44'/258'/0'/"` (`Wallet/Account.fs:20`). The 258 is Zen Protocol's SLIP-44 coin type.
7. **Address branches** (`Wallet/Account.fs:22-39`):

   | Branch | Path | Node-wallet usage |
   |---|---|---|
   | External | `m/44'/258'/0'/0/i` | Only **i = 0** is ever created (`Account.fs:49-55`). This is the address `/wallet/address` returns (`Account.fs:118-120`). It is also the `returnAddress` the node adds to contract calls (`TransactionCreator.fs:270`). |
   | Change | `m/44'/258'/0'/1/i` | Only **i = 0** is ever created (`Account.fs:57-63`). All change goes to `1/0` (`TransactionCreator.fs:85-86`: `PK account.changePKHash`). |
   | Payment | `m/44'/258'/0'/2/i` | Created on demand by `/wallet/getnewaddress`: index `counter`, then `counter+1`, and so on (`Account.fs:126-155`). `/wallet/restorenewaddresses {max}` pre-creates indices `counter..max` (`Account.fs:146-151`). |

   - The node wallet spends from all non-watch-only addresses (`TransactionCreator.fs:27-32`). It signs each input with the key of the address that owns it (`TransactionCreator.fs:121-131`).
   - `/wallet/keys` lists `(publicKey, path)` for all of these addresses (`Account.fs:544-561`). The repo's own voting test helper uses this list to sign votes (`Api.Tests/TestingLib.fs:226-244`).
   - The separate Electron desktop wallet (`--connectwallet`) is not in this repo. See Open questions, Q6.

   **Light-wallet recommendation:**
   - Scan `0/0` and `1/0`, plus `2/0..2/N` with a gap limit.
   - For robustness against other wallets, also scan `0/i` and `1/i` for `i > 0`.
   - Use `/addressdb/discovery` (Section 8) for the scan.
8. **Account xpub string.** `ExtendedKey.toString` uses NBitcoin `Network.Main`, which gives `xpub` and `xprv`, on mainnet. Every other chain uses `Network.TestNet`, which gives `tpub` (`ExtendedKey.fs:110-115`). `/wallet/zenpublickey` returns the neutered account key `m/44'/258'/0'` (`Account.fs:44-47,114-116`).

### 1.3 Verification

The F# test `Api.Tests/WalletTests.fs:97-98` imports the mnemonic `feel muffin volcano click mercy abuse bachelor ginger limb tomorrow okay input spend athlete boring security document exclude liar dune usage camera ranch thought` (`Consensus.Tests/Helper.fs:10`). It expects the public key at `m/44'/258'/0'/0/0` (`Api.Tests/Constants.fs:19-20`) to be `02b43a1cb4cb6472e1fcd71b237eb9c1378335cd200dd07536594348d9e450967e`.

It also expects the testnet account xpub (`WalletTests.fs:116`) to be `tpubDCeTZv9MDcNe6Ahv8UQaoAWhK9XKmpzzJjpiVbCZ4jhsJYdN67Qh18nDjuJFtWfGfLL2hRkGid6Ga5h2FoW9QoRjdcEUQRBW4tkpkCbMtKb`.

Standard BIP39 and BIP32 code (`@scure/bip39` and `@scure/bip32`) with an empty passphrase reproduces both values exactly. **[FIXTURE]**

### 1.4 Mnemonic validation caveat

[LIB] It is not visible in the repo whether `NBitcoin.Mnemonic(string, Wordlist)` rejects a bad BIP39 checksum. See Q1.

The wallet should do two things:
- validate the checksum strictly when it **creates** a mnemonic;
- when it **restores**, offer to proceed on a checksum failure after warning the user, because the seed derivation (PBKDF2 over the text) does not depend on the checksum.

Word counts other than 12, 15, 18, 21 and 24 are rejected by NBitcoin [LIB]. The official tooling generates 24 words (`Api.Tests/TestingLib.fs:291`).

---

## 2. Public key serialization and PK hash

`Consensus/Crypto.fs`:

- `SerializedPublicKeyLength = 33` (`:132-133`). `PublicKey.serialize` calls `secp256k1_ec_pubkey_serialize(..., SECP256K1_EC_COMPRESSED)` (`:167-175`). The result is SEC1 compressed: `0x02` or `0x03`, followed by 32-byte X.
- `PublicKey.deserialize` accepts only 33-byte input (`:177-183`). Uncompressed 65-byte keys are never valid on the wire.
- `PublicKey.hash = serialize >> Hash.compute` (`:189`), which is `pkHash = SHA3-256(compressed33)`.
- `Hash.compute` uses BouncyCastle `Sha3Digest(256)` (`Consensus/Hash.fs:21-26`).

**It is FIPS-202 SHA3-256, not Keccak-256.** Proof:
- The testnet voting contract id `e89738718a80…22c8ab` (`Consensus/Chain.fs:84`) equals Python `hashlib.sha3_256(BE32(0) || utf8(code))` of the code in `Blockchain.Tests/Tally.Tests/Voting Contractract.fs:3` (the formula is from `Consensus/Contract.fs:135-142`).
- The pkHash `30759b07ca01caf8e524fc279946a1e96afc3546ee5f1fd4a1cfaf644763c2b4` of the fixture key above appears in `Api.Tests/Constants.fs:84`.

**[FIXTURE]**

- `PublicKey.toString` gives lowercase hex of the 33 bytes (`Crypto.fs:185`). Lowercase output is evidenced by `WalletTests.fs:98`.
- Internally, libsecp256k1 keeps 64-byte opaque structs for public keys and signatures (`Crypto.fs:127,130`). These never appear on the wire.

---

## 3. Addresses

`Wallet/Address.fs`:

```fsharp
let AddressVersion = 0uy                                   // :11
let private contractAddressIdentifier = "c"               // :22
let private mainChainIdentifier = "zen"                    // :25
let private testChainIdentifier = "tzn"                    // :28  (Test and Local)
let encode chain address =                                 // :36-50
    let bytes = match address with
                | PK hash -> Hash.bytes hash                       // 32 bytes
                | Contract contractId -> ContractId.toBytes contractId  // 36 bytes
    let hrp = String.concat "" [ (if Contract then "c" else ""); "zen"|"tzn" ]
    let words = Bech32.toWords bytes
    let data = Array.append [|AddressVersion|] words
    Bech32.encode hrp data
```

### 3.1 Encoding rules

- **Payload.**
  - PK address: the 32-byte `pkHash`.
  - Contract address: `ContractId.toBytes`, which is **`BE32(version) || contractHash(32)`**, 36 bytes (`Consensus/ContractId.fs:7-8`). This is not the VarInt form used inside transactions (Section 4.4).
- **Data part.** The 5-bit word `0` (the version, which shows as `q`), followed by `convertbits(payload, 8→5, pad=true)`. The version is a whole 5-bit word, not a byte. Unlike segwit, there is no separate witness-program length rule.
- **Checksum.** Original Bech32 (BIP-173 constant `1`), **not** bech32m. **[FIXTURE]** For key `0/0` of the fixture mnemonic, `tzn1qxp6ekp72q8903efylsnej34pa940cd2xae03l49pe7hkg3mrc26qyh2rgr` appears in `Api.Tests/Constants.fs:47,85`, and a BIP-173 encoder reproduces it.

  **[FIXTURE]** The contract address `ctzn1qqqqqqqrqm6z6y9y9p0mpjtnugst0hn908n7vp2f8m44hwznsluydyszx6vjk2kpw` (`Constants.fs:219`) decodes with the BIP-173 checksum to `0000000060de85a2…46d3`, which is the contractId at `Constants.fs:218`.
- **HRPs.**

  | Chain | PK address | Contract address |
  |---|---|---|
  | mainnet | `zen` | `czen` |
  | testnet and local | `tzn` | `ctzn` |

- **Lengths.** A PK address is 63 characters (`zen1` + 1 + 52 + 6). A contract address is 70 characters. Both are under the BIP-173 limit of 90.

### 3.2 Decoding rules

Source: `Address.fs:59-147`.

1. Run `Bech32.decode`.
2. A PK address requires HRP length 3, equal to the chain identifier.
3. A contract address requires HRP length 4, starting with `c`, with the remaining three characters equal to the chain identifier.
4. The first data word must be `0`.
5. `fromWords(rest)` must yield exactly 32 bytes (PK) or 36 bytes (contract).
6. `decodeAny` (`:141-147`) treats the input as PK if it starts with `"zen"`/`"tzn"`, and as a contract otherwise.

[LIB] FsBech32's case-handling, padding and max-length checks are not visible in the repo. Emit lowercase only, and see Q2.

### 3.3 Mainnet constants

Source: `Consensus/Chain.fs:56-57`.

- CGP contract id: `00000000cdaa2a511cd2e1d07555b00314d1be40a649d3b6f419eb1e4e7a8e63240a36d1`
- Voting contract id: `000000006ea5457ed23e3e13f31fe4cfd46c200587f2e4cc22df30ac77790f6d2c15cc12`

The string form of a ContractId is `hex(BE32(version) || hash)` (`Consensus/Types.fs:20-27`). The contract hash is `SHA3(BE32(version) || UTF8(code))` (`Consensus/Contract.fs:135-142`).

---

## 4. Transaction model and serialization

All integers are **big-endian** (`Consensus/Serialization.fs:83-105`). The serializer computes the size first, allocates a zero-filled buffer, and then writes (`:107-115`). Deserialization does **not** require all input to be consumed (`:117-132`). `deserializeNonZero` rejects an all-zero buffer.

### 4.1 Types

Source: `Consensus/Types.fs`.

```fsharp
type Outpoint = { txHash: Hash; index: uint32 }                       // :13-16
type ContractId = ContractId of uint32 * Hash                          // :19
type Asset = Asset of ContractId * Hash   // (contractId, subType)     // :29
type Spend = { asset: Asset; amount: uint64 }                          // :43-46
type Input = | Outpoint of Outpoint | Mint of Spend                    // :48-50
type Lock = | PK of Hash | Contract of ContractId | Coinbase of uint32 * Hash
            | Fee | ActivationSacrifice | ExtensionSacrifice of ContractId
            | Destroy | HighVLock of uint32 * byte[]                    // :65-73
type Output = { lock: Lock; spend: Spend }                             // :75-78
type SigHash = | TxHash | FollowingWitnesses | UnknownSigHash of uint8 // :110-113
type Witness = | PKWitness of SigHash * PublicKey * Signature
               | ContractWitness of ContractWitness
               | HighVWitness of uint32 * byte[]                       // :115-118
type Transaction = { version: uint32; inputs: Input list; outputs: Output list;
                     witnesses: Witness list; contract: Contract option } // :144-150
```

The ZP asset is `Asset(ContractId(0, zero32), zero32)` (`Consensus/Asset.fs:9`). Its string form is `"00"` (`Types.fs:33-35`).

### 4.2 Primitive encodings

| Name | Encoding | Source |
|---|---|---|
| Byte | 1 byte | `Serialization.fs:148-151` |
| number2, 4, 8 | big-endian, 2, 4 or 8 bytes | `:86-105` |
| **VarInt** (uint32) | Bitcoin Core `WriteVarInt`/`ReadVarInt` (serialize.h "VARINT"): MSB-first base-128, the continuation bit `0x80` is set on all but the last byte, and the encoder subtracts 1 after each shift. This is **not** CompactSize and **not** LEB128. | `:184-222` |
| Bytes | `VarInt(len) || bytes` | `:227-239` |
| String | `VarInt(len) || ASCII(s)`. Non-ASCII is not representable. | `:254-265` |
| Option | `0x00` for None, or `0x01 || value` for Some | `:153-182` |
| List, Seq, Array | `VarInt(count) || items` | `:267-312` |
| Hash | 32 raw bytes | `:247-252` |

VarInt reference (verified by round-trips; multi-byte counts such as 139 outputs and 208 witnesses occur in the **[MAINNET]** data):

| Value | 0 | 127 | 128 | 255 | 256 | 16383 | 16511 | 16512 | 65535 | 2^32-1 |
|---|---|---|---|---|---|---|---|---|---|---|
| Encoding | `00` | `7f` | `8000` | `807f` | `8100` | `fe7f` | `ff7f` | `808000` | `82fe7f` | `8efefefe7f` |

```fsharp
// Serialization.fs:194-209 (write)
let tmp = Array.zeroCreate 5
let rec loop n len =
    tmp.[len] <- (byte (n &&& 0x7Ful)) ||| (if len <> 0 then 0x80uy else 0x00uy)
    if n <= 0x7Ful then len else loop ((n >>> 7) - 1ul) (len + 1)
let len = loop x 0
let bytes = Array.rev tmp.[0..len]
// read (:211-222): n = (n <<< 7) ||| (b &&& 0x7F); if b &&& 0x80 then n <- n + 1 and continue
```

### 4.3 Amount (uint64)

This is a decimal-float-like compressed encoding (`Serialization.fs:485-607`). Factor `amount = s × 10^e`, with `s` not divisible by 10, and let `f` be the number of decimal digits of `s`. For amount 0: `s=0, e=0, f=0`.

| Condition | Bytes | Layout |
|---|---|---|
| `f <= 3` | 2 | `BE16(s | e<<10)` (`:505-508`) |
| `4 <= f <= 8` | 4 | If `e > 12`, then `s := s·10^(e-12)` and `e := 12` (`:546-550`).<br>If `s < 2^26`: `BE32(s | (0x20|e)<<26)`.<br>Otherwise: `BE32((s-2^26) | (0x60|e)<<25)` (`:511-518`). |
| `f >= 9` and `amount < 2^56` | 8 | `BE64(0x7E<<56 | amount)` (`:519-521`) |
| `amount >= 2^56` | 9 | `0xFE || BE64(amount)` (`:522-524`) |

The decoder (`:556-607`):
- rejects a first byte with `(b&0x7E)=0x7C` or `(b&0x7C)=0x78` (the NaN and Inf patterns);
- dispatches on `(b&0x7E)=0x7E` to 8 or 9 bytes, `b<0x80` to 16 bits, and anything else to 32 bits;
- also accepts a "non-canonical" 16-bit form `(first&0x60)=0x60`. Never emit it.

Examples. Round-tripped in the reference codec. 5000000000 and 2299999999999 also occur in **[FIXTURE]** and **[MAINNET]** data.

| amount | 0 | 1 | 10 | 999 | 1000 | 1001 | 1e8 (1 ZP) | 5e9 | 12345678 |
|---|---|---|---|---|---|---|---|---|---|
| hex | `0000` | `0001` | `0401` | `03e7` | `0c01` | `800003e9` | `2001` | `2405` | `80bc614e` |

| amount | 99999999 | 67108864 | 123456789 | 2299999999999 | 2e15 | 1.2345e18 | 2^56-1 | 2^56 |
|---|---|---|---|---|---|---|---|---|
| hex | `c1f5e0ff` | `c0000000` | `7e000000075bcd15` | `7e00021782aed7ff` | `3c02` | `b012d644` | `7effffffffffffff` | `fe0100000000000000` |

### 4.4 ContractId inside transactions

`VarInt(version) || hash32` (`Serialization.fs:337-348`). For version 0 this is `00 || hash`. This differs from the address and string form, which is `BE32(version) || hash`.

### 4.5 Asset

Source: `Serialization.fs:353-483`.

```fsharp
// write (:393-414)
let vbs = versionBytes version            // 1..5 bytes, see :357-376 (version < 32 -> [version])
if cHash = Hash.zero && subtype = Hash.zero then write vbs                      // ZP -> 0x00
else match lastNonZeroIndex subtype with
     | None            -> vbs.[0] <- 0x80 ||| vbs.[0]; write vbs; write cHash  // subtype zero
     | Some n when n<30 -> vbs.[0] <- 0x40 ||| vbs.[0]; write vbs; write cHash; byte (n+1); sb.[0..n]
     | Some _          -> vbs.[0] <- 0xC0 ||| vbs.[0]; write vbs; write cHash; write subtype(32)
```

| Asset | Encoding |
|---|---|
| ZP (`"00"`) | `00` |
| version 0 contract `H`, subtype zero | `80 || H` |
| version 0, subtype `0102 00…00` | `40 || H || 02 || 0102` |
| version 0, subtype with byte 30 or 31 non-zero | `c0 || H || subtype32` |
| version 1, subtype zero | `81 || H` |

Asset string form (API and JSON):
- `"00"` for ZP;
- otherwise `hex(BE32(version) || cHash)` (72 hex characters) when the subtype is zero;
- otherwise `hex(BE32(version) || cHash || subType)` (136 hex characters).

Sources: `Types.fs:29-41`, `Asset.fs:20-36`.

The decoder enforces canonical forms (`:468-483`).

`checkStructure` rejects any spend whose `cHash = zero` while `version ≠ 0` or `subType ≠ zero`, and any spend with **amount 0** (`TransactionValidation.fs:199-201,234-247`).

### 4.6 Spend, Outpoint, Input, Output

- Spend is `Asset || Amount` (`:609-619`).
- Outpoint is `txHash(32) || VarInt(index)` (`:621-630`).
- Input is `0x01 || Outpoint` or `0x02 || Spend` (Mint) (`:632-661`).
- Output is `Lock || Spend` (`:1240-1250`).

### 4.7 Lock

Each lock is `VarInt(identifier) || VarInt(payloadLength) || payload` (`Serialization.fs:785-879`). On read, the decoder checks that `payloadLength` equals the computed payload size (`:876-879`).

| Lock | id | Payload | Example |
|---|---|---|---|
| Fee | 1 | none | `0100` |
| PK | 2 | pkHash (32) | `0220 || pkHash` |
| ActivationSacrifice | 3 | none | `0300` |
| Contract | 4 | ContractId (VarInt version + 32) | `0421 00 || hash` |
| ExtensionSacrifice | 5 | ContractId | `0521 00 || hash` |
| Coinbase | 6 | `BE32(blockNumber) || pkHash` | `0624 || BE32(n) || pkHash` |
| Destroy | 7 | none | `0700` |
| HighVLock | ≥ 8 | raw bytes | (not used by a wallet) |

### 4.8 Contract field (activation only; `None` for wallet transactions)

`Option(Contract)`. A V0 contract is `VarInt(0) || VarInt(len) || String(code) || String(hints) || VarInt(rlimit) || VarInt(queries)` (`:1264-1325`).

### 4.9 Witnesses

Each witness is `VarInt(identifier) || VarInt(payloadLength) || payload` (`Serialization.fs:1128-1239`).

**PK witness** (identifier 1, payload length 98 = `0x62`):

```
01 62 | sighash(1) | compressedPubKey(33) | compactSig(64)
```

The sighash byte is `0x01` for TxHash or `0x03` for FollowingWitnesses. Any other byte is read as `UnknownSigHash` and rejected at validation (`:1102-1126`, `InputValidation/PK.fs:21,28-29`).

**Contract witness** (identifier 2) (`:1137-1180`):

```
ContractId (VarInt version || hash32)
String command
Option(Data) messageBody
StateCommitment: 01 = NoState | 02 || hash32 = State | 03 = NotCommitted   (:1065-1100)
VarInt beginInputs, VarInt beginOutputs, VarInt inputsLength, VarInt outputsLength
Option(publicKey33 || compactSig64) signature
BE64 cost
```

**Hazard: the Data `List` size quirk [CODE].** `Data.size` adds 1 extra byte for every `Collection (List …)` node (`Serialization.fs:967-968` adds `Byte.size` on top of the `Byte.size` at `:970`), but `Data.write` writes only one tag byte (`:1011-1013`). Consequences:

- (a) A contract witness whose `messageBody` contains k list nodes carries `payloadLength = actual + k`. `Witness.read` recomputes the size with the same quirk (`:1236`), so it accepts only that inflated value.
- (b) `serialize` returns a buffer with k trailing zero bytes.

The vote body in Section 7 contains **no** List, so voting is unaffected. The CGP payout body (`CGP.fs:122-153`) does contain lists. A JS encoder must reproduce the quirk for any witness that contains a Data List. See Q5.

### 4.10 Transaction

Source: `Serialization.fs:1416-1446`.

```
BE32 version (must be 0, TransactionValidation.fs:188-192)
List<Input>
List<Output>
Option<Contract>
List<Witness>          <- only in "Full" mode
```

- `txHash = SHA3(serialize WithoutWitness tx)`. This covers everything up to and including the contract option byte (`Consensus/Transaction.fs:9-10`).
- `witnessHash = SHA3(serialize Full tx)` (`:19-21,26-31`).
- `Transaction.toHex` is the lowercase hex of the Full serialization (`:12-13`).

**[FIXTURE]** `Api.Tests/WalletTests.fs:350` contains the node's own signed transaction. The fixture mnemonic spends `835300…2f17:0` (2300000000000 kalapa) to `tzn1q9v8sc0js…hhpf` (1 kalapa), with change 2299999999999 going to `1/0`:

```
00000000                                  version 0
01                                        1 input
  01 835300081736d721821c6316bd8f2324ce973e02ab3e579e1230c30bd5f02f17 00   outpoint, index 0
02                                        2 outputs
  02 20 2b0f0c3e50543dea575f330d86a3dd01a39c97c352243352139b799ff533c3bd  00 0001
  02 20 9b95835b9af67bdc345c0ae879b93a58d0f3f90784c982a2da52fbd71d8700a3  00 7e00021782aed7ff
00                                        contract = None   <- txHash covers up to here
01                                        1 witness
  01 62 01 02b43a1cb4cb6472e1fcd71b237eb9c1378335cd200dd07536594348d9e450967e
        0b6be83f6eb9f27d76020f1805d08aac2a3f38860177ff5ebd2cb32081094d04
        4474e9636c3ee6c5b599ef9e93268d5d80c4abf1d4625e8e95c0ed5d6741d9b1
```

- `txHash = 03ae57cd8ee6339ad138bf2c1c7dae7b3571d839bc987a818d8c067a7801a784`. This equals the hash the test expects (`Api.Tests/Constants.fs:95`).
- The signature above is reproduced exactly by RFC6979 ECDSA over `txHash` with the private key of `m/44'/258'/0'/0/0` (`2cedf1100af6492360defca523c7bbb2770783b18690bf5d9277f5f49c755ebd`).

### 4.11 TxSkeleton (body of `/blockchain/contract/execute`)

Source: `Serialization.fs:1628-1681`. Here an input carries the full spent output:

```
List<SkInput>  where SkInput = 0x01 || Outpoint || Output   (PointedOutput)
                             | 0x02 || Spend                 (Mint)
List<Output>
```

### 4.12 Data (Zen.Types.Data, used for contract message bodies)

Source: `Serialization.fs:881-1063`.

| Tag | Variant | Payload |
|---|---|---|
| 1 | I64 | BE64 (two's complement) |
| 2 | Byte | 1 byte |
| 3 | ByteArray | `VarInt(len) || bytes` |
| 4 | U32 | BE32 |
| 5 | U64 | BE64 |
| 6 | String | `VarInt(len) || ASCII` |
| 7 | Hash | 32 bytes |
| 8 | Lock | the Lock encoding (4.7) |
| 9 | Signature | 64-byte compact `r‖s` |
| 10 | PublicKey | 33-byte compressed |
| 11 | Array | `VarInt(n) || Data*` |
| 12 | Dict | `VarInt(n) || (String key || Data value)*`, **keys in sorted order** |
| 13 | List | `VarInt(n) || Data*` (see the size quirk in 4.9) |

**Dict key order.**
- Keys are `Prims.string`, which is `byte[]` of ASCII (`Consensus/ZFStar.fs:26-32`).
- The writer emits `Map.toList` order (`:1006-1010`, `:319-321`).
- The reader rejects input whose `(key, value)` pairs are not non-decreasing (`:322-333`).

[LIB] FSharp.Core's structural comparison of `byte[]` compares **length first, then bytes unsigned**. So the order is **shorter keys first**: `"Signature"` (9 bytes) sorts **before** `"Allocation"` (10 bytes), even though ordinal string order would put it after. This is not visible in repo code (Q4).

Two runtime checks are available:
- `/blockchain/contract/execute` answers `400 "Invalid data: deserializing"` if the order is wrong.
- The witness the node returns contains the node's re-serialization of the body, so the wallet can compare it with its own bytes.

### 4.13 Message (only for a signed contract call, Section 5.3)

`ContractId(VarInt) || String command || Option<Data> body` (`Serialization.fs:1613-1622`).

---

## 5. Signing

### 5.1 Algorithm

- **Curve and scheme.** ECDSA over secp256k1 through a native libsecp256k1 binding, `DllImport("secp256k1")` (`Consensus/Crypto.fs:53-121`), from the package `zen_secp256k1 0.1.0.26` (`paket.lock:148`).
- **Signing call.** `secp256k1_ecdsa_sign(ctx, sig, msg32, seckey, noncefp = NULL, ndata = NULL)` (`Crypto.fs:226-231`). A NULL `noncefp` means libsecp256k1's default nonce function, which is RFC6979 (HMAC-SHA256), with no extra entropy.
- **Message.** The **32-byte message is signed as-is**, with no additional hashing.
- **Signature serialization.** `secp256k1_ecdsa_signature_serialize_compact`, which is 64 bytes `r(32,BE) || s(32,BE)` (`Crypto.fs:191-197`). It is not DER, and there is no recovery byte.
- **Verification.** `secp256k1_ecdsa_verify` (`Crypto.fs:233-236`) rejects high-S signatures [LIB], so **the wallet must emit low-S signatures**.

**[FIXTURE] [MAINNET]** RFC6979 with low-S reproduces the F# fixture signature byte-for-byte. All 234 mainnet witnesses verify against `txHash`, and none is high-S.

In `@noble/curves`: `secp256k1.sign(msg32, priv, { lowS: true }).toCompactRawBytes()`. Do not pass `prehash`.

### 5.2 Which message a PK witness signs

Source: `Consensus/Transaction.fs:36-57` (signing) and `Consensus/InputValidation/PK.fs:11-31` (validation).

```fsharp
let msg = match sigHash with
          | TxHash -> txHash
          | FollowingWitnesses ->
              let witnessesHash = Serialization.Witnesses.hash tx.witnesses   // the witnesses AFTER this one
              Hash.joinHashes [ txHash; witnessesHash ]
```

- `TxHash` (byte `0x01`): `msg = txHash`.
- `FollowingWitnesses` (byte `0x03`): `msg = SHA3(txHash || SHA3(VarInt(k) || witness_1 … witness_k))`. The witnesses are those that **follow** this PK witness in the list, serialized as in 4.9 (`Serialization.fs:1607-1611`, `Hash.fs:30-42`). Validation hashes exactly the tail of the witness list after the current witness (`PK.fs:18-19`).

### 5.3 Witness order and input matching (consensus)

Source: `Consensus/InputValidation/StateMachine.fs:9-41`.

Validation walks the **inputs in order**:
- For each PK-locked input, and for each Coinbase-locked input once mature, it consumes the **next** witness, which must be a `PKWitness`. `SHA3(pubkey)` must equal the lock's pkHash (`PK.fs:12-15`).
- For a Contract-locked input or a Mint, it consumes the next `ContractWitness` (`StateMachine.fs:14-18`).
- When the inputs are exhausted, validation stops and returns `Valid`. **Witnesses left over are not executed** (`StateMachine.fs:11`).

Consequences:
- **Use one PK witness per PK input**, in the same order as the inputs, even when several inputs belong to the same address. This is what the node does (`TransactionCreator.fs:118-147`).
- The witness list must be non-empty (`TransactionValidation.fs:249-263`).
- **Coinbase outputs** need `(tipHeight + 1) − lockBlockNumber >= 100` on mainnet (`InputValidation/Coinbase.fs:11-15`, `Chain.fs:55`).

### 5.4 How the node signs

Source: `Transaction.fs:36-57`.

```fsharp
// We sign from last to first
// Only the last get signed with the initial sigHash, the rest get signed with TxHash
List.foldBack (fun keyPair (tx,sigHash) -> let tx = sign keyPair sigHash tx in tx,TxHash) keyPairs (tx,initialSigHash)
```

Each new witness is **prepended**, so the final list is `[w_1(TxHash), …, w_{n-1}(TxHash), w_n(initialSigHash), …existing witnesses]`.

- **Ordinary send:** `initialSigHash = TxHash` (`TransactionCreator.fs:147`).
- **Contract execution:** `initialSigHash = FollowingWitnesses` (`TransactionCreator.fs:290`). The **last** PK witness commits to the contract witness(es) that follow it. The other PK witnesses sign plain `txHash`.

### 5.5 Contract-witness signature

This is optional and **not needed for voting**. It is used only when the node's `/wallet/contract/execute` is given `options.sign` (`TransactionCreator.fs:170-205`): `msg = SHA3(txHash || Message.serialize{recipient=cw.contractId; command; body})`. Validation is in `InputValidation/ContractV0.fs:118-154`.

---

## 6. Fees and transaction validity rules a wallet must satisfy

**Fees.**
- A fee is an output with lock `Fee` (`0100`) carrying an asset and amount. **For every asset, inputs must equal outputs exactly**, with the fee counted as an output (`TransactionValidation.fs:135-149`).
- **No minimum fee exists** in consensus, the mempool (`Blockchain/TransactionHandler.fs:80-151`) or the block template builder (`Blockchain/BlockTemplateBuilder.fs:150-163`). The template builder selects transactions by weight only and ignores fees.
- The node's own wallet:
  - pays **no fee** on sends (`TransactionCreator.fs:100-148`);
  - pays a **1-kalapa** `Fee` output on contract executions without spends (`TransactionCreator.fs:216-233`, "to avoid … all-mint inputs or same txhash");
  - pays `queries*rlimit/100` on activations (`:325`).
- Fee outputs go to the miner through the coinbase (`Consensus/Block.fs:155-166`).

**Basic validity checklist** (`TransactionValidation.fs:308-315`, `:363-376`):

1. `version = 0`.
2. `inputs` is non-empty, `outputs` is non-empty, and `witnesses` is non-empty.
3. No duplicate inputs, and the inputs are not all Mints.
4. No output with amount 0. No Coinbase lock in a normal transaction.
5. No `ActivationSacrifice` output unless `contract` is Some (and the other way round).
6. Per-asset sums must not overflow uint64, and inputs must equal outputs.
7. Every input is unspent. A missing input makes the transaction an orphan; a spent input is a double spend.
8. Witnesses are correct (Section 5.3).
9. Transaction weight must not exceed `maxBlockWeight = 8,000,000,000` (`Consensus/Weight.fs:75-83`, `Chain.fs:45`). The weight is `100·size + 100000·#PKwitness + 100·cost + 80000·#signedContractWitness`.

---

## 7. CGP voting: allocation vote, payout vote, payout nomination

### 7.1 Parameters (mainnet, `Consensus/Chain.fs:39-61`)

| Parameter | Value |
|---|---|
| `intervalLength` | 10000 |
| `snapshot` | 9000 |
| `nomination` | 500 |
| `coinbaseMaturity` | 100 |
| `allocationCorrectionCap` | 15 |
| `upperAllocationBound` | 90 |
| `thresholdFactor` | 3/100 |
| `votingContractId` | `000000006ea5…cc12` |
| `cgpContractId` | `00000000cdaa…36d1` |

Interval maths (`Consensus/CGP.fs:25-45`):

```fsharp
getInterval bn          = if bn > 0 then (bn - 1) / intervalLength + 1 else 1
getSnapshotBlock i      = (i - 1) * intervalLength + snapshot
endOfNominationBlock i  = getSnapshotBlock i + nomination
isNomineePhase bn       = snapshot(i) < bn && bn <= endOfNomination(i)    // i = getInterval bn
getLastIntervalBlock i  = intervalLength * i
```

For interval `N` on mainnet, with `base = 10000·(N−1)`:
- the snapshot is block `base+9000`;
- the **nomination phase** is blocks `base+9001 … base+9500`;
- the **voting phase** (allocation and payout) is blocks `base+9501 … base+10000`.

Votes in any other block are ignored (`Blockchain/Tally_Handler.fs:460-480`). A vote is a valid transaction anyway, and its fee is still paid.

### 7.2 How the node finds votes

Source: `Blockchain/Tally_Handler.fs:155-160, 283-292`.

- For each block, the node scans **every `ContractWitness` of every transaction** whose `contractId = votingContractId`, and takes `(command, messageBody)` from it.
- Only votes in transactions that are included in blocks count.
- The tally does **not** look at the contract-witness signature, the payer, or the sender. Voter identity comes **only** from signatures inside the message body.

### 7.3 Message body format

Source: `Blockchain/Tally_VoteParser.fs:98-113`.

```
Data.Dict {
   "<command>"  -> Data.String  <lowercase hex of Ballot.serialize ballot>      (getBallot, :44-47)
   "Signature"  -> Data.Dict { "<lowercase hex of 33-byte compressed pubkey>" -> Data.Signature sig64, ... }  (getSignatures, :49-52; parsePk :54-57)
}
```

- `command` is the contract-witness command string, and the dict key must be equal to it.
- Accepted ballot and command pairs (`parseBallot`, `:81-96`):
  - `Allocation` ballot with command `"Allocation"`;
  - `Payout` ballot with command `"Payout"` or `"Nomination"`.
- During the nomination phase, Payout ballots are recorded as nominations (`Tally_Handler.fs:318-334`). During the voting phase they are recorded as payout votes (`:294-316`).
- Every pubkey and signature pair is verified. **Invalid entries are silently dropped** (`:68-79`). Several addresses can vote in one body.

**Ballot serialization** (`Consensus/Serialization.fs:687-783`):

```
Allocation:  0x01 || allocationByte                         e.g. allocation 5%  -> "0105"
Payout:      0x02 || Recipient || List<Spend>
Recipient:   0x01 || pkHash32                 (PK)
           | 0x02 || VarInt(version) || hash32 (Contract)
```

Examples:
- Payout of 1 ZP to the PK `0265226b…309a`: `02 01 0265226b…309a 01 00 2001`.
- The mainnet "default" nominee, 1 kalapa to the CGP contract (`Blockchain/Tally_Nomination.fs:79-86`): `020200cdaa2a511cd2e1d07555b00314d1be40a649d3b6f419eb1e4e7a8e63240a36d101000001`.

**What each voter signs** (`Tally_VoteParser.fs:26-36`):

```fsharp
let hashBallot chainParam blockNumber ballotId =
    let interval    = CGP.getInterval chainParam blockNumber
    let isNominee   = CGP.isNomineePhase chainParam blockNumber
    let phase       = if isNominee then "Nomination" else "Vote"
    let serBallot   = ballotId |> String |> Data.serialize |> Base16.encode
    let serPhase    = phase    |> String |> Data.serialize |> Base16.encode
    let serInterval = interval |> U32    |> Data.serialize |> Base16.encode
    [serInterval; serPhase; serBallot] |> String.concat "" |> Encoding.Default.GetBytes |> Hash.compute
```

So `msg = SHA3( ASCII( hex(04 || BE32(interval)) || hex(06 || VarInt(len(phase)) || phase) || hex(06 || VarInt(len(ballotHex)) || ballotHex) ) )`.

- The hash input is the **ASCII text of lowercase hex**, not the binary.
- `ballotHex` is the exact string placed in the dict.
- Base16 output is lowercase: hex strings throughout the F# test expectations are lowercase (`WalletTests.fs:98,350`).

`blockNumber` is **the height of the block that includes the vote transaction** (`Tally_Handler.fs:287-291`). A transaction mined in a different interval or phase than the one the wallet signed for is silently ignored. The node's contract context uses `tip + 1` (`TransactionHandler.fs:167-171`). The wallet should sign for `blocks + 1` from `/blockchain/info`, and refuse to vote in the last few blocks of a phase.

**Worked example** (independently computed; to be cross-checked by Section 9): allocation 5%, block 2459600, interval 246, phase `Vote`.

```
preimage text  = "04000000f6" + "0604566f7465" + "060430313035"
hashBallot     = d37e15c7b7607ccca2771e8019f57e7947f142b47e7e69c480108ca56ddd2f02
```

Dict ordering follows 4.12 and is unverified (Q4). With the length-first key order, `"Signature"` is written before `"Allocation"`:

```
0c 02
   09 "Signature"  0c 01  42 "<66 hex chars of pubkey>"  09 <sig64>
   0a "Allocation" 06 04 "0105"
```

### 7.4 Vote weight and validity

**Weight.**
- The weight is the **ZP balance of `SHA3(pubkey)` at the snapshot block**, counting PK and Coinbase locks of asset ZP (`Tally_Handler.fs:215-271, 460-471`).
- Balances are frozen after the snapshot: blocks after it update the next interval's table.
- Weights are summed per ballot (`Blockchain/Tally.fs:87-90`).
- **Only the first vote of each public key counts** in each table (`Tally_Handler.fs:162-169`).

**Allocation validity** (`Blockchain/Tally_Voting.fs:27-57`, `Tally.fs:59-63`). Let `ratio = 100 − allocation`, `L = 100 − lastAllocation` and `cap = 100 − 15 = 85`.

A vote is valid if all of the following hold:
- `allocation <= 100`;
- `max(100 − 90, L·85/100) <= ratio`;
- `ratio <= min(100, L·100/85)`.

The divisions are integer divisions. The winner is the weighted median (`Tally_Voting.fs:105-136`).

**Nomination validity** (`Tally_Nomination.fs:26-70`):
- every spend amount is greater than 0;
- the CGP fund at the snapshot covers all spends;
- there are 1 to 100 spends;
- spends are **strictly sorted by asset**, using F# structural order on `(version, cHash bytes, subType bytes)`, and unique;
- the aggregated weight is at least 3% of the ZP issued at the snapshot (`Tally_Handler.fs:85-88`).

The CGP "1 kalapa to itself" nominee is always a candidate while the fund is non-empty.

**Payout vote validity.** The ballot must **equal** one of the candidates (`Tally_Voting.fs:59-64`). Fetch the candidates from `/blockchain/candidates` and copy the recipient and the spend list exactly.

### 7.5 Building, signing and publishing a vote transaction

The reference flow is the node's own (`TransactionCreator.fs:207-293`; test helper `Blockchain.Tests/TallyChainTest.fs:158-172`). **Voting requires executing the voting contract.** The node runs it through `/blockchain/contract/execute` (`Api/Server.fs:271-283`, `Blockchain/Handler.fs:137-139`), which returns the unsigned transaction with the contract witness. The wallet then signs it and publishes it.

1. **Get the context.** Call `GET /blockchain/info`, take `blocks`, and set `h = blocks + 1`. Check the phase. `GET /contract/active` must list the voting contract (check `contractId` and `expire`).
2. **Choose funding inputs.** Pick one or more unspent ZP outputs. Any address works; the payer is unrelated to the voters.
3. **Build the body.** Build the ballot and `msg = hashBallot(h)`. Sign `msg` with every voting key (raw 32-byte msg, RFC6979, low-S). Build the Data body (7.3) and `Data.serialize` it.
4. **Build the TxSkeleton** (4.11):
   - inputs: `PointedOutput(outpoint, outputFromAddressDB)` for each funding UTXO;
   - outputs: the change (PK lock), then `{lock: Fee, ZP, 1}`.

   This is the node's ordering: `addOutputs changeOutputs` then `addOutput feeOutput` (`TransactionCreator.fs:229-231`). It is not consensus-critical. Any fee ≥ 1 kalapa works, and so does a fee of 0 if you still have at least one non-zero output.
5. **Execute.** `POST /blockchain/contract/execute`:

   ```json
   {
     "address": "czen1…<votingContract>",
     "command": "Allocation",
     "messageBody": "<hex Data>",
     "options": {"sender": ""},
     "tx": "<hex TxSkeleton>"
   }
   ```

   The response is **text/plain hex** of a Full transaction:
   - inputs are the skeleton inputs as Outpoints;
   - outputs are the skeleton outputs, plus anything the contract added;
   - witnesses are `[ContractWitness{contractId=voting, command, messageBody, stateCommitment=NotCommitted(03), beginInputs=#inputs, beginOutputs=#outputs, inputsLength, outputsLength, signature=None, cost}]` (`TransactionHandler.fs:153-238`).
6. **Verify the response.** Do not trust the node:
   - inputs and outputs must equal what you sent, unless you accept contract-added items;
   - there must be exactly one contract witness, for `votingContractId`, with your command;
   - its `messageBody` bytes must equal yours.
7. **Sign** (5.4). Compute `txHash`. For PK inputs `1..n`, prepend witnesses so that the final list is `[pk_1(01) … pk_{n−1}(01), pk_n(03), contractWitness]`, where `pk_n` signs `SHA3(txHash || SHA3(VarInt(1) || contractWitness))`.
8. **Publish.** `POST /blockchain/publishtransaction {"tx": "<hex Full>"}` (Section 8).

Example (illustrative; `cost=5` is assumed because the mainnet contract's cost function is unknown, Q3). The vote transaction from the node (one input, change and fee outputs, contract witness):

```
txHash               ca5baf509a96d2a31c2bc68ba72235f0ce52a1b820aacb3dc93acd71c5337e03
Witnesses.hash([cw]) 0ea513b00419acfc2e696100747ce7a45e46a8c3c8959158bd12e0f848fca12c
FollowingWitnesses   a8672d5069e8176d464d106a2866dd9925d6863fbc1cd00a4859e8b1200604e5
```

**Fallback if the voting contract is not active** (Q3). Consensus never executes a contract witness that consumes no inputs: validation stops when the inputs are exhausted (`StateMachine.fs:11`). The tally reads witnesses without checking them.

A wallet could therefore attach a hand-built `ContractWitness` with:
- `contractId = votingContractId`;
- `beginInputs = #inputs`, `beginOutputs = #outputs`, and both lengths 0;
- `stateCommitment = 03` and `cost >= 1` (`TransactionValidation.fs:252-255`).

The node's own code never does this, so use it only after confirming with a test node.

### 7.6 Nomination

This is identical to 7.5, with the following differences:
- the ballot is `Payout(recipient, sortedSpends)`;
- the transaction must be included in a nomination-phase block, so the phase string is `"Nomination"`;
- the command and dict key are `"Payout"` or `"Nomination"`. Both are accepted by the tally. Which ones the mainnet contract accepts is Q3.

---

## 8. Node HTTP API needed by a light wallet

General:
- `POST` bodies must have `Content-Type: application/json…`, otherwise the node answers `415` (`Infrastructure/Http.fs:41-52`).
- Errors are `400` with a text body (`Api/Server.fs:1166`).
- CORS headers are sent only if the node runs with `--origin any` or `--origin <url>` (`Http.fs:105-126,147-153`, `Node/Program.fs:237-240`). `--remote` does **not** set an origin (`Program.fs:270-273`).
- Routes: `Api/Server.fs:1173-1309`. A trailing `/` is stripped (`Http.fs:102-104`).

| Endpoint | Request | Response | Source |
|---|---|---|---|
| `GET /blockchain/info` | – | `{"chain","blocks","headers","difficulty","medianTime","initialBlockDownload","tip"}` | `Server.fs:285-304`; `Types.fs:137-146` |
| `POST /addressdb/balance` | `{"addresses":[…], "blockNumber"?: n}` | `[{"asset":"00","balance":<number>}]`. `balance` is a JSON **number** (int64); parse it big-int safely. | `Server.fs:433-451`; `Parsing.fs:421-436` |
| `POST /addressdb/outputs` | `{"addresses":[…],"mode":"all"\|"unspentOnly"}` | `[{"outpoint":{"txHash","index"},"lock":{…},"spend":{"asset","amount":"<string>"}}]` | `Server.fs:532-548`; `Parsing.fs:468-482`; `Helpers.fs:76-83` |
| `POST /addressdb/transactions` | `{"addresses":[…],"skip":n,"take":n}` | `[{"txHash","asset","amount":"<signed string>","confirmations":n,"timestamp"?,"lock"}]` | `Server.fs:579-589`; `Helpers.fs:250-260` |
| `POST /addressdb/transactions/filterByBlockNumber` | `{"addresses":[…],"start":n,"end":n}` | same as above | `Server.fs:605-615` |
| `POST /addressdb/transactioncount` | `{"addresses":[…]}` | number | `Server.fs:453-471` |
| `POST /addressdb/discovery` | `{"addresses":[…],"full"?:bool}` | `[{"address","hasBalance","hasTxs"(,"balance":[spend],"txs":n)}]` | `Server.fs:592-602`; `Helpers.fs:262-283` |
| `POST /blockchain/publishtransaction` | `{"tx":"<hex Full>"}` | `200 "<txHash>"` (a JSON string) if accepted or already in the mempool; `302` text `transaction already exists` if already in a block; `400` with an error text | `Server.fs:37-61,243-251`; `Parsing.fs:387-395` |
| `POST /blockchain/contract/execute` | `{"address":"czen…","command":"…","messageBody":"<hex Data or empty>","options":{"sender":"<hex pubkey or empty>"},"tx":"<hex TxSkeleton>"}` | text/plain hex of the Full transaction | `Server.fs:271-283`; `Parsing.fs:152-187`; `Types.fs:404-414` |
| `GET /blockchain/transaction?hash=<h>&hex=true` | – | `{"tx":"<hex>","confirmations":n}` | `Server.fs:200-231` |
| `GET /blockchain/cgp` | – | `{"interval":n,"allocation":n,"payout":{"recipient":"<address>","spendlist":[…]}\|{}}` | `Server.fs:325-334`; `Helpers.fs:322-334` |
| `GET /blockchain/candidates[?interval=n]` | – | `[{"recipient":"<address>","spendlist":[{"asset","amount"}]}]` | `Server.fs:404-422`; `Helpers.fs:313-320` |
| `GET /blockchain/winner`, `/blockchain/totalzp`, `/blockchain/blockreward?blockNumber=n`, `/blockchain/contract/cgp`, `/blockchain/mempool` | – | see the source | `Server.fs:306-430` |
| `GET /contract/active` | – | `[{"contractId","address","expire","code"}]` | `Server.fs:1119-1131` |
| `GET /address/decode?address=…` | – | `{"pkHash"}` or `{"contractId"}` | `Server.fs:1144-1161` |

Notes:
- The address lists must be non-empty and valid for the node's chain. Duplicates are removed (`Parsing.fs:411-419`).
- `/addressdb/*` needs the AddressDB module (`--addressdb`, `--remote` or `--connectwallet`).
- For `/blockchain/contract/execute`, **always send every field**, with empty strings for "none". The JsonProvider types are generated from the sample, and missing fields are accessed outside the `resultWrap` (`Parsing.fs:152-187`), so their behaviour is unknown (Q8).

**Blocked by `config.isRemote`:**
- `GET /blockchain/headers` without `take` (`Server.fs:109-110`);
- `GET /blockchain/cgp/history` (`:339-340`);
- `POST /addressdb/contract/info` (`:521-522`);
- `GET/POST /addressdb/resync` (`:620-621`).

In `--remote` mode the wallet service is also started with `isRunning = false` (`Program.fs:272`, `Wallet/Main.fs:462-478`), so `/wallet/*` has no account loaded. **A light wallet must never call `/wallet/*`**: those endpoints take the mnemonic or password.

---

## 9. Test vectors

### 9.1 Already verified against F# fixtures (normative)

| What | Value | Source |
|---|---|---|
| Mnemonic | `feel muffin volcano click mercy abuse bachelor ginger limb tomorrow okay input spend athlete boring security document exclude liar dune usage camera ranch thought` | `Consensus.Tests/Helper.fs:10` |
| pubkey `m/44'/258'/0'/0/0` | `02b43a1cb4cb6472e1fcd71b237eb9c1378335cd200dd07536594348d9e450967e` | `WalletTests.fs:98` |
| account tpub | `tpubDCeTZv9MDcNe6Ahv8UQaoAWhK9XKmpzzJjpiVbCZ4jhsJYdN67Qh18nDjuJFtWfGfLL2hRkGid6Ga5h2FoW9QoRjdcEUQRBW4tkpkCbMtKb` | `WalletTests.fs:116` |
| pkHash 0/0 and testnet address | `30759b07…c2b4` and `tzn1qxp6ekp72q8903efylsnej34pa940cd2xae03l49pe7hkg3mrc26qyh2rgr` | `Constants.fs:84-85` |
| pkHash 1/0 and testnet address | `9b95835b…00a3` and `tzn1qnw2cxku67eaacdzupt58nwf6trg087g8snyc9gk62taaw8v8qz3sy7v0d9` | `Constants.fs:101-102` |
| Signed send transaction, txHash and signature | Section 4.10 | `WalletTests.fs:350`, `Constants.fs:95` |
| Contract address | `ctzn1qqqqqqqrqm6z6…kpw` is contractId `0000000060de85a2…46d3` | `Constants.fs:218-219` |
| SHA3 = FIPS-202 | testnet voting id `e89738…c8ab` = `SHA3(00000000 ‖ code)` | `Chain.fs:84` |

### 9.2 Computed independently (BIP39/BIP32 libraries plus a JS re-implementation of this spec). MUST be cross-checked with F#

Mnemonic `abandon ×23 art`, empty passphrase:

| Item | Value |
|---|---|
| seed | `408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840` |
| account xpub (`m/44'/258'/0'`) | `xpub6Bjz9XrqmqUhLYxELu2EKWLg51w7ke5h5RNLs3rc1hK4xyzoYC8fXGbutUrJ8dKRih2r9nqHD5Avt5tQYgB7Bwd9PFL5ocbwJpRZ5dbZas2` |
| `0/0` priv | `77f7ae746bf25b1c562e6262ae4a2bae7fb21bc278369d919df2577923c1c6b1` |
| `0/0` pub | `03486f683630b750a936db6e20241ff88af43a910a58d2a1e0360d07c074757b62` |
| `0/0` pkHash | `0265226b2e6d577fcbd918201553d4bcf65d827f187a2c945aef53df63bb309a` |
| `0/0` address | `zen1qqfjjy6ewd4thlj7erqsp2575hnm9mqnlrpaze9z6aafa7camxzdqxkdj9s` |
| `1/0` pub | `02cfe74a50e931d6223b1ad12c9bc0aaa335ffb920364ec5feeee8d45f7ce687e9` |
| `1/0` address | `zen1q8h3vgmhyhhstjl5fdrp2jlm3d77l8yz5hggk069d3tnkswmf753szh8jyn` |
| `2/0` pub | `0242b0550aae7c9cd32c0874cf11100c38a32a91a3802b5f4d051d17c87a6e39b5` |
| `2/0` address | `zen1q27ngrump3ahlrtrys9y03c84hj9j8pjupsz0f6qrach80j3jjy6s9wpuwv` |
| `0/1` address | `zen1qfk7mzvn6a8s5pu6tw62q6tw5ld0tfxgk6nz74df2cgzjly7yhlwsragt9q` |

**Send transaction.**
- Input: `1111…11:0` (1 ZP).
- Outputs: 0.5 ZP to `2/0`, 49999000 kalapa change to `1/0`, and a 1000-kalapa Fee.
- Signed with `0/0`, sighash TxHash.

```
unsigned (WithoutWitness) 00000000010111111111111111111111111111111111111111111111111111111111111111110003022057a681f3618f6ff1ac648148f8e0f5bc8b23865c0c04f4e803ee2e77ca329135001c0502203de2c46ee4bde0b97e8968c2a97f716fbdf39054ba1167e8ad8ae7683b69f523008c00c34f0100000c0100
txHash                    cee2abe25aaf6bc22126fb60fd3cdf93ccc75cfc71c5e7583821097b38a2b1cb
signed Full               …0c0100 01 0162 01 03486f683630b750a936db6e20241ff88af43a910a58d2a1e0360d07c074757b62 abacbe562c663518a3045ce17edb59fd91b21542e8c1e1febb6fb4f0b22585180ed98ca0e3ca2464c75d12933885ce711ed9b6b096d36ad6b233e6cf648d9508
```

**Vote (Section 7).** In the hex below, the `0c02…` messageBody uses the length-first key order:

```
ballot "0105"; hashBallot(block 2459600) d37e15c7b7607ccca2771e8019f57e7947f142b47e7e69c480108ca56ddd2f02
sig(0/0) 2318e3af13920d37c9a2a31e8878bc66bf012e67100f2f3c67cb629977f190fa4070511e69889d3fc8ebbf014127c26dfdfd20aaf7414392eed65dd83826b910
messageBody 0c02095369676e61747572650c014230333438366636383336333062373530613933366462366532303234316666383861663433613931306135386432613165303336306430376330373437353762363209<sig>0a416c6c6f636174696f6e060430313035
TxSkeleton  010111111111111111111111111111111111111111111111111111111111111111110002200265226b2e6d577fcbd918201553d4bcf65d827f187a2c945aef53df63bb309a0020010202203de2c46ee4bde0b97e8968c2a97f716fbdf39054ba1167e8ad8ae7683b69f52300c1f5e0ff0100000001
vote tx (cost=5): txHash ca5baf50…7e03, Witnesses.hash 0ea513b0…a12c, FollowingWitnesses msg a8672d50…04e5
```

### 9.3 F# program that prints every vector

Put it in `Blockchain.Tests`, which already references Consensus, Wallet and Blockchain. Run it with `--where "name =~ LightWallet"` and compare its output against 9.1 and 9.2. **It was not added to the repo.**

```fsharp
module Blockchain.Tests.LightWalletVectors

open NUnit.Framework
open Consensus
open Consensus.Types
open Consensus.Crypto
open Infrastructure
open Wallet
module S = Consensus.Serialization
module ZData = Zen.Types.Data
module ZF = Consensus.ZFStar

let hex = FsBech32.Base16.encode
let p (name:string) (v:string) = printfn "%-34s %s" name v

[<Test>]
let ``LightWallet vectors`` () =
    let root = ExtendedKey.fromMnemonicPhrase (String.replicate 23 "abandon " + "art") |> Result.get
    let acct = ExtendedKey.derivePath "m/44'/258'/0'" root |> Result.get
    p "account xpub main" (ExtendedKey.neuter acct |> Result.get |> ExtendedKey.toString Chain.Main)
    let key path =
        let k = ExtendedKey.derivePath path root |> Result.get
        ExtendedKey.getPrivateKey k |> Result.get, ExtendedKey.getPublicKey k |> Result.get
    for path in [ "m/44'/258'/0'/0/0"; "m/44'/258'/0'/1/0"; "m/44'/258'/0'/2/0"; "m/44'/258'/0'/0/1" ] do
        let sk, pk = key path
        p (path + " priv") (SecretKey.serialize sk |> hex)
        p (path + " pub") (PublicKey.toString pk)
        p (path + " pkHash") (PublicKey.hash pk |> Hash.toString)
        p (path + " zen") (Address.encode Chain.Main (Address.PK (PublicKey.hash pk)))
    p "voting czen" (Address.encode Chain.Main (Address.Contract Chain.mainParameters.votingContractId))

    let sk0, pk0 = key "m/44'/258'/0'/0/0"
    let _, pk1 = key "m/44'/258'/0'/1/0"
    let _, pk2 = key "m/44'/258'/0'/2/0"
    let prev = Hash.Hash (Array.create 32 0x11uy)
    let zp amount = { asset = Asset.Zen; amount = amount }
    let send : Transaction =
        { version = Version0
          inputs = [ Outpoint { txHash = prev; index = 0ul } ]
          outputs = [ { lock = PK (PublicKey.hash pk2); spend = zp 50_000_000UL }
                      { lock = PK (PublicKey.hash pk1); spend = zp 49_999_000UL }
                      { lock = Fee; spend = zp 1000UL } ]
          witnesses = []; contract = None }
    p "send unsigned" (S.Transaction.serialize S.WithoutWitness send |> hex)
    p "send txHash" (Transaction.hash send |> Hash.toString)
    p "send signed" (Transaction.sign [ sk0, pk0 ] TxHash send |> Transaction.toHex)

    // amounts
    for a in [ 0UL; 10UL; 1001UL; 99_999_999UL; 123_456_789UL; 1_234_500_000_000_000_000UL; (1UL <<< 56) ] do
        p (sprintf "amount %d" a) (S.Transaction.serialize S.WithoutWitness { send with outputs = [ { lock = Fee; spend = zp a } ] } |> hex)

    // vote
    let ballotHex = S.Serialization.Ballot.serialize (Allocation 5uy) |> hex
    let payoutHex = S.Serialization.Ballot.serialize (Payout (ContractRecipient Chain.mainParameters.cgpContractId, [ zp 1UL ])) |> hex
    p "ballot alloc5 / default payout" (ballotHex + " / " + payoutHex)
    let msg = Blockchain.Tally.VoteParser.hashBallot Chain.mainParameters 2459600ul (ZF.fsToFstString ballotHex)
    p "hashBallot" (Hash.toString msg)
    let sig0 = Crypto.sign sk0 msg
    p "ballot sig" (Signature.toString sig0)
    let sigs = Map.ofList [ ZF.fsToFstString (PublicKey.toString pk0), ZData.Signature (ZF.fsToFstSignature sig0) ]
    let bodyMap = Map.ofList [ "Allocation"B, ZData.String (ZF.fsToFstString ballotHex)
                               "Signature"B, ZData.Collection (ZData.Dict (sigs, 1ul)) ]
    p "dict key order" (bodyMap |> Map.toList |> List.map (fst >> System.Text.Encoding.ASCII.GetString) |> String.concat ",")
    let body = ZData.Collection (ZData.Dict (bodyMap, 2ul))
    p "vote body" (S.Data.serialize body |> hex)
    let skel : TxSkeleton.T =
        { pInputs = [ TxSkeleton.PointedOutput ({ txHash = prev; index = 0ul }, { lock = PK (PublicKey.hash pk0); spend = zp 100_000_000UL }) ]
          outputs = [ { lock = PK (PublicKey.hash pk1); spend = zp 99_999_999UL }; { lock = Fee; spend = zp 1UL } ] }
    p "vote skeleton" (S.TxSkeleton.serialize skel |> hex)
    let cw : ContractWitness =
        { contractId = Chain.mainParameters.votingContractId; command = "Allocation"; messageBody = Some body
          stateCommitment = NotCommitted; beginInputs = 1ul; beginOutputs = 2ul; inputsLength = 0ul; outputsLength = 0ul
          signature = None; cost = 5UL }
    let voteTx = { Transaction.fromTxSkeleton skel with witnesses = [ ContractWitness cw ] }
    p "vote unsigned" (Transaction.toHex voteTx)
    p "vote txHash" (Transaction.hash voteTx |> Hash.toString)
    p "witnesses hash" (S.Witnesses.hash voteTx.witnesses |> Hash.toString)
    p "vote signed" (Transaction.sign [ sk0, pk0 ] FollowingWitnesses voteTx |> Transaction.toHex)

    // open-question probes
    p "List quirk" (S.Data.serialize (ZData.Collection (ZData.List (ZF.fsToFstList [ ZData.U32 1ul ]))) |> hex)
    p "Base16 upper" (sprintf "%A" (FsBech32.Base16.decode "AB"))
    p "bad checksum mnemonic" (match ExtendedKey.fromMnemonicPhrase (String.replicate 23 "abandon " + "abandon") with Ok _ -> "accepted" | Error e -> e)
    let a0 = Address.encode Chain.Main (Address.PK (PublicKey.hash pk0))
    p "uppercase address" (sprintf "%A" (Address.decodePK Chain.Main (a0.ToUpper())))
```

Expected results:
- every line matches 9.2;
- `dict key order` prints `Signature,Allocation`;
- `List quirk` prints `0d010400000001` followed by an extra `00`.

Any mismatch means this spec is wrong at that point.

---

## 10. Open questions (not determinable from this repository)

- **Q1. Mnemonic checksum.** Does `NBitcoin.Mnemonic(phrase, Wordlist.English)` (`ExtendedKey.fs:60`) reject a bad BIP39 checksum or non-standard spacing? The library is not in the repo. Seed derivation is unaffected for valid mnemonics. The probe is in 9.3.
- **Q2. FsBech32 case and limits.** Do `Base16.decode` and `Bech32.decode` (FsBech32 0.1.5) accept upper or mixed case, non-zero padding bits, or strings longer than 90 characters? Encoders must emit lowercase only. Lowercase output is evidenced by the tests.
- **Q3. Mainnet voting contract.** Its code (`6ea5457e…`) is not in the repo. The repo only has the testnet contract, which accepts any command, returns the transaction unchanged and costs 5 (`Voting Contractract.fs:3`). Unknown:
  - which commands it accepts (`Allocation`, `Payout`, `Nomination`);
  - its cost;
  - whether it adds inputs or outputs;
  - whether it is still active on mainnet. Check `/contract/active` and `expire`.

  The code can be fetched from `/contract/active` and verified with `SHA3(00000000 ‖ UTF8(code)) = 6ea5457e…`.
- **Q4. Dict key order.** The rule that FSharp.Core orders `byte[]` keys by length first is not visible in repo code. It decides whether `"Signature"` comes before `"Allocation"` in the vote body. The probe is in 9.3, and there is a runtime check through `/blockchain/contract/execute`.
- **Q5. Data List size quirk.** Confirm the `Data.size` over-count for List nodes (`Serialization.fs:967-970`) and how mainnet handled CGP payout witnesses. Only relevant if the wallet ever builds List data, for example a CGP execution.
- **Q6. Electron desktop wallet.** Its key derivation and address-scanning policy are not in this repo. Only the node wallet's policy is documented here (1.2 item 7).
- **Q7. secp256k1 fork.** `zen_secp256k1 0.1.0.26-v6ad5cdb42a1a` is assumed to be stock libsecp256k1: RFC6979 default nonce, low-S signing, and verification that rejects high-S. RFC6979 and low-S are confirmed by the fixture and mainnet signatures. High-S rejection is not tested.
- **Q8. Missing JSON fields.** It is unclear how FSharp.Data JsonProvider behaves when optional fields are missing in `/blockchain/contract/execute` (`options`, `messageBody`). Always send them.
- **Q9. Mempool acceptance in practice.** Mainnet operators may run modified nodes. The code has no minimum fee, but a 1-kalapa ZP fee (the node's own choice for contract calls) is recommended.

---

## Appendix A. Reference JavaScript (validated)

This code was validated against every hex fixture in the repo: 10 testnet blocks, 2 genesis blocks, mainnet block #11249 with 12 transactions and 234 signatures, the 139-output mainnet transaction and the signed wallet transaction. All of them decode and re-encode byte-identically, with matching txHashes.

```js
// VarInt (Serialization.fs:194-222)
function writeVarInt(out, n) { const t = []; let len = 0;
  for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; }
  for (let i = len; i >= 0; i--) out.push(t[i]); }
function readVarInt(r) { let n = 0; for (;;) { const d = r.u8(); n = n * 128 + (d & 0x7f); if (d & 0x80) n++; else return n; } }

// Amount (Serialization.fs:485-555), amount: BigInt
function writeAmount(out, a) {
  let s = a, e = 0, f = 0;
  if (a !== 0n) { while (s % 10n === 0n) { s /= 10n; e++; } for (let t = s; t !== 0n; t /= 10n) f++; }
  const be = (x, n) => { for (let i = n - 1; i >= 0; i--) out.push(Number((BigInt(x) >> BigInt(8 * i)) & 0xffn)); };
  if (f <= 3) be(Number(s) | (e << 10), 2);
  else if (f <= 8) { let S = Number(s), E = e; if (E > 12) { S *= 10 ** (E - 12); E = 12; }
    be(S < 0x4000000 ? (S | ((0x20 | E) << 26)) >>> 0 : ((S - 0x4000000) | ((0x60 | E) << 25)) >>> 0, 4); }
  else if (a < (1n << 56n)) be((0x7en << 56n) | a, 8);
  else { out.push(0xfe); be(a, 8); }
}

// Asset (Serialization.fs:393-414); ZP => [0x00]
function writeAsset(out, version /*<32*/, cHash, subType) {
  const z = (b) => b.every((x) => x === 0);
  if (z(cHash) && z(subType)) { out.push(version); return; }
  let n = -1; for (let i = 31; i >= 0; i--) if (subType[i]) { n = i; break; }
  if (n < 0) out.push(0x80 | version, ...cHash);
  else if (n < 30) out.push(0x40 | version, ...cHash, n + 1, ...subType.slice(0, n + 1));
  else out.push(0xc0 | version, ...cHash, ...subType);
}
// Lock: writeVarInt(id); writeVarInt(payload.length); payload   (PK id 2, Fee 1, Contract 4 = VarInt(ver)||hash)
// Tx:   BE32(0) || VarInt(#in) inputs || VarInt(#out) outputs || 00 (no contract) || [VarInt(#wit) witnesses]
// txHash = sha3_256(bytes up to and including the contract option byte)
// PK witness: 01 62 <sighash 01|03> <pub33> <sig64>; sig = secp256k1.sign(msg32, priv, {lowS:true}).toCompactRawBytes()
```
