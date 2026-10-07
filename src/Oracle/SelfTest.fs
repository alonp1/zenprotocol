/// `zen-oracle selftest`: checks that what the service builds is what the contracts and the node accept.
module Oracle.SelfTest

open System
open Consensus

let private check name ok =
    printfn "%s %s" (if ok then "ok  " else "FAIL") name
    ok

let run () : bool =
    let data = [ "EURUSD", 1.0832M; "GBPUSD", 1.2711M; "USDJPY", 149.5M; "EURGBP", 0.852M; "USDCHF", 0.9M ]
    let root = Leaf.root data
    let results =
        [ check "value encoding is value x 1000, big endian" (Leaf.encodeValue 1.0832M = [| 0uy; 0uy; 4uy; 56uy |])
          check "every leaf verifies against the root with its audit path"
              (data |> List.mapi (fun i (t, v) -> Leaf.verify root (Leaf.auditPath data i) i t v) |> List.forall id)
          check "a changed value does not verify"
              (not (Leaf.verify root (Leaf.auditPath data 0) 0 "EURUSD" 1.0833M))
          check "a wrong index does not verify"
              (not (Leaf.verify root (Leaf.auditPath data 0) 1 "EURUSD" 1.0832M))
          check "the Commit message body is a node data dictionary holding the root"
              (let bytes = Convert.FromHexString(Leaf.commitMessageBody root)
               match Serialization.Data.deserialize bytes with
               | Some (Zen.Types.Data.Collection (Zen.Types.Data.Dict (map, _))) ->
                   (match Map.tryFind "Commit" map with
                    | Some (Zen.Types.Data.Hash h) -> h = Hash.bytes root
                    | _ -> false)
               | _ -> false)
          check "the mock provider is deterministic"
              (let m = Providers.Mock() :> Providers.Provider
               let t = DateTimeOffset.FromUnixTimeSeconds 1800000000L
               m.Fetch "EURUSD" t = m.Fetch "EURUSD" t && m.Fetch "EURUSD" t > 0M) ]
    List.forall id results
