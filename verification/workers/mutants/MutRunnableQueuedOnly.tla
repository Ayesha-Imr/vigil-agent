-------------------- MODULE MutRunnableQueuedOnly --------------------
(* MUTANT for OwnerNeverStarved (expect: Temporal property                  *)
(* OwnerNeverStarved was violated). The current code already breaks it     *)
(* (finding W2), so this starts from Workers!Fixed and makes one change:   *)
(* src/core/tickets.ts Tickets.runnable keeps only stage = queued:         *)
(*     .filter((t) => t.stage === "queued")                                *)
(* Input that arrives during the last allowed turn then waits for ever.    *)
EXTENDS Workers

SpecM == SpecWith([Fixed EXCEPT !.runnableInputs = FALSE])
=============================================================================
