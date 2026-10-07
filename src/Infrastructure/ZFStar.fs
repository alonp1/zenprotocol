/// Contract toolchain access for the .NET 10 node.
/// F* extraction, elaboration, compilation and hints run in zen-contract-tool.exe on Mono
/// (src/ContractTool, the unchanged code of release 1.0.13). Compiled contracts are loaded in-process.
module Infrastructure.ZFStar

open System
open System.Diagnostics
open System.IO
open System.Reflection
open System.Text
open Infrastructure.LogEvent

let changeExtention extention path = Path.ChangeExtension (path, extention)

let private (/) a b = Path.Combine (a,b)

let compatibilityPath =
    (Platform.workingDirectory, "compatibility", "v0_contract_hints")
    |> Path.Combine

let z3Name =
    match Platform.platform with
    | PlatformID.MacOSX -> "z3-osx"
    | PlatformID.Unix -> "z3-linux"
    | _ -> "z3.exe"

#if DEBUG
let mutable unitTesting = false
#endif

let toolDirectory = Platform.workingDirectory / "contract-tool"
let private toolExe = toolDirectory / "zen-contract-tool.exe"

/// Run the contract tool; Ok stdout or Error stderr.
let private tool (args: string list) : Result<string, string> =
    let args =
#if DEBUG
        if unitTesting then "--unit-testing" :: (Platform.workingDirectory / "../../test-contracts") :: args else args
#else
        args
#endif
    let quote (a: string) = "\"" + a.Replace("\"", "\\\"") + "\""
    let exe, argLine =
        if Platform.isUnix then Platform.monoPath, String.concat " " (List.map quote (toolExe :: args))
        else toolExe, String.concat " " (List.map quote args)
    try
        let psi = ProcessStartInfo(exe, argLine,
                                   WorkingDirectory = toolDirectory,
                                   RedirectStandardOutput = true,
                                   RedirectStandardError = true,
                                   UseShellExecute = false)
        use p = new Process(StartInfo = psi)
        let out, err = StringBuilder(), StringBuilder()
        p.OutputDataReceived.Add(fun e -> if not (isNull e.Data) then out.AppendLine e.Data |> ignore)
        p.ErrorDataReceived.Add(fun e -> if not (isNull e.Data) then err.AppendLine e.Data |> ignore)
        if not (p.Start()) then Error "contract tool: failed to start" else
        p.BeginOutputReadLine()
        p.BeginErrorReadLine()
        p.WaitForExit()
        if p.ExitCode = 0 then
            Ok (out.ToString())
        else
            let e = err.ToString().Trim()
            eventX "contract tool {args} failed: {error}"
            >> setField "args" (String.concat " " (List.truncate 2 args))
            >> setField "error" e
            |> Log.info
            Error e
    with ex ->
        Exception.toError "contract tool" ex

let private withTempFiles (contents: string list) (f: string list -> Result<'a, string>) =
    let files = contents |> List.map (fun (c: string) -> let f = Path.GetTempFileName() in File.WriteAllText(f, c); f)
    try f files
    finally for f in files do try File.Delete f with _ -> ()

let compile (path: string) (code: string) (hints: string) rlimit (moduleName: string) : Result<unit, string> =
    let path = Path.GetFullPath path
    withTempFiles [ code; hints ] (fun files ->
        tool ([ "compile"; path; moduleName; string (rlimit: uint32) ] @ files)
        |> Result.map ignore)

let recordHints rlimit (code: string) (moduleName: string) : Result<string, string> =
    withTempFiles [ code; "" ] (function
        | [ codeFile; outFile ] ->
            tool [ "record-hints"; moduleName; string (rlimit: uint32); codeFile; outFile ]
            |> Result.map (fun _ -> File.ReadAllText outFile)
        | _ -> Error "record hints")

let totalQueries (hints: string) : Result<uint32, string> =
    withTempFiles [ hints ] (fun files ->
        tool ("total-queries" :: files)
        |> Result.bind (fun out ->
            match UInt32.TryParse((out: string).Trim()) with
            | true, n -> Ok n
            | _ -> Error "total queries: invalid output"))

let load path moduleName =
    let assemblyPath = Path.Combine(path, sprintf "%s.dll" moduleName)

    if File.Exists assemblyPath then
        try
            assemblyPath
            |> Assembly.LoadFrom
            |> Ok
        with _ as ex ->
            Error ex.Message
    else
        Error "compiled contract DLL file not found"
