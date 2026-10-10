module BitcoinHeaderChain

// BitZen step T3: a chain of Bitcoin headers kept in the contract state.
// command "add", message body { header : string (160 hex) }.
// First header: any header with valid proof of work (the trusted checkpoint).
// Later headers: must point to the tip kept in the state and pass proof of work.
// State: Dict { "tip" : Hash, "hdrs" : List of the header strings, newest first }.
// Moves no assets. The test measures cost and state size as the list grows.

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
module Tx = Zen.TxSkeleton

val hashEq: hash -> hash -> bool `cost` 255
let hashEq a b =
    ret (
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
    A.item 31 a = A.item 31 b)

// A transaction is checked against a contract only through inputs the contract owns (or mints): a contract that moves
// nothing is not run when the block is validated, and its state never changes. So each accepted header mints one unit
// of the contract's own token and locks it back to the contract.
let withMarker contractId txSkeleton =
  Zen.Asset.getDefault contractId >>= (fun asset ->
  Tx.addInput (Mint ({ asset = asset; amount = 1UL })) txSkeleton
  >>= Tx.lockToContract asset 1UL contractId)

let main txSkeleton _ contractId command sender messageBody wallet state =
  let! hex =
    messageBody
    >!= tryDict
    >?= D.tryFind "header"
    >?= tryString
    in
  let! st = state >!= tryDict in
  let! tipOpt = ret st >?= D.tryFind "tip" >?= tryHash in
  let! hdrsOpt = ret st >?= D.tryFind "hdrs" >?= tryList in
  let! parsed = (match hex with | Some s -> B.parseHeader s | None -> incRet 120 None) in
  match hex, parsed with
  | Some s, Some h ->
    let! hash = B.computeHeaderHash h in
    let! parent = B.parent h in
    let! nbits = B.nbits h in
    let! pow = B.checkProofOfWork hash nbits in
    // no state yet: the first header is the checkpoint. A state without a readable tip is an error, not a new start.
    let! linked =
      (match st, tipOpt with
       | None, _ -> incRet 255 true
       | Some _, Some tip -> hashEq tip parent
       | Some _, None -> incRet 255 false) in
    if (match state, st with | Some _, None -> true | _ -> false) then
      RT.autoFailw "the state is there but is not a dictionary"
    else if (match st, tipOpt with | Some _, None -> true | _ -> false) then
      RT.autoFailw "the state has no readable tip"
    else if pow && linked then
      let old = (match hdrsOpt with | Some l -> l | None -> []) in
      let! d0 = D.add "tip" (Hash hash) D.empty in
      let! d1 = D.add "hdrs" (Collection (List (String s :: old))) d0 in
      let! tx = withMarker contractId txSkeleton in
      let! res = CR.ofTxSkel tx in
      CR.setStateUpdate (Collection (Dict d1)) res
    else
      RT.autoFailw "not a valid next Bitcoin header"
  | _ ->
    RT.autoFailw "header is required (160 hex characters)"

let cf _ _ _ _ _ _ _ =
    2247
    |> cast nat
    |> C.ret
