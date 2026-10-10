module StateProbe

// Probe: does a contract see the state it saved? command "set" saves U64 7, "setdict" saves a dictionary like the
// header chain's, "get" always fails with a message that says what state the contract sees.

open Zen.Base
open Zen.Cost
open Zen.Types
open Zen.Data

module D = Zen.Dictionary
module CR = Zen.ContractResult
module RT = Zen.ResultT
module C = Zen.Cost
module Tx = Zen.TxSkeleton

// A transaction is checked against a contract only through inputs the contract owns (or mints). A contract that moves
// nothing is not run when the block is validated, so its state never changes. Each saving command therefore mints one
// unit of the contract's own token and locks it back to the contract.
let withMarker contractId txSkeleton =
  Zen.Asset.getDefault contractId >>= (fun asset ->
  Tx.addInput (Mint ({ asset = asset; amount = 1UL })) txSkeleton
  >>= Tx.lockToContract asset 1UL contractId)

let main txSkeleton _ contractId command sender messageBody wallet state =
  match command with
  | "set" ->
    begin
    let! tx = withMarker contractId txSkeleton in
    let! r = CR.ofTxSkel tx in
    let! _ = incRet 128 () in   // same cost as "setdict": every branch must cost the same
    CR.setStateUpdate (U64 7UL) r
    end
  | "setdict" ->
    begin
    let! d0 = D.add "tip" (U64 1UL) D.empty in
    let! d1 = D.add "hdrs" (Collection (List [String "a"])) d0 in
    let! tx = withMarker contractId txSkeleton in
    let! r = CR.ofTxSkel tx in
    CR.setStateUpdate (Collection (Dict d1)) r
    end
  | _ ->
    begin match state with
    | None -> RT.autoFailw "probe: the contract sees no state"
    | Some (U64 _) -> RT.autoFailw "probe: the contract sees a U64 state"
    | Some (Collection (Dict _)) -> RT.autoFailw "probe: the contract sees a dictionary state"
    | Some _ -> RT.autoFailw "probe: the contract sees another kind of state"
    end

let cf _ _ _ _ _ _ _ =
    352
    |> cast nat
    |> C.ret
