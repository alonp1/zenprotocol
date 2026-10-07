# Migration to .NET 10

Status: 2026-10-07

## Goal

Run the node on .NET 10 instead of Mono 6.12 (unmaintained, Debian 10 base without security updates), without changing consensus behaviour. Every step must keep the node fully compatible with the existing mainnet.

**Why .NET 10.** The plan first targeted .NET 8, but .NET 8 support ends on 10 November 2026. .NET 10 is the current long-term support release (November 2025, supported until November 2028). The porting work is the same, so the node goes straight to .NET 10. The next LTS (.NET 12, late 2027) should be a routine retarget.

**Why not a rewrite in another language.** Consensus rules, serialization and the contract system (F\* extracted to F#) are tied to .NET. A rewrite would risk a chain split for no gain at the current network size.

## Stages

| # | Stage | Risk | Status |
| --- | --- | --- | --- |
| 1 | Convert all 23 projects to SDK-style, still `net47` on Mono | Low | Done – builds with the .NET SDK, all tests pass |
| 2 | Replace or upgrade dependencies that only ship .NET Framework builds | Low–medium | 4 of 9 done. The rest are compiled into contracts or drag in FSharp.Core – gated on stage 3 |
| 3 | Mainnet replay test: old and new node sync from genesis and must reach the same tip and CGP state | None (test only) | Done 2026-10-06: PASS from genesis to block 1,052,885; reference stored (see Reference file) |
| 4 | Retarget libraries and node to `net10.0`; F\* keeps running as an external tool on Mono | Medium | In progress (branch `net10`) |
| 5 | Contract pipeline on .NET 10 without Mono: F# compiler service, in-memory contract loading | High | Planned |
| 6 | Load test on a private network: real throughput limit of Mono vs .NET 10 nodes | None (test only) | Planned, see Capacity and load test |

## Dependency map

Collected from the restored `packages/` folder (paket, `framework: 47`).

### Ready – already ship `netstandard2.0` or newer

Argu 5.1, AsyncIO, NetMQ 4, FsPickler 5.2, FSharp.Data 3, FSharp.Control.Reactive, FSharp.Control.AsyncSeq, System.Reactive 4.1, NBitcoin 4.1, Newtonsoft.Json 12, LightningDB 0.10 (`netstandard1.3`), Hopac 0.3 (`netstandard1.6`), FParsec, FSharp.Compatibility.OCaml, BouncyCastle (to verify), NUnit 3.11, FsUnit, FsCheck.

### Upgrade or replace – only .NET Framework builds in the pinned version

| Package | Pinned | Used in (main / tests) | Action |
| --- | --- | --- | --- |
| FSharp.Core | 4.3.4 | everywhere | Keep 4.3.4 in stage 4 (it ships `netstandard2.0`; contracts are compiled against it); upgrade later |
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

## Why the remaining stage-2 packages wait for stage 3

Contracts are compiled at runtime against `FSharp.Core`, `FSharpx.Collections`, `FsBech32`, `BouncyCastle.Crypto`, `FSharp.Compatibility.OCaml` and `Zulib` (see `Infrastructure/ZFStar.fs`), and the CGP tally uses `FSharpx.Extras`. Changing any of them can change contract results or vote counting, so they are only touched once the replay test can prove identical behaviour. `FsNetMQ` 0.3.6 supports `netstandard2.0` but requires a newer `FSharp.Core`, so it goes with that upgrade. `net452` assemblies may also load unchanged on .NET 10; stage 4 will tell.

## Running the replay test

1. Create a server with 4+ dedicated cores and 16 GB RAM (Ubuntu 24.04), e.g. Hetzner CCX23. Hourly-billed; delete it after the run. 40 GB disk is enough: the script frees the Docker build cache, logs free space every 5 minutes and stops with a clear error below 1 GB.
2. GitHub → repository Settings → Actions → Runners → New self-hosted runner → copy the token (valid 1 hour).
3. On the server: `TOKEN=<token> bash scripts/setup-replay-runner.sh` (installs Docker and the runner as a service with the label `replay`).
4. Push the commit to test to the `replay` branch. The run takes 10–20 hours. The report is uploaded as the `replay-report` artifact (kept 90 days).

### Reference file

**What it is.** A small record of the real mainnet as the official 1.0.13 node sees it: block hashes every 1000 blocks up to a fixed height, plus the CGP and supply state at that height. It is the yardstick for every later change to the node.

**Why it matters.** Each block header contains the hash of its parent, so a matching hash at block N proves the whole chain up to N is identical. A node built from changed code (new dependencies, .NET 10, refactoring) that reproduces these hashes validated every historical block exactly like the original. Without the reference, each test would need the old node again: a second full sync, 10+ hours on a rented server.

**Current reference**

| | |
| --- | --- |
| Location | branch [`reference-data`](https://github.com/alonp1/zenprotocol/tree/reference-data/replay/reference), folder `replay/reference/mainnet-1052892/` |
| Height | 1,052,892, tip hash `000000000041063146a68a17344bc87f1e37351bb497167ec6251bfc5fa1c686` |
| Source | official zen-node 1.0.13 (npm release), synced from genesis on the replay server |
| Created | 2026-10-06, right after the replay test passed (release and source build identical) |

| File | Content |
| --- | --- |
| `blocks.txt` | `<height> <block hash>`, every 1000 blocks and the tip (1,053 lines). The tip hash pins the whole chain; the samples locate a divergence quickly |
| `cgp.json`, `cgp-history.json` | CGP allocation and payout state at the reference height |
| `totalzp.json` | total ZP issued at the reference height |
| `winner.json` | last CGP vote result |
| `README.txt` | source, height, creation time |
| `SHA256SUMS` | checksums of all files above |

**Where it lives and why there.** In the git repository, not on a server or the community domain, so it survives deleting the replay server, moving the website or changing domains. Every clone and fork of the repository carries it. Never edit it; a new reference goes in a new `mainnet-<height>` folder.

**How to use it.** Sync the node under test (any build, any platform) past the reference height, then:

```
API=127.0.0.1:11567 bash scripts/check-against-reference.sh
```

The script fetches the newest reference from `reference-data`, verifies its checksums and compares all 1,053 block hashes with the node; when the node is exactly at the reference height it also compares the CGP and supply state. `RESULT: node matches the reference` (exit 0) is the gate for merging a node change.

**How it was made, and making a new one.** `scripts/make-reference.sh` reads a synced official node; `.github/workflows/reference.yml` runs it on the replay runner when the `make-reference` branch is pushed and commits the result to `reference-data`. Make a reference only from the official release node, never from a modified build.

## Capacity and load test

**Theory (from the consensus code).** `maxBlockWeight` is 8,000,000,000 and a block comes every ~237 s (`Chain.fs`). A simple transfer (1 input, 2 outputs, ~250 bytes) weighs ~125,000: 100,000 for the PK witness plus 100 per byte (`Weight.fs`). That allows ~64,000 transfers per block, ~270 per second. Contract calls weigh 100 × their execution cost, so far fewer fit.

**Practice: unknown.** Mainnet carries about 500 transactions a day, so the limit has never been reached. A full block would be ~16 MB. The likely bottlenecks are block validation speed (F# on Mono), propagation of large blocks between nodes, mempool handling and LMDB writes. The consensus limit is not the question; the question is how many transactions per second nodes validate and relay without falling behind.

**Plan (stage 6, after stage 4 so both runtimes can be compared)**

1. Private network: 3–5 nodes in Docker on one rented server, on the `local` chain (`--local`, debug build: 60 s blocks, minimal difficulty), one node mining with the built-in CPU miner. No mainnet coins involved.
2. Funding: mine a few hundred blocks, then split the rewards into thousands of small outputs so many transactions can be signed in parallel.
3. Load generator: a script on the wallet library (`wallet/src/tx.js`, already verified byte for byte against mainnet) that signs transfers and posts them to `/blockchain/publishtransaction` at a fixed rate, stepping up: 1, 10, 50, 100, 250 tx/s.
4. Measure at each step: transactions accepted to the mempool per second, transactions per block, block validation time (node log), time for a block to reach the other nodes, CPU, RAM and disk per node, and whether any node falls behind the tip.
5. Repeat with the .NET 10 build and compare. Publish the results in this file and on the stats page.

Pass criterion for the network: the sustained rate at which every node stays at the tip, with block propagation well under the block interval.

## Consensus safety rules

- No change to serialization, hashing, difficulty, rewards, contract cost or CGP/tally logic as part of the migration.
- A stage is merged only when CI is green and, from stage 4 on, the node passes `scripts/check-against-reference.sh` (same block hashes and CGP state as release 1.0.13).
- Contract execution results (including cost) must be identical for every contract already on chain.
