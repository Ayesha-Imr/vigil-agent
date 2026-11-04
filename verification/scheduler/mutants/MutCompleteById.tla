-------------------------- MODULE MutCompleteById --------------------------
(* MUTANT for OverlapOnlyAfterLease (expect: Invariant                     *)
(* OverlapOnlyAfterLease is violated). Reverts the S2 fix:                 *)
(* src/core/scheduler.ts complete() goes back to                           *)
(*     UPDATE jobs SET running_since = NULL, ... WHERE id = ?              *)
(* (equivalently: daemon.ts runJob finish stops passing run.claimedAt).    *)
EXTENDS Scheduler
FinishById(r) == FinishWith(r, ReleaseById)
NextM == Tick \/ ClaimDue \/ (\E r \in runs : FinishById(r)) \/ Crash \/ Restart \/ DispatchReplays
SpecM == Init /\ [][NextM]_vars
=============================================================================
