/// Leaves and the Merkle tree, built exactly like the contracts and the old service do (docs/ORACLE.md).
module Oracle.Leaf

open System
open System.Text
open Consensus

/// Value as the contract sees it: value x 1000, unsigned 32 bit, big endian.
let encodeValue (value: decimal) : byte[] =
    let scaled = uint32 (Math.Round(value * 1000M, MidpointRounding.ToZero))
    [| byte (scaled >>> 24); byte (scaled >>> 16); byte (scaled >>> 8); byte scaled |]

/// Hash(identifier bytes ; ';' ; value bytes)
let hashLeaf (ticker: string) (value: decimal) : Hash.Hash =
    Array.concat [ Encoding.ASCII.GetBytes ticker; [| byte ';' |]; encodeValue value ]
    |> Hash.compute

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
