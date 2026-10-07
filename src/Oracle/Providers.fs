/// Price sources. Each returns the value of a ticker such as EURUSD (1 EUR in USD).
module Oracle.Providers

open System
open System.Net.Http
open System.Text.Json

type Provider =
    abstract Name: string
    abstract Fetch: ticker: string -> time: DateTimeOffset -> decimal

/// Deterministic prices for tests and the testnet: the same ticker and hour always give the same value.
type Mock() =
    interface Provider with
        member _.Name = "mock"
        member _.Fetch ticker time =
            let seed = ticker |> Seq.fold (fun acc c -> (acc * 31 + int c) % 9973) 7
            let basePrice = 0.5M + decimal (seed % 200) / 100M
            let hour = time.ToUnixTimeSeconds() / 3600L
            let wave = decimal (Math.Sin(float hour / 7.0 + float seed)) * 0.05M
            Math.Round(basePrice * (1M + wave), 3)

/// Free reference rates of the European Central Bank through api.frankfurter.dev (no key). Ticker = two currency codes, e.g. EURUSD.
type Frankfurter(http: HttpClient) =
    interface Provider with
        member _.Name = "frankfurter"
        member _.Fetch ticker _ =
            if ticker.Length <> 6 then failwithf "ticker %s is not two currency codes" ticker
            let from, to' = ticker.Substring(0, 3), ticker.Substring(3, 3)
            let url = sprintf "https://api.frankfurter.dev/v1/latest?base=%s&symbols=%s" from to'
            let body = http.GetStringAsync(url).Result
            use doc = JsonDocument.Parse body
            doc.RootElement.GetProperty("rates").GetProperty(to').GetDecimal()

let create (name: string) : Provider =
    match name.ToLowerInvariant() with
    | "mock" -> Mock() :> Provider
    | "frankfurter" -> Frankfurter(new HttpClient(Timeout = TimeSpan.FromSeconds 20.0)) :> Provider
    | other -> failwithf "unknown provider '%s' (mock, frankfurter)" other
