-------------------- MODULE MutNoReaddCap --------------------
(* MUTANT for RetriesBounded (expect: Invariant RetriesBounded is violated). *)
(* Breaks 4e2683a: src/agent/workers.ts run()                              *)
(*     if (!persisted && fails <= 2) ...   ->   if (!persisted) ...        *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.readdCap = FALSE])
=============================================================================
