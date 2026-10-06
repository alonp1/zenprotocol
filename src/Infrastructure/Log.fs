/// Node logging: console + a log file in the working directory,
/// same line format as before: "[HH:mm:ss INF] message".
module Infrastructure.Log

open System
open System.IO
open System.Text.RegularExpressions
open Infrastructure.LogEvent

let mutable minLevel =
#if DEBUG
    LogLevel.Debug
#else
    LogLevel.Info
#endif

let private gate = obj ()

let private placeholder = Regex(@"\{([A-Za-z0-9_]+)\}", RegexOptions.Compiled)

let private render (event: LogEntry) =
    placeholder.Replace(event.template, fun m ->
        match List.tryFind (fun (name, _) -> name = m.Groups.[1].Value) event.fields with
        | Some (_, null) -> "null"
        | Some (_, value) -> string value
        | None -> m.Value)

let private tag level =
    match level with
    | LogLevel.Verbose -> "VRB"
    | LogLevel.Debug -> "DBG"
    | LogLevel.Info -> "INF"
    | LogLevel.Warn -> "WRN"
    | _ -> "ERR"

let private file =
    lazy (
        try
            let name = sprintf "%s.log" (DateTime.UtcNow.ToString "yyyy-MM-ddTHH-mm-ss")
            let writer = new StreamWriter(Path.Combine(Environment.CurrentDirectory, name), true)
            writer.AutoFlush <- true
            Some writer
        with _ -> None)

let private write level (build: LogLevel -> LogEntry) =
    if level >= minLevel then
        let line = sprintf "[%s %s] %s" (DateTime.Now.ToString "HH:mm:ss") (tag level) (render (build level))
        lock gate (fun () ->
            Console.Out.WriteLine line
            match file.Force() with
            | Some writer -> writer.WriteLine line
            | None -> ())

let verbose build = write LogLevel.Verbose build
let debug build = write LogLevel.Debug build
let info build = write LogLevel.Info build
let warning build = write LogLevel.Warn build
let error build = write LogLevel.Error build
