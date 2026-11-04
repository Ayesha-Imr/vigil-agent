-------------------- MODULE MutAnyInputReserves --------------------
(* MUTANT for SlotLimit (expect: Invariant SlotLimit is violated). Code     *)
(* change: src/agent/workers.ts pump computes the limit from any pending   *)
(* input:  const limit = this.s.tickets.hasPendingInputs(t.id) ? max + 1 : max;*)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.ownerKindsOnly = FALSE])
=============================================================================
