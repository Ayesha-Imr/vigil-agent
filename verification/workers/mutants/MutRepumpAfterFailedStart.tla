-------------------- MODULE MutRepumpAfterFailedStart --------------------
(* MUTANT for EventLoopProgress (expect: Temporal property                  *)
(* EventLoopProgress was violated). Starts from Workers!Fixed (whose       *)
(* finally does not re-pump after a failed session start) and puts back    *)
(* the current src/agent/workers.ts pump(): .finally(() => { ...;          *)
(* this.pump(); }) for every run, including one whose session failed.     *)
EXTENDS Workers

SpecM == SpecWith([Fixed EXCEPT !.pumpAfterFailedStart = TRUE])
=============================================================================
