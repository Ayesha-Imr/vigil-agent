-------------------- MODULE MutStopIgnoredOnFix --------------------
(* MUTANT for StoppedNeverRunsAgain (expect: Invariant                      *)
(* StoppedNeverRunsAgain is violated). The current code already breaks it  *)
(* (finding W1), so this starts from Workers!Fixed and makes one change:   *)
(* src/core/tickets.ts addInput drops the stopped_by_owner test; the       *)
(* reopened ticket runs again.                                             *)
EXTENDS Workers

SpecM == SpecWith([Fixed EXCEPT !.checkStopped = FALSE])
=============================================================================
