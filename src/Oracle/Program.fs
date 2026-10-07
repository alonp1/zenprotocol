module Oracle.Program

open System
open System.IO
open System.Net
open System.Text
open System.Text.Json
open System.Threading
open Consensus

type Settings =
    { Tickers: string list
      Provider: string
      IntervalMinutes: int
      Node: string
      Contract: string      // contract address, e.g. ctzn1...
      Password: string
      SignPath: string
      Data: string
      Listen: string }

let private env name fallback =
    match Environment.GetEnvironmentVariable name with
    | null | "" -> fallback
    | v -> v

let settings () =
    { Tickers = (env "ORACLE_TICKERS" "EURUSD,GBPUSD,USDJPY,EURGBP,USDCHF").Split(',', StringSplitOptions.RemoveEmptyEntries) |> Array.map (fun s -> s.Trim()) |> Array.toList
      Provider = env "ORACLE_PROVIDER" "mock"
      IntervalMinutes = int (env "ORACLE_INTERVAL_MINUTES" "60")
      Node = env "ORACLE_NODE" "http://127.0.0.1:31567"
      Contract = env "ORACLE_CONTRACT" ""
      Password = env "ORACLE_PASSWORD" ""
      SignPath = env "ORACLE_SIGN_PATH" "m/44'/258'/0'/3/0"
      Data = env "ORACLE_DATA" "oracle-data"
      Listen = env "ORACLE_LISTEN" "http://127.0.0.1:8085/" }

let round (s: Settings) (provider: Providers.Provider) =
    let now = DateTimeOffset.UtcNow
    let data = s.Tickers |> List.map (fun t -> t, provider.Fetch t now)
    let root = Leaf.root data
    let tx =
        if s.Contract = "" then ""
        else
            let ts = uint64 (now.ToUnixTimeMilliseconds())
            let body = Leaf.commitMessageBody (Leaf.commitHash root ts)
            NodeClient.commit s.Node s.Contract body s.SignPath s.Password
    let r : Store.Round =
        { Timestamp = now.ToUnixTimeMilliseconds(); Root = Leaf.hex root; Tx = tx
          Tickers = data |> List.map fst |> List.toArray; Values = data |> List.map snd |> List.toArray }
    Store.save s.Data r
    printfn "round %d root %s tx %s" r.Timestamp r.Root (if tx = "" then "(not sent)" else tx)

/// Everything a FixedPayout redeemer needs for one ticker.
let proof (r: Store.Round) (ticker: string) =
    match Array.tryFindIndex ((=) ticker) r.Tickers with
    | None -> None
    | Some index ->
        let data = List.zip (List.ofArray r.Tickers) (List.ofArray r.Values)
        let path = Leaf.auditPath data index |> List.map Leaf.hex
        Some {| ticker = ticker; value = r.Values.[index]; valueScaled = uint32 (r.Values.[index] * 1000M)
                timestamp = r.Timestamp; root = r.Root; index = index; auditPath = path; tx = r.Tx |}

let serve (s: Settings) =
    let listener = new HttpListener()
    listener.Prefixes.Add s.Listen
    listener.Start()
    printfn "serving %s" s.Listen
    while true do
        let ctx = listener.GetContext()
        let reply (code: int) (o: obj) =
            let bytes = JsonSerializer.SerializeToUtf8Bytes o
            ctx.Response.StatusCode <- code
            ctx.Response.ContentType <- "application/json"
            ctx.Response.Headers.Add("Access-Control-Allow-Origin", "*")
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length)
            ctx.Response.Close()
        try
            let q = ctx.Request.QueryString
            match ctx.Request.Url.AbsolutePath with
            | "/health" -> reply 200 {| ok = true; provider = s.Provider; tickers = s.Tickers |}
            | "/rounds/latest" ->
                match Store.latest s.Data with
                | Some r -> reply 200 r
                | None -> reply 404 {| error = "no round yet" |}
            | "/auditpath" ->
                let ticker = q.["ticker"]
                let root = match q.["root"] with null | "" -> None | v -> Some v
                let ts = match q.["timestamp"] with null | "" -> None | v -> Some (int64 v)
                match Store.find s.Data root ts with
                | None -> reply 404 {| error = "no such round" |}
                | Some r ->
                    match proof r ticker with
                    | Some p -> reply 200 p
                    | None -> reply 404 {| error = "unknown ticker" |}
            | _ -> reply 404 {| error = "not found" |}
        with ex -> (try reply 500 {| error = ex.Message |} with _ -> ())

[<EntryPoint>]
let main argv =
    match List.ofArray argv with
    | [ "selftest" ] -> if SelfTest.run () then 0 else 1
    | "body" :: specs ->
        printfn "%s" (Body.build specs)
        0
    | [ "once" ] ->
        let s = settings ()
        round s (Providers.create s.Provider)
        0
    | [] | [ "run" ] ->
        let s = settings ()
        let provider = Providers.create s.Provider
        printfn "oracle: provider %s, tickers %s, every %d min, contract %s" s.Provider (String.Join(",", s.Tickers)) s.IntervalMinutes (if s.Contract = "" then "(none, dry run)" else s.Contract)
        let t = Thread((fun () -> serve s), IsBackground = true)
        t.Start()
        while true do
            (try round s provider with ex -> eprintfn "round failed: %s" ex.Message)
            Thread.Sleep(TimeSpan.FromMinutes(float s.IntervalMinutes))
        0
    | _ ->
        eprintfn "usage: zen-oracle [run|once|selftest|body]   (settings from ORACLE_* environment variables, see docs/ORACLE.md)"
        2
