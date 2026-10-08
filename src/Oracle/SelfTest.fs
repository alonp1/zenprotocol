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
        [ check "value is scaled x 1000 as the contract's U64" (Leaf.scaled 1.0832M = 1083UL)
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
          check "data sources: a path finds a number in an answer (nested, indexed, a number written as a string)"
              (let j = System.Text.Json.JsonDocument.Parse """{"data":{"rates":[{"USD":1.5},{"USD":2.5}]},"price":"82984.01","result":{"XXBTZUSD":{"c":["81000.5","0.1"]}}}"""
               let r = j.RootElement
               Providers.numberAt r "data.rates[1].USD" = 2.5M && Providers.numberAt r "price" = 82984.01M && Providers.numberAt r "result.XXBTZUSD.c[0]" = 81000.5M)
          check "quorum: the median of sources that agree; an outlier is dropped; no agreement gives no value"
              (let ok = Providers.aggregate 2 0.01M [ "a", 100M; "b", 100.4M; "c", 150M ]
               let split = Providers.aggregate 2 0.01M [ "a", 100M; "b", 110M ]
               let few = Providers.aggregate 2 0.01M [ "a", 100M ]
               ok = Ok (100.2M, [ "c" ]) && (match split with Error _ -> true | _ -> false) && (match few with Error _ -> true | _ -> false))
          check "data sources: a negative index counts from the end, a CSV answer is read by column name or index"
              (let j = System.Text.Json.JsonDocument.Parse """{"chart":{"result":[{"close":[1.5,2.5,3.5]}]}}"""
               let csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nSPY.US,2026-10-08,22:00:09,510,515,509,512.34,1000\n"
               Providers.numberAt j.RootElement "chart.result[0].close[-1]" = 3.5M
               && Providers.csvNumber csv "Close" None = 512.34M && Providers.csvNumber csv "6" None = 512.34M
               && (try Providers.csvNumber "Symbol,Close\nX,N/D\n" "Close" None |> ignore; false with _ -> true))
          check "quorum keeps its evidence: what each source said and who was dropped"
              (let fake name v = { new Providers.Provider with
                                     member _.Name = name
                                     member _.Fetch _ _ = v }
               let q = Providers.Quorum([ fake "a" 100M; fake "b" 100.2M; fake "c" 150M ], 2, 0.01M) :> Providers.Provider
               let v = q.Fetch "TEST" DateTimeOffset.UtcNow
               match Providers.evidence.TryGetValue "TEST" with
               | true, (srcs, dropped) -> v = 100.1M && srcs.Length = 3 && dropped = [ "c" ]
               | _ -> false)
          check "daily close: due on a weekday after the close time once a day, never on a weekend"
              (let close = TimeSpan(21, 30, 0)
               let at s = DateTimeOffset.Parse(s + "Z")
               Providers.dailyDue (at "2026-10-08T22:00:00") close None                          // Thursday evening
               && not (Providers.dailyDue (at "2026-10-08T20:00:00") close None)                  // before the close
               && not (Providers.dailyDue (at "2026-10-08T22:00:00") close (Some "2026-10-08"))   // already fetched today
               && Providers.dailyDue (at "2026-10-09T22:00:00") close (Some "2026-10-08")         // next day
               && not (Providers.dailyDue (at "2026-10-10T22:00:00") close None))                 // Saturday
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
