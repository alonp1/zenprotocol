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
        [ check "value encoding is value x 1000, big endian" (Leaf.encodeValue 1.0832M = [| 0uy; 0uy; 4uy; 59uy |])
          check "every leaf verifies against the root with its audit path"
              (data |> List.mapi (fun i (t, v) -> Leaf.verify root (Leaf.auditPath data i) i t v) |> List.forall id)
          check "a changed value does not verify"
              (not (Leaf.verify root (Leaf.auditPath data 0) 0 "EURUSD" 1.084M))
          check "a wrong index does not verify"
              (not (Leaf.verify root (Leaf.auditPath data 0) 1 "EURUSD" 1.0832M))
          check "the Commit message body is a node data dictionary holding the root"
              (let bytes = Convert.FromHexString(Leaf.commitMessageBody root)
               match Serialization.Data.deserialize bytes with
               | Some (Zen.Types.Data.Collection (Zen.Types.Data.Dict (map, _))) ->
                   map |> Map.toList |> List.exists (fun (k, v) ->
                       ZFStar.fstToFsString k = "Commit"
                       && (match v with
                           | Zen.Types.Data.Hash h -> h = Hash.bytes root
                           | _ -> false))
               | _ -> false)
          check "body builder: the Commit dictionary equals the hand-built one"
              (Body.build [ "Commit:h=" + Leaf.hex root ] = Leaf.commitMessageBody root)
          check "a body with a public key survives the node's deserializer (it silently drops a body it cannot read)"
              (let pk = "02bee4711911864b76160c865bd29cb8a33c9f4a6d0186dffa02808b0daf122a15"
               let bytes = Convert.FromHexString(Body.build [ "OraclePubKey:k=" + pk; "Ticker:s=EURUSD"; "Price:u=1" ])
               match Serialization.Data.deserialize bytes with
               | Some (Zen.Types.Data.Collection (Zen.Types.Data.Dict (map, _))) -> Map.count map = 3
               | _ -> false)
          check "the commit hash depends on root and timestamp and is stable"
              (let a = Leaf.commitHash root 1234UL
               a = Leaf.commitHash root 1234UL && a <> Leaf.commitHash root 1235UL && a <> root)
          check "the mock provider is deterministic"
              (let m = Providers.Mock("USD") :> Providers.Provider
               let t = DateTimeOffset.FromUnixTimeSeconds 1800000000L
               m.Fetch "EUR" t = m.Fetch "EUR" t && m.Fetch "EUR" t > 0M) ]
    List.forall id results
