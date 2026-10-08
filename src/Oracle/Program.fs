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
      Quote: string
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
    { Tickers = (env "ORACLE_TICKERS" "EUR,GBP,JPY,CHF,BTC").Split(',', StringSplitOptions.RemoveEmptyEntries) |> Array.map (fun s -> s.Trim()) |> Array.toList
      Provider = env "ORACLE_PROVIDER" "mock"
      Quote = env "ORACLE_QUOTE" "USD"
      IntervalMinutes = int (env "ORACLE_INTERVAL_MINUTES" "60")
      Node = env "ORACLE_NODE" "http://127.0.0.1:31567"
      Contract = env "ORACLE_CONTRACT" ""
      Password = env "ORACLE_PASSWORD" ""
      SignPath = env "ORACLE_SIGN_PATH" "m/44'/258'/0'/3/0"
      Data = env "ORACLE_DATA" "oracle-data"
      Listen = env "ORACLE_LISTEN" "http://127.0.0.1:8085/" }

/// Last published close of the daily tickers (stocks, commodities): { "SPY": { "date": "2026-10-08", "value": 512.3 } }
let private dailyFile (s: Settings) = Path.Combine(s.Data, "daily.json")
let private loadDaily (s: Settings) : Map<string, string * decimal> =
    try
        use doc = JsonDocument.Parse(File.ReadAllText(dailyFile s))
        [ for p in doc.RootElement.EnumerateObject() -> p.Name, (p.Value.GetProperty("date").GetString(), p.Value.GetProperty("value").GetDecimal()) ] |> Map.ofList
    with _ -> Map.empty
let private saveDaily (s: Settings) (m: Map<string, string * decimal>) =
    Directory.CreateDirectory s.Data |> ignore
    let o = m |> Map.map (fun _ (d, v) -> {| date = d; value = v |})
    File.WriteAllText(dailyFile s, JsonSerializer.Serialize o)

let round (s: Settings) (provider: Providers.Provider) =
    let now = DateTimeOffset.UtcNow
    let daily, closeUtc = Providers.dailyConfig ()
    let closes = ref (loadDaily s)
    let today = now.UtcDateTime.ToString "yyyy-MM-dd"
    if s.Tickers |> List.exists (fun t -> t.Length > 4) then failwith "tickers are at most 4 characters (FixedPayout refuses longer ones)"
    // a ticker the source cannot give is left out of this round (and said so); no ticker at all fails the round
    let data =
        s.Tickers |> List.choose (fun t ->
            if daily.Contains t then
                // end-of-day tickers: the close is fetched once a day after the close time; every round carries the last close
                let last = closes.Value.TryFind t
                if last.IsNone || Providers.dailyDue now closeUtc (last |> Option.map fst) then
                    try
                        let v = provider.Fetch t now
                        closes.Value <- closes.Value.Add(t, (today, v))
                    with ex -> eprintfn "ticker %s: close not fetched: %s" t ex.Message
                match closes.Value.TryFind t with
                | Some (_, v) -> Some (t, v)
                | None -> eprintfn "ticker %s skipped: no close yet" t; None
            else
                try Some (t, provider.Fetch t now)
                with ex -> eprintfn "ticker %s skipped: %s" t ex.Message; None)
    if data.IsEmpty then failwith "no ticker could be fetched"
    saveDaily s closes.Value
    let evidence =
        data |> List.map (fun (t, v) ->
            let srcs, dropped = match Providers.evidence.TryGetValue t with | true, e -> e | _ -> [], []
            let asOf = if daily.Contains t then (match closes.Value.TryFind t with Some (d, _) -> d | None -> today) else today
            t, {| value = v; asOf = asOf; sources = srcs |> List.map (fun (n, x) -> n, x) |> dict; dropped = dropped |})
        |> dict
    let root = Leaf.root data
    let tx =
        if s.Contract = "" then ""
        else
            let ts = uint64 (now.ToUnixTimeMilliseconds())
            let body = Leaf.commitMessageBody (Leaf.commitHash root ts)
            NodeClient.commit s.Node s.Contract body s.SignPath s.Password
    let r : Store.Round =
        { Timestamp = now.ToUnixTimeMilliseconds(); Root = Leaf.hex root; Tx = tx
          Tickers = data |> List.map fst |> List.toArray; Values = data |> List.map snd |> List.toArray
          Evidence = JsonSerializer.Serialize evidence }
    Store.save s.Data r
    printfn "round %d root %s tx %s" r.Timestamp r.Root (if tx = "" then "(not sent)" else tx)

/// Everything a FixedPayout redeemer needs for one ticker.
let proof (r: Store.Round) (ticker: string) =
    match Array.tryFindIndex ((=) ticker) r.Tickers with
    | None -> None
    | Some index ->
        let data = List.zip (List.ofArray r.Tickers) (List.ofArray r.Values)
        let path = Leaf.auditPath data index |> List.map Leaf.hex
        Some {| ticker = ticker; value = r.Values.[index]; valueScaled = Leaf.scaled r.Values.[index]
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
            | "/rounds" ->
                let n = match q.["take"] with null | "" -> 24 | v -> min 200 (max 1 (int v))
                reply 200 (Store.all s.Data |> List.rev |> List.truncate n)
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
    | [ "commit-hash"; root; timestamp ] ->
        match Hash.fromString root with
        | Some r -> printfn "%s" (Leaf.hex (Leaf.commitHash r (UInt64.Parse timestamp))); 0
        | None -> eprintfn "bad root"; 2
    | "body" :: specs ->
        printfn "%s" (Body.build specs)
        0
    | [ "probe" ] ->
        // asks every configured ticker once and prints what each source says (nothing is signed or sent): run it on the server before enabling a sources file
        let s = settings ()
        let provider = Providers.create s.Provider s.Quote
        let mutable bad = 0
        for t in s.Tickers do
            try
                let v = provider.Fetch t DateTimeOffset.UtcNow
                let srcs, dropped = match Providers.evidence.TryGetValue t with | true, e -> e | _ -> [], []
                printfn "ok   %-5s %M   %s%s" t v (srcs |> List.map (fun (n, x) -> sprintf "%s=%M" n x) |> String.concat " ") (if dropped.IsEmpty then "" else "   dropped: " + String.concat "," dropped)
            with ex -> bad <- bad + 1; printfn "FAIL %-5s %s" t (ex.Message.Split('\n').[0])
        if bad = 0 then 0 else 1
    | [ "once" ] ->
        let s = settings ()
        round s (Providers.create s.Provider s.Quote)
        0
    | [] | [ "run" ] ->
        let s = settings ()
        let provider = Providers.create s.Provider s.Quote
        printfn "oracle: provider %s, tickers %s, every %d min, contract %s" s.Provider (String.Join(",", s.Tickers)) s.IntervalMinutes (if s.Contract = "" then "(none, dry run)" else s.Contract)
        let t = Thread((fun () -> serve s), IsBackground = true)
        t.Start()
        while true do
            (try round s provider with ex -> eprintfn "round failed: %s" ex.Message)
            Thread.Sleep(TimeSpan.FromMinutes(float s.IntervalMinutes))
        0
    | _ ->
        eprintfn "usage: zen-oracle [run|once|probe|selftest|body]   (settings from ORACLE_* environment variables, see docs/ORACLE.md)"
        2
