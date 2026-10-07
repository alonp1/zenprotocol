/// zen-contract-tool: the contract toolchain of release 1.0.13 (F* extraction, elaboration, F# compilation
/// with Zen.FSharp.Compiler.Service, hints) as a command line program on Mono.
/// Called by the .NET 10 node (Infrastructure/ZFStar.fs). Exit code 0 = success; errors on stderr.
///
///   compile       <contractsPath> <moduleName> <rlimit> <codeFile> <hintsFile>
///   record-hints  <moduleName> <rlimit> <codeFile> <outHintsFile>
///   total-queries <hintsFile>                          prints the number on stdout
///   metrics       <hintsFile>                          prints max fuel and max ifuel
///   (debug builds) --unit-testing <dir> before the command: use pre-extracted test contracts
module ContractTool.Program

open System
open System.IO
open Infrastructure

// result protocol with the node: on failure the error text goes to stdout (logs go to stderr)
let private finish = function
    | Ok () -> 0
    | Error (e: string) -> printf "%s" e; 1

[<EntryPoint>]
let main argv =
    let argv =
        match List.ofArray argv with
#if DEBUG
        | "--unit-testing" :: dir :: rest ->
            ZFStar.unitTesting <- true
            ZFStar.unitTestingDir <- dir
            rest
#endif
        | args -> args
    try
        match argv with
        | [ "compile"; path; moduleName; rlimit; codeFile; hintsFile ] ->
            // compile into a private folder, then move the DLL into place: the node never sees a half-written DLL
            let target = Path.Combine(path, moduleName + ".dll")
            if File.Exists target then 0 else
            let temp = Path.Combine(path, ".tmp-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory temp |> ignore
            try
                ZFStar.compile temp (File.ReadAllText codeFile) (File.ReadAllText hintsFile) (UInt32.Parse rlimit) moduleName
                |> Result.map (fun () ->
                    try File.Move(Path.Combine(temp, moduleName + ".dll"), target)
                    with _ when File.Exists target -> ())        // compiled at the same time by another call
                |> finish
            finally
                try Directory.Delete(temp, true) with _ -> ()
        | [ "record-hints"; moduleName; rlimit; codeFile; outFile ] ->
            ZFStar.recordHints (UInt32.Parse rlimit) (File.ReadAllText codeFile) moduleName
            |> Result.map (fun (hints: string) -> File.WriteAllText(outFile, hints))
            |> finish
        | [ "metrics"; hintsFile ] ->
            ZFStar.calculateMetrics (File.ReadAllText hintsFile)
            |> Result.map (fun (fuel: int, ifuel: int) -> printfn "%d %d" fuel ifuel)
            |> finish
        | [ "total-queries"; hintsFile ] ->
            ZFStar.totalQueries (File.ReadAllText hintsFile)
            |> Result.map (fun (n: uint32) -> printfn "%d" n)
            |> finish
        | _ ->
            eprintfn "usage: zen-contract-tool compile|record-hints|total-queries ..."
            2
    with ex ->
        eprintfn "%s" (ex.ToString())
        printf "%s" ex.Message
        1
