/// `zen-oracle body Name:type=value ...` prints the hex message body (a node data dictionary) for a contract call.
/// types: s string, u uint64, h hash, k public key, c contract id as a lock, L comma separated list of hashes.
module Oracle.Body

open System
open Consensus
open Zen.Types.Data

module PKModule = Consensus.Crypto.PublicKey


let private field (spec: string) : FStar.String.t * data =
    let eq = spec.IndexOf '='
    let head, value = spec.Substring(0, eq), spec.Substring(eq + 1)
    let colon = head.LastIndexOf ':'
    let name, kind = head.Substring(0, colon), head.Substring(colon + 1)
    let hashBytes (s: string) =
        match Hash.fromString s with
        | Some h -> Hash.bytes h
        | None -> failwithf "bad hash %s" s
    let d =
        match kind with
        | "s" -> String (ZFStar.fsToFstString value)
        | "u" -> U64 (UInt64.Parse value)
        | "h" -> Hash (hashBytes value)
        | "k" ->
            // a compressed key (33 bytes hex), parsed by Consensus so that its serialization is valid
            match PKModule.fromString value with
            | Some (Consensus.Crypto.PublicKey b) -> PublicKey b
            | None -> failwithf "bad public key %s" value
        | "c" ->
            match ContractId.fromString value with
            | Some id -> Lock (ZFStar.fsToFstLock (Types.Lock.Contract id))
            | None -> failwithf "bad contract id %s" value
        | "L" ->
            let items = value.Split(',', StringSplitOptions.RemoveEmptyEntries) |> Array.map (fun s -> Hash (hashBytes s)) |> List.ofArray
            Collection (List (ZFStar.fsToFstList items))
        | other -> failwithf "unknown type %s" other
    ZFStar.fsToFstString name, d

let build (specs: string list) : string =
    let map = specs |> List.map field |> Map.ofList
    let data = Collection (Dict (map, Map.count map |> uint32))
    Convert.ToHexString(Serialization.Data.serialize data).ToLowerInvariant()
