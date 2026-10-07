module Infrastructure.Platform.Tests

open NUnit.Framework
open FsUnit
open System
open System.IO

let currentDirectory = (new FileInfo(System.Reflection.Assembly.GetExecutingAssembly().Location)).DirectoryName
// a Mono program that ships with the node (the paket-era test used fsc.exe from the packages folder)
let tool_exe =
    Path.Combine(currentDirectory, "contract-tool", "zen-contract-tool.exe")
let hints =
    Directory.GetFiles(Path.Combine(currentDirectory, "../../../Consensus/compatibility/v0_contract_hints"), "*.hints") |> Array.head

[<Test>]
let ``Should get output from process``() =
    (Infrastructure.Platform.run tool_exe [ "total-queries"; hints ]) |> should equal (Ok (): Result<unit, string>)

[<Test>]
let ``Should get error from process``() =
    (Infrastructure.Platform.run tool_exe []) |> should equal (Error "usage: zen-contract-tool compile|record-hints|total-queries ...": Result<unit, string>)