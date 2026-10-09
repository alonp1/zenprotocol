module BitcoinHeader

// Bitcoin header check (BitZen step T1, see github.com/alonp1/bitzen docs/TESTNET-PLAN.md).
// command "check", message body { header1 : string (160 hex), header2 : string (160 hex) }.
// Passes only if header2 points to header1 (parent hash) and both pass their proof of work.
// It changes no state and moves no assets; it only proves that Zen.Bitcoin works inside a contract on this chain.

open Zen.Base
open Zen.Cost
open Zen.Types
open Zen.Data

module D = Zen.Dictionary
module CR = Zen.ContractResult
module RT = Zen.ResultT
module A = Zen.Array
module B = Zen.Bitcoin
module C = Zen.Cost

// the 32 bytes of two hashes are equal (pure, unrolled: no recursion in a contract)
let hashEq (a:hash) (b:hash) : bool =
    A.item 0 a = A.item 0 b &&
    A.item 1 a = A.item 1 b &&
    A.item 2 a = A.item 2 b &&
    A.item 3 a = A.item 3 b &&
    A.item 4 a = A.item 4 b &&
    A.item 5 a = A.item 5 b &&
    A.item 6 a = A.item 6 b &&
    A.item 7 a = A.item 7 b &&
    A.item 8 a = A.item 8 b &&
    A.item 9 a = A.item 9 b &&
    A.item 10 a = A.item 10 b &&
    A.item 11 a = A.item 11 b &&
    A.item 12 a = A.item 12 b &&
    A.item 13 a = A.item 13 b &&
    A.item 14 a = A.item 14 b &&
    A.item 15 a = A.item 15 b &&
    A.item 16 a = A.item 16 b &&
    A.item 17 a = A.item 17 b &&
    A.item 18 a = A.item 18 b &&
    A.item 19 a = A.item 19 b &&
    A.item 20 a = A.item 20 b &&
    A.item 21 a = A.item 21 b &&
    A.item 22 a = A.item 22 b &&
    A.item 23 a = A.item 23 b &&
    A.item 24 a = A.item 24 b &&
    A.item 25 a = A.item 25 b &&
    A.item 26 a = A.item 26 b &&
    A.item 27 a = A.item 27 b &&
    A.item 28 a = A.item 28 b &&
    A.item 29 a = A.item 29 b &&
    A.item 30 a = A.item 30 b &&
    A.item 31 a = A.item 31 b

let main txSkeleton _ contractId command sender messageBody wallet state =
  let dict = messageBody >!= tryDict in

  let! first =
    dict
    >?= D.tryFind "header1"
    >?= tryString
    >?= B.parseHeader
    in

  let! second =
    dict
    >?= D.tryFind "header2"
    >?= tryString
    >?= B.parseHeader
    in

  match first, second with
  | Some h1, Some h2 ->
    let! hash1 = B.computeHeaderHash h1 in
    let! hash2 = B.computeHeaderHash h2 in
    let! parent2 = B.parent h2 in
    let! nbits1 = B.nbits h1 in
    let! nbits2 = B.nbits h2 in
    let! pow1 = B.checkProofOfWork hash1 nbits1 in
    let! pow2 = B.checkProofOfWork hash2 nbits2 in
    if hashEq hash1 parent2 && pow1 && pow2 then
      CR.ofTxSkel txSkeleton
    else
      RT.autoFailw "the headers are not a valid chain of two Bitcoin blocks"
  | _ ->
    RT.autoFailw "header1 and header2 are required (160 hex characters each)"

let cf _ _ _ _ _ wallet _ =
    (4 + 64 + 2 + 120 + (4 + 64 + 2 + 120 + (500 + 500 + 4 + 4 + 4 + 700 + 700 + 3)))
    |> cast nat
    |> C.ret
