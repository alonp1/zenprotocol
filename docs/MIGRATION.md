# Migration to .NET 8

Status: 2026-10-06

## Goal

Run the node on .NET 8 instead of Mono 6.12 (unmaintained, Debian 10 base without security updates), without changing consensus behaviour. Every step must keep the node fully compatible with the existing mainnet.

## Stages

| # | Stage | Risk | Status |
| --- | --- | --- | --- |
| 1 | Convert all 23 projects to SDK-style, still `net47` on Mono | Low | Done – builds with the .NET 8 SDK, all tests pass |
| 2 | Replace or upgrade dependencies that only ship .NET Framework builds | Low–medium | In progress: 4 of 9 done (map below). CI now builds the node from source and syncs it against mainnet |
| 3 | Mainnet replay test: old and new node sync from genesis and must reach the same tip and CGP state | None (test only) | Planned – needs a dedicated runner (>6 h job) |
| 4 | Retarget libraries and node to `net8.0`; F\* keeps running as an external tool on Mono | Medium | Planned |
| 5 | Contract pipeline on .NET 8: F# compiler service, in-memory contract loading | High | Planned |

## Dependency map

Collected from the restored `packages/` folder (paket, `framework: 47`).

### Ready – already ship `netstandard2.0` or newer

Argu 5.1, AsyncIO, NetMQ 4, FsPickler 5.2, FSharp.Data 3, FSharp.Control.Reactive, FSharp.Control.AsyncSeq, System.Reactive 4.1, NBitcoin 4.1, Newtonsoft.Json 12, LightningDB 0.10 (`netstandard1.3`), Hopac 0.3 (`netstandard1.6`), FParsec, FSharp.Compatibility.OCaml, BouncyCastle (to verify), NUnit 3.11, FsUnit, FsCheck.

### Upgrade or replace – only .NET Framework builds in the pinned version

| Package | Pinned | Used in (main / tests) | Action |
| --- | --- | --- | --- |
| FSharp.Core | 4.3.4 | everywhere | Upgrade to 8.x |
| FSharp.Configuration | 1.5.0 | – | Done: replaced by a small YAML loader in `Node/Program.fs` |
| Base58Check | 0.2.0 | 0 / 0 | Done: removed (unused) |
| Logary | 4.2.1 (`net452`) | 33 / 0 files | Done: replaced by `Infrastructure.LogEvent` + `Infrastructure.Log` (same API and output format) |
| NodaTime | 1.3.2 | via Logary | Done: removed with Logary |
| FsNetMQ | 0.2.8 (`net452`) | 19 / 12 files | Upgrade to a `netstandard2.0` release, or vendor the source |
| FSharpx.Extras / Async / Collections | 2.2 / 1.13 / 1.17 | 8 / 0 files | Upgrade to current `netstandard2.0` releases |
| FsBech32 | 0.1.5 (`net47`) | 18 / 7 files | Zen Protocol library with public source – rebuild for `netstandard2.0` |
| SpecFlow / SpecFlow.NUnit | 2.3.2 | 0 / 1 project | Tests only: move to Reqnroll (SpecFlow successor) |

### Zen-specific – the hard part (stage 5)

| Package | Content | Notes |
| --- | --- | --- |
| Zen.FSharp.Compiler.Service 17.0.2 | Patched F# compiler (`net45`) used to compile contracts at runtime | An FSharp.Compiler.Service fork exists in the zenprotocol organisation (to verify it matches 17.0.2); needs a port or a replacement with the current FSharp.Compiler.Service, producing byte-identical contract behaviour |
| ZFStar 0.0.26 | `fstar.exe` + libraries, run as an external process | Can keep running on Mono in stage 4 |
| Zulib 0.3.43 | Contract standard library (`Zulib.dll` + F\* sources) | Source in the zenprotocol organisation; rebuild |
| ZFS-Tools 0.0.24 | Contract tooling | Source in the zenprotocol organisation; rebuild |
| CGPContract 0.0.3 | Compiled CGP contract assembly | Must stay byte-compatible; verify with the replay test |
| zen_z3_*, zen_secp256k1_* | Native Z3 and secp256k1 binaries | Native, framework-independent; keep |

## Consensus safety rules

- No change to serialization, hashing, difficulty, rewards, contract cost or CGP/tally logic as part of the migration.
- A stage is merged only when CI is green and, from stage 4 on, the replay test reaches the same tip hash and CGP state as release 1.0.13.
- Contract execution results (including cost) must be identical for every contract already on chain.
