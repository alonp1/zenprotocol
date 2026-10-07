/// Logging for the contract tool: everything goes to stderr, which the node shows on failure.
module Infrastructure.Log

open System
open System.Text.RegularExpressions
open Infrastructure.LogEvent

let mutable minLevel = LogLevel.Info
let private placeholder = Regex(@"\{([A-Za-z0-9_]+)\}")

let private write level (build: LogLevel -> LogEntry) =
    if level >= minLevel then
        let e = build level
        let text =
            placeholder.Replace(e.template, fun m ->
                match List.tryFind (fun (name, _) -> name = m.Groups.[1].Value) e.fields with
                | Some (_, null) -> "null"
                | Some (_, value) -> string value
                | None -> m.Value)
        eprintfn "%s" text

let verbose build = write LogLevel.Verbose build
let debug build = write LogLevel.Debug build
let info build = write LogLevel.Info build
let warning build = write LogLevel.Warn build
let error build = write LogLevel.Error build
