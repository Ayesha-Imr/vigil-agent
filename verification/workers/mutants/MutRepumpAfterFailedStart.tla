-------------------- MODULE MutRepumpAfterFailedStart --------------------
(* MUTANT for EventLoopProgress (expect: Temporal property                  *)
(* EventLoopProgress was violated). Reverts both halves of the W4 fix in   *)
(* src/agent/workers.ts: the continuation pumps again even when run()      *)
(* resolved false (`if (started) this.pump()` -> `this.pump()`), and pump  *)
(* drops the failedStart test.                                             *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.pumpAfterFailedStart = TRUE, !.cooldown = FALSE])
=============================================================================
