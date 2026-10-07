/// Price sources. A ticker is the symbol of the thing priced (EUR, GBP, BTC: at most 4 characters, FixedPayout refuses longer ones);
/// its value is quoted in the provider's quote currency (USD by default).
module Oracle.Providers

open System
open System.Net.Http
open System.Text.Json

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
            use doc = JsonDocument.Parse body
            doc.RootElement.GetProperty("rates").GetProperty(to').GetDecimal()

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
            use doc = JsonDocument.Parse body
            doc.RootElement.GetProperty(id).GetProperty(cur).GetDecimal()

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
            use doc = JsonDocument.Parse body
            doc.RootElement.GetProperty("data").GetProperty(sym).[0].GetProperty("quote").GetProperty(cur).GetProperty("price").GetDecimal()

let create (name: string) (quote: string) : Provider =
    match name.ToLowerInvariant() with
    | "mock" -> Mock(quote) :> Provider
    | "frankfurter" -> Frankfurter(new HttpClient(Timeout = TimeSpan.FromSeconds 20.0), quote) :> Provider
    | "coingecko" -> CoinGecko(new HttpClient(Timeout = TimeSpan.FromSeconds 20.0), Environment.GetEnvironmentVariable "ORACLE_COINGECKO_KEY" |> Option.ofObj |> Option.defaultValue "", quote) :> Provider
    | "coinmarketcap" -> CoinMarketCap(new HttpClient(Timeout = TimeSpan.FromSeconds 20.0), Environment.GetEnvironmentVariable "ORACLE_CMC_KEY" |> Option.ofObj |> Option.defaultValue "", quote) :> Provider
    | other -> failwithf "unknown provider '%s' (mock, frankfurter, coingecko, coinmarketcap)" other
