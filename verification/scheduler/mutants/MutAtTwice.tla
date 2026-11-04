---------------------------- MODULE MutAtTwice ----------------------------
(* MUTANT for AtJobsFireOnce (expect: Invariant AtJobsFireOnce is          *)
(* violated). "At most once" has two guards, so the mutant removes both:   *)
(*  1. src/core/scheduler.ts nextRunAt, case "at":                         *)
(*       return t > after ? t : null;   ->   return t >= after ? t : null; *)
(*  2. src/store/db.ts triggers: drop UNIQUE (source, external_id).        *)
EXTENDS Scheduler
NextGe(j, after) ==
    IF Kind[j] = "every" THEN after + Period
    ELSE IF AtTime >= after THEN AtTime ELSE Null
AlwaysFresh(j) == TRUE
ClaimDueM == ClaimDueWith(Due, AlwaysFresh, CountSlots, NextGe)
NextM == Tick \/ ClaimDueM \/ RunFinishes \/ Crash \/ Restart \/ DispatchReplays
SpecM == Init /\ [][NextM]_vars
=============================================================================
