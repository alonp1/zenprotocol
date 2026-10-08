/// Price sources. A ticker is the symbol of the thing priced (EUR, GBP, BTC: at most 4 characters, FixedPayout refuses longer ones);
/// its value is quoted in the provider's quote currency (USD by default).
module Oracle.Providers

open System
open System.Collections.Generic
open System.Globalization
open System.IO
open System.Net.Http
open System.Text.Json

/// Follows a path like "data.rates[0].USD" or "result.XXBTZUSD.c[0]" into a JSON answer.
let walk (root: JsonElement) (path: string) : JsonElement =
    path.Split('.', StringSplitOptions.RemoveEmptyEntries)
    |> Array.fold (fun (el: JsonElement) seg ->
        let i = seg.IndexOf '['
        let name = if i < 0 then seg else seg.Substring(0, i)
        let idxs = if i < 0 then [||] else seg.Substring(i).Split([| '['; ']' |], StringSplitOptions.RemoveEmptyEntries) |> Array.map int
        let el1 = if name = "" then el else el.GetProperty name
        idxs |> Array.fold (fun (e: JsonElement) n -> e.[if n < 0 then e.GetArrayLength() + n else n]) el1) root

/// The number at a path: a JSON number, or a number written as a string ("82984.01").
let numberAt (root: JsonElement) (path: string) : decimal =
    let el = walk root path
    match el.ValueKind with
    | JsonValueKind.Number -> el.GetDecimal()
    | JsonValueKind.String -> Decimal.Parse(el.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture)
    | k -> failwithf "the value at %s is %A, not a number" path k

/// Reads a number out of an answer; a failure says which ticker and what the source answered (rate limits and errors come back as JSON without the field).
let private pick (ticker: string) (body: string) (f: JsonElement -> decimal) : decimal =
    try
        use doc = JsonDocument.Parse body
        f doc.RootElement
    with ex -> failwithf "%s: %s (the source answered: %s)" ticker ex.Message (body.Substring(0, min 150 body.Length).Replace("\n", " "))

/// What each source answered for a ticker in the last fetch (kept with the round as evidence: who agreed, who was dropped).
let evidence = System.Collections.Concurrent.ConcurrentDictionary<string, (string * decimal) list * string list>()

/// The number in a CSV answer: the column (a name from the header line or a 0-based index) of a data row (default the last one).
let csvNumber (body: string) (column: string) (row: int option) : decimal =
    let lines = body.Split([| '\n'; '\r' |], StringSplitOptions.RemoveEmptyEntries)
    if lines.Length < 2 then failwith "the CSV has no data row"
    let header = lines.[0].Split(',') |> Array.map (fun h -> h.Trim().ToLowerInvariant())
    let col = match Int32.TryParse column with
              | true, i -> i
              | _ -> (match Array.tryFindIndex ((=) (column.ToLowerInvariant())) header with Some i -> i | None -> failwithf "no column %s in %s" column lines.[0])
    let line = match row with Some r -> lines.[r] | None -> lines.[lines.Length - 1]
    let cells = line.Split(',')
    Decimal.Parse(cells.[col].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture)

/// {env:NAME} in a URL is replaced by the environment variable (keys stay out of the sources file; an unset one gives an empty string).
let expandEnv (url: string) : string =
    System.Text.RegularExpressions.Regex.Replace(url, @"\{env:([A-Za-z0-9_]+)\}", fun m ->
        match Environment.GetEnvironmentVariable m.Groups.[1].Value with | null -> "" | v -> v)

type Provider =
    abstract Name: string
    abstract Fetch: ticker: string -> time: DateTimeOffset -> decimal

/// Deterministic prices for tests and the testnet: the same ticker and hour always give the same value.
type Mock(quote: string) =
    interface Provider with
        member _.Name = "mock"
        member _.Fetch ticker time =
            let seed = ticker + quote |> Seq.fold (fun acc c -> (acc * 31 + int c) % 9973) 7
            let basePrice = 0.5M + decimal (seed % 200) / 100M
            let hour = time.ToUnixTimeSeconds() / 3600L
            let wave = decimal (Math.Sin(float hour / 7.0 + float seed)) * 0.05M
            Math.Round(basePrice * (1M + wave), 3)

/// Free reference rates of the European Central Bank through api.frankfurter.dev (no key). Ticker = a currency code, e.g. EUR (value of 1 EUR in the quote currency).
type Frankfurter(http: HttpClient, quote: string) =
    interface Provider with
        member _.Name = "frankfurter"
        member _.Fetch ticker _ =
            if ticker.Length <> 3 then failwithf "ticker %s is not a three letter currency code" ticker
            let from, to' = ticker, quote
            let url = sprintf "https://api.frankfurter.dev/v1/latest?base=%s&symbols=%s" from to'
            let body = http.GetStringAsync(url).Result
            pick ticker body (fun r -> r.GetProperty("rates").GetProperty(to').GetDecimal())

let private ids = dict [ "BTC","bitcoin"; "ETH","ethereum"; "LTC","litecoin"; "XRP","ripple"; "SOL","solana"; "DOGE","dogecoin"; "ADA","cardano"; "XMR","monero"; "BNB","binancecoin" ]

/// CoinGecko, free public API (no key; about 30 requests a minute). A demo key in ORACLE_COINGECKO_KEY raises the limit. Ticker = crypto symbol, e.g. BTC.
type CoinGecko(http: HttpClient, key: string, quote: string) =
    interface Provider with
        member _.Name = "coingecko"
        member _.Fetch ticker _ =
            let sym, cur = ticker, quote.ToLowerInvariant()
            let id = match ids.TryGetValue sym with | true, v -> v | _ -> sym.ToLowerInvariant()
            let req = new HttpRequestMessage(HttpMethod.Get, sprintf "https://api.coingecko.com/api/v3/simple/price?ids=%s&vs_currencies=%s" id cur)
            if key <> "" then req.Headers.Add("x-cg-demo-api-key", key)
            let body = http.Send(req).Content.ReadAsStringAsync().Result
            pick ticker body (fun r -> r.GetProperty(id).GetProperty(cur).GetDecimal())

/// CoinMarketCap: needs an API key (free plan available) in ORACLE_CMC_KEY.
type CoinMarketCap(http: HttpClient, key: string, quote: string) =
    interface Provider with
        member _.Name = "coinmarketcap"
        member _.Fetch ticker _ =
            if key = "" then failwith "ORACLE_CMC_KEY is not set"
            let sym, cur = ticker, quote
            let req = new HttpRequestMessage(HttpMethod.Get, sprintf "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=%s&convert=%s" sym cur)
            req.Headers.Add("X-CMC_PRO_API_KEY", key)
            let body = http.Send(req).Content.ReadAsStringAsync().Result
            pick ticker body (fun r -> r.GetProperty("data").GetProperty(sym).[0].GetProperty("quote").GetProperty(cur).GetProperty("price").GetDecimal())

/// Any HTTP API that answers JSON, described in the sources file (docs/ORACLE.md, "Data sources"): url with {ticker} {TICKER}
/// {ticker_lower} {quote} {quote_lower}, the path of the number in the answer, optional headers ("env:NAME" takes the value from the
/// environment, so keys stay out of files), a factor to multiply by and whether to take 1/x.
type Generic(http: HttpClient, name: string, url: string, path: string, headers: (string * string) list, multiply: decimal, invert: bool, quote: string, format: string, symbols: Map<string, string>) =
    interface Provider with
        member _.Name = name
        member _.Fetch ticker _ =
            let symbol = match symbols.TryFind ticker with Some v -> v | None -> ticker
            let u = url.Replace("{symbol}", symbol).Replace("{symbol_lower}", symbol.ToLowerInvariant()).Replace("{ticker}", ticker).Replace("{TICKER}", ticker.ToUpperInvariant()).Replace("{ticker_lower}", ticker.ToLowerInvariant())
                       .Replace("{quote}", quote).Replace("{quote_lower}", quote.ToLowerInvariant()) |> expandEnv
            let req = new HttpRequestMessage(HttpMethod.Get, u)
            for (k, v) in headers do
                let value = if v.StartsWith "env:" then (Environment.GetEnvironmentVariable(v.Substring 4) |> Option.ofObj |> Option.defaultValue "") else v
                if k.ToLowerInvariant() = "user-agent" then req.Headers.UserAgent.Clear()
                req.Headers.TryAddWithoutValidation(k, value) |> ignore
            let resp = http.Send(req)
            let body = resp.Content.ReadAsStringAsync().Result
            if not resp.IsSuccessStatusCode && format <> "csv" && not (body.TrimStart().StartsWith "{") then
                failwithf "%s: HTTP %d from %s" ticker (int resp.StatusCode) name
            let v =
                (if format = "csv" then
                    (try csvNumber body path None
                     with ex -> failwithf "%s: %s (the source answered: %s)" ticker ex.Message (body.Substring(0, min 150 body.Length).Replace("\n", " ")))
                 else pick ticker body (fun r -> numberAt r path)) * multiply
            if invert then 1M / v else v

/// Each ticker can come from a different source.
type Routed(routes: Map<string, Provider>, fallback: Provider) =
    interface Provider with
        member _.Name = "routed"
        member _.Fetch ticker time = (match routes.TryFind ticker with | Some p -> p | None -> fallback).Fetch ticker time

/// Currencies from Frankfurter (ECB rates), crypto symbols (BTC, ETH, ...) from CoinGecko: one provider for a mixed ticker list.
type Auto(fiat: Provider, crypto: Provider) =
    interface Provider with
        member _.Name = "auto"
        member _.Fetch ticker time = (if ids.ContainsKey ticker then crypto else fiat).Fetch ticker time

/// Some sources (CoinGecko) refuse requests without a descriptive User-Agent.
let private client () =
    let c = new HttpClient(Timeout = TimeSpan.FromSeconds 20.0)
    c.DefaultRequestHeaders.UserAgent.ParseAdd "zen-oracle/0.1 (community oracle for the ZP testnet; https://github.com/alonp1/zenprotocol)"
    c

let createBuiltin (name: string) (quote: string) : Provider =
    match name.ToLowerInvariant() with
    | "mock" -> Mock(quote) :> Provider
    | "frankfurter" -> Frankfurter(client (), quote) :> Provider
    | "auto" ->
        let http = client ()
        let key = Environment.GetEnvironmentVariable "ORACLE_COINGECKO_KEY" |> Option.ofObj |> Option.defaultValue ""
        Auto(Frankfurter(http, quote), CoinGecko(http, key, quote)) :> Provider
    | "coingecko" -> CoinGecko(client (), Environment.GetEnvironmentVariable "ORACLE_COINGECKO_KEY" |> Option.ofObj |> Option.defaultValue "", quote) :> Provider
    | "coinmarketcap" -> CoinMarketCap(client (), Environment.GetEnvironmentVariable "ORACLE_CMC_KEY" |> Option.ofObj |> Option.defaultValue "", quote) :> Provider
    | other -> failwithf "unknown provider '%s' (mock, frankfurter, coingecko, coinmarketcap, auto)" other

/// The provider for ORACLE_PROVIDER, and, when ORACLE_SOURCES_FILE is set, a routing of single tickers to other sources:
/// { "sources": { "binance": { "url": "...{TICKER}USDT", "path": "price" } }, "tickers": { "BTC": "binance", "EUR": "frankfurter" } }
/// Several sources must agree. The values are compared with their median: a source further than `tolerance` (0.01 = 1 %) away is
/// dropped, and at least `minimum` sources must remain, otherwise there is no value (the ticker is skipped in this round).
/// Returns the median of the sources that agree and the names of those that were dropped.
let aggregate (minimum: int) (tolerance: decimal) (answers: (string * decimal) list) : Result<decimal * string list, string> =
    let median (xs: decimal list) =
        let a = xs |> List.sort |> Array.ofList
        if a.Length % 2 = 1 then a.[a.Length / 2] else (a.[a.Length / 2 - 1] + a.[a.Length / 2]) / 2M
    if answers.Length < minimum then Error (sprintf "only %d of the required %d sources answered" answers.Length minimum)
    else
        let m = answers |> List.map snd |> median
        let agree, off = answers |> List.partition (fun (_, v) -> m = 0M && v = 0M || m <> 0M && abs (v - m) / abs m <= tolerance)
        if agree.Length < minimum then
            Error (sprintf "no agreement: %s" (answers |> List.map (fun (n, v) -> sprintf "%s=%M" n v) |> String.concat ", "))
        else Ok (agree |> List.map snd |> median, off |> List.map fst)

/// A ticker priced by several sources at once (see `aggregate`). A source that fails counts as not answering.
type Quorum(sources: Provider list, minimum: int, tolerance: decimal) =
    interface Provider with
        member _.Name = "quorum(" + (sources |> List.map (fun s -> s.Name) |> String.concat ",") + ")"
        member _.Fetch ticker time =
            let answers =
                sources
                |> List.choose (fun s ->
                    try Some (s.Name, s.Fetch ticker time)
                    with ex -> eprintfn "%s: source %s failed: %s" ticker s.Name (ex.Message.Split('\n').[0]); None)
            match aggregate minimum tolerance answers with
            | Ok (v, off) ->
                evidence.[ticker] <- (answers, off)
                if not off.IsEmpty then eprintfn "%s: dropped %s (more than %M away from the others)" ticker (String.concat ", " off) tolerance
                v
            | Error e -> evidence.[ticker] <- (answers, []); failwithf "%s: %s" ticker e

let create (name: string) (quote: string) : Provider =
    let fallback = createBuiltin name quote
    match Environment.GetEnvironmentVariable "ORACLE_SOURCES_FILE" with
    | null | "" -> fallback
    | file ->
        use doc = JsonDocument.Parse(File.ReadAllText file)
        let root = doc.RootElement
        let http = client ()
        let custom = Dictionary<string, Provider>()
        match root.TryGetProperty("sources") with
        | true, sources ->
            for p in sources.EnumerateObject() do
                let v = p.Value
                let str (n: string) (d: string) = match v.TryGetProperty n with | true, x -> x.GetString() | _ -> d
                let headers = match v.TryGetProperty("headers") with
                              | true, h -> [ for kv in h.EnumerateObject() -> kv.Name, kv.Value.GetString() ]
                              | _ -> []
                let multiply = match v.TryGetProperty("multiply") with | true, x -> x.GetDecimal() | _ -> 1M
                let invert = match v.TryGetProperty("invert") with | true, x -> x.GetBoolean() | _ -> false
                let symbols = match v.TryGetProperty("symbols") with
                              | true, m -> [ for kv in m.EnumerateObject() -> kv.Name, kv.Value.GetString() ] |> Map.ofList
                              | _ -> Map.empty
                custom.[p.Name] <- Generic(http, p.Name, str "url" "", str "path" "", headers, multiply, invert, str "quote" quote, str "format" "json", symbols) :> Provider
        | _ -> ()
        let resolve n = match custom.TryGetValue n with | true, p -> p | _ -> createBuiltin n quote
        let routes =
            match root.TryGetProperty("tickers") with
            | true, t ->
                let minimum = match root.TryGetProperty("quorum") with | true, q -> (match q.TryGetProperty("min") with | true, x -> x.GetInt32() | _ -> 2) | _ -> 2
                let tol = match root.TryGetProperty("quorum") with | true, q -> (match q.TryGetProperty("tolerance") with | true, x -> x.GetDecimal() | _ -> 0.01M) | _ -> 0.01M
                // a ticker whose sources legitimately differ more (spot against futures) can have its own tolerance: "tolerances": { "XAU": 0.02 }
                let tolOf name = match root.TryGetProperty("tolerances") with
                                 | true, m -> (match m.TryGetProperty(name: string) with | true, x -> x.GetDecimal() | _ -> tol)
                                 | _ -> tol
                [ for kv in t.EnumerateObject() ->
                    kv.Name,
                    (if kv.Value.ValueKind = JsonValueKind.Array
                     then Quorum([ for n in kv.Value.EnumerateArray() -> resolve (n.GetString()) ], minimum, tolOf kv.Name) :> Provider
                     else resolve (kv.Value.GetString())) ]
                |> Map.ofList
            | _ -> Map.empty
        Routed(routes, fallback) :> Provider


/// Tickers that move once a day (stocks, indices, commodities: end-of-day prices) and the UTC time after which the day's close is
/// published: { "daily": ["SPY","AAPL","XAU"], "closeUtc": "21:30" } in the sources file. Weekends are skipped.
let dailyConfig () : Set<string> * TimeSpan =
    match Environment.GetEnvironmentVariable "ORACLE_SOURCES_FILE" with
    | null | "" -> Set.empty, TimeSpan(21, 30, 0)
    | file ->
        use doc = JsonDocument.Parse(File.ReadAllText file)
        let root = doc.RootElement
        let tickers = match root.TryGetProperty("daily") with
                      | true, d -> [ for x in d.EnumerateArray() -> x.GetString() ] |> Set.ofList
                      | _ -> Set.empty
        let at = match root.TryGetProperty("closeUtc") with
                 | true, c -> TimeSpan.Parse (c.GetString() + ":00")
                 | _ -> TimeSpan(21, 30, 0)
        tickers, at

/// Whether the close of `now`'s day should be fetched now: a weekday, after the close time, and not fetched yet today.
let dailyDue (now: DateTimeOffset) (closeUtc: TimeSpan) (lastDate: string option) : bool =
    let d = now.UtcDateTime
    d.DayOfWeek <> DayOfWeek.Saturday && d.DayOfWeek <> DayOfWeek.Sunday
    && d.TimeOfDay >= closeUtc
    && lastDate <> Some (d.ToString "yyyy-MM-dd")
