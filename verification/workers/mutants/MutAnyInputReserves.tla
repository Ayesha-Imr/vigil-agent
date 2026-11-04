-------------------- MODULE MutAnyInputReserves --------------------
(* MUTANT for SlotLimit (expect: Invariant SlotLimit is violated).          *)
(* Code change: src/agent/workers.ts WorkerPool.pump computes the limit    *)
(* from any pending input:                                                 *)
(*     const limit = this.s.tickets.hasPendingInputs(t.id) ? max + 1 : max;*)
(* A concierge note or a recovery note then takes the reserved slot.       *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.ownerKindsOnly = FALSE])
=============================================================================
