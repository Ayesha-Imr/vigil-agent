-------------------------- MODULE MutNoLeaseCheck --------------------------
(* MUTANT for NoOverlap (expect: Invariant NoOverlap is violated).         *)
(* Code change: src/core/scheduler.ts claimDue's due query loses           *)
(*     AND (running_since IS NULL OR running_since < ?)                    *)
EXTENDS Scheduler
DueNoLease(j) == enabled[j] /\ nextRun[j] # Null /\ nextRun[j] <= now
ClaimDueM == ClaimDueWith(DueNoLease, Fresh, CountSlots, NextRunAt)
NextM == Tick \/ ClaimDueM \/ RunFinishes \/ Crash \/ Restart \/ DispatchReplays
SpecM == Init /\ [][NextM]_vars
=============================================================================
