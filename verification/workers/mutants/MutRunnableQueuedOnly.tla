-------------------- MODULE MutRunnableQueuedOnly --------------------
(* MUTANT for NoInputStuck (expect: Temporal property NoInputStuck was      *)
(* violated). Code change: src/core/tickets.ts runnable keeps only stage   *)
(* queued:  .filter((t) => t.stage === "queued")                           *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.runnableInputs = FALSE])
=============================================================================
