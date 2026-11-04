-------------------- MODULE MutNoReservedSlot --------------------
(* MUTANT for ReservedSlotWorks (expect: Invariant ReservedSlotWorks is     *)
(* violated). Code change: src/agent/workers.ts WorkerPool.pump            *)
(*     const limit = (ownerWaiting?.n ?? 0) > 0 ? max + 1 : max;           *)
(* becomes  const limit = max;                                             *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.reservedSlot = FALSE])
=============================================================================
