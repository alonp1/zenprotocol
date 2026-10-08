/// Leaves and the Merkle tree, built exactly like the contracts and the old service do (docs/ORACLE.md).
module Oracle.Leaf

open System
open System.Text
open Consensus

/// Value as the contract sees it: value x 1000, unsigned 32 bit, big endian.
let encodeValue (value: decimal) : byte[] =
    let scaled = uint32 (Math.Round(value * 1000M, MidpointRounding.ToZero))
    [| byte (scaled >>> 24); byte (scaled >>> 16); byte (scaled >>> 8); byte scaled |]

/// The value as the contract's U64: value x 1000.
let scaled (value: decimal) : uint64 = uint64 (Math.Round(value * 1000M, MidpointRounding.ToZero))

/// Built with the same Zulib functions as hashLeaf in FixedPayout.fst (Sha3 over the identifier string, then the U64 value),
/// so the bytes are identical to what the contract checks the audit path against.
let hashLeaf (ticker: string) (value: decimal) : Hash.Hash =
    let sha3 =
        Zen.Hash.Sha3.empty
        |> Zen.Hash.Sha3.updateString (ZFStar.fsToFstString ticker) |> Zen.Cost.Realized.__force
        |> Zen.Hash.Sha3.updateU64 (scaled value) |> Zen.Cost.Realized.__force
        |> Zen.Hash.Sha3.finalize |> Zen.Cost.Realized.__force
    Hash.Hash sha3

let leaves (data: (string * decimal) list) = data |> List.map (fun (t, v) -> hashLeaf t v)

let root (data: (string * decimal) list) : Hash.Hash = data |> leaves |> MerkleTree.computeRoot

let auditPath (data: (string * decimal) list) (index: int) : Hash.Hash list =
    MerkleTree.createAuditPath (leaves data) index

let verify (rootHash: Hash.Hash) (path: Hash.Hash list) (index: int) (ticker: string) (value: decimal) =
    MerkleTree.verify rootHash path index (hashLeaf ticker value)

/// Message body of the Commit command: a dictionary {"Commit": root}, serialized like node data (type 12, 1 entry, key, type 7 + hash).
let commitMessageBody (rootHash: Hash.Hash) : string =
    let key = Encoding.ASCII.GetBytes "Commit"
    let bytes = Array.concat [ [| 12uy; 1uy; byte key.Length |]; key; [| 7uy |]; Hash.bytes rootHash ]
    Convert.ToHexString(bytes).ToLowerInvariant()

let hex (h: Hash.Hash) = Convert.ToHexString(Hash.bytes h).ToLowerInvariant()

/// The value the Oracle contract commits to and FixedPayout expects: SHA3(root ; uint64 timestamp), built with the
/// same Zulib function the contracts use (hashCommit in FixedPayout.fst), so the bytes are identical.
let commitHash (rootHash: Hash.Hash) (timestamp: uint64) : Hash.Hash =
    let sha3 =
        Zen.Hash.Sha3.empty
        |> Zen.Hash.Sha3.updateHash (Hash.bytes rootHash) |> Zen.Cost.Realized.__force
        |> Zen.Hash.Sha3.updateU64 timestamp |> Zen.Cost.Realized.__force
        |> Zen.Hash.Sha3.finalize |> Zen.Cost.Realized.__force
    Hash.Hash sha3
