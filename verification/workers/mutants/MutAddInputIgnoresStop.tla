-------------------- MODULE MutAddInputIgnoresStop --------------------
(* MUTANT for StoppedRejectsInputs (expect: Invariant StoppedStaysStopped is*)
(* violated). Code change: src/core/tickets.ts addInput                    *)
(*     if (!t || t.stopped_by_owner) return false;  ->  if (!t) return false;*)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.checkStopped = FALSE])
=============================================================================
