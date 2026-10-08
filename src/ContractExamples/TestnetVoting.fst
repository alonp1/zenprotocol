    open Zen.Types
open Zen.Base
open Zen.Cost
module RT = Zen.ResultT
module Tx = Zen.TxSkeleton
module C = Zen.Cost
let name = "Testnet Voting Contract"
let main txSkeleton _ contractId command sender messageBody wallet state =
  RT.ok @ {
    tx = txSkeleton;
    message = None;
    state = NoChange;
  }
let cf _ _ _ _ _ _ _ =
    5
    |> cast nat
    |> C.ret