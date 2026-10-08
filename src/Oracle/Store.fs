/// Rounds are kept as one JSON file each (data/rounds/<timestamp>.json): small, easy to back up, no database server.
module Oracle.Store

open System
open System.IO
open System.Text.Json

type Round =
    { Timestamp: int64            // milliseconds since epoch
      Root: string                // hex
      Tx: string                  // transaction hash of the commitment ("" if it was not sent)
      Tickers: string[]
      Values: decimal[]
      Evidence: string }            // JSON: per ticker what each source answered, who was dropped, the day of a daily close (null in older rounds)

let private options = JsonSerializerOptions(WriteIndented = true)

let private dir (data: string) =
    let d = Path.Combine(data, "rounds")
    Directory.CreateDirectory d |> ignore
    d

let save (data: string) (r: Round) =
    let path = Path.Combine(dir data, sprintf "%013d.json" r.Timestamp)
    File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(r, options))
    File.Move(path + ".tmp", path, true)

let all (data: string) : Round list =
    Directory.GetFiles(dir data, "*.json")
    |> Array.sort
    |> Array.map (fun f -> JsonSerializer.Deserialize<Round>(File.ReadAllText f, options))
    |> Array.toList

let latest data = all data |> List.tryLast

/// The round with the given root, or the newest round at or before the timestamp.
let find data (root: string option) (timestamp: int64 option) =
    let rounds = all data
    match root, timestamp with
    | Some r, _ -> rounds |> List.tryFind (fun x -> x.Root = r)
    | None, Some t -> rounds |> List.filter (fun x -> x.Timestamp <= t) |> List.tryLast
    | None, None -> rounds |> List.tryLast
