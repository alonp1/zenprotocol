/// zen-contract-tool: the contract toolchain of release 1.0.13 (F* extraction, elaboration, F# compilation
/// with Zen.FSharp.Compiler.Service, hints) as a command line program on Mono.
/// Called by the .NET 10 node (Infrastructure/ZFStar.fs). Exit code 0 = success; errors on stderr.
///
///   compile       <contractsPath> <moduleName> <rlimit> <codeFile> <hintsFile>
///   record-hints  <moduleName> <rlimit> <codeFile> <outHintsFile>
///   total-queries <hintsFile>                          prints the number on stdout
///   (debug builds) --unit-testing <dir> before the command: use pre-extracted test contracts
module ContractTool.Program

open System
open System.IO
open Infrastructure

let private finish = function
    | Ok () -> 0
    | Error (e: string) -> eprintfn "%s" e; 1

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
            ZFStar.compile path (File.ReadAllText codeFile) (File.ReadAllText hintsFile) (UInt32.Parse rlimit) moduleName
            |> finish
        | [ "record-hints"; moduleName; rlimit; codeFile; outFile ] ->
            ZFStar.recordHints (UInt32.Parse rlimit) (File.ReadAllText codeFile) moduleName
            |> Result.map (fun (hints: string) -> File.WriteAllText(outFile, hints))
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
        1
