-------------------- MODULE MutAddInputIgnoresStop --------------------
(* MUTANT for StoppedRejectsInputs (expect: Invariant StoppedRejectsInputs  *)
(* is violated). Code change: src/core/tickets.ts Tickets.addInput         *)
(*     if (!t || t.stopped_by_owner) return false;  ->  if (!t) return false;*)
(* A message to a stopped ticket reopens it.                               *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.checkStopped = FALSE])
=============================================================================
