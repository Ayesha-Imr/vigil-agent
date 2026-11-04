-------------------------- MODULE MutOverlapOnFix --------------------------
(* MUTANT for OverlapOnlyAfterLease (expect: Invariant                     *)
(* OverlapOnlyAfterLease is violated).                                     *)
(* The current code already breaks this property (finding S2), so the     *)
(* mutant starts from the fix (FixStaleComplete: complete() frees the job  *)
(* only WHERE running_since = claimedAt) and then makes one code change:   *)
(* claimDue's due query loses AND (running_since IS NULL OR                *)
(* running_since < ?). Shows the property can fail once S2 is fixed.       *)
EXTENDS Scheduler

ReleaseMine(r) ==
    IF runningSince[r.job] = r.started THEN [runningSince EXCEPT ![r.job] = Null] ELSE runningSince
DueNoLease(j) == enabled[j] /\ nextRun[j] # Null /\ nextRun[j] <= now
ClaimDueM == ClaimDueWith(DueNoLease, Fresh, CountSlots, NextRunAt)
NextM == Tick \/ ClaimDueM \/ (\E r \in runs : FinishWith(r, ReleaseMine)) \/ Crash \/ Restart
SpecM == Init /\ [][NextM]_vars
=============================================================================
