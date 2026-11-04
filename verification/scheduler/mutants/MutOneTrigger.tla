--------------------------- MODULE MutOneTrigger ---------------------------
(* MUTANT for OneTriggerPerSlot (expect: Invariant OneTriggerPerSlot is    *)
(* violated).                                                              *)
(* OneTriggerPerSlot has two independent guards, so the mutant removes     *)
(* both (each alone keeps the property: see MutRewindOnly, MutNoUniqueOnly):*)
(*  1. src/store/db.ts triggers: drop UNIQUE (source, external_id), so     *)
(*     claimDue's INSERT ... ON CONFLICT DO NOTHING always inserts.        *)
(*  2. src/core/scheduler.ts recover(): a natural attempt at "retry a run  *)
(*     the crash cut short":                                               *)
(*       UPDATE jobs SET next_run_at = last_slot, running_since = NULL     *)
(*       WHERE running_since IS NOT NULL                                   *)
EXTENDS Scheduler

AlwaysFresh(j) == TRUE

RestartRewind ==
    /\ ~up
    /\ up' = TRUE
    /\ nextRun' = [j \in Jobs |-> IF runningSince[j] # Null THEN lastSlot[j] ELSE nextRun[j]]
    /\ runningSince' = [j \in Jobs |-> Null]
    /\ UNCHANGED <<now, crashes, enabled, lastSlot, triggers, tcount, runs>>

ClaimDueM == ClaimDueWith(Due, AlwaysFresh, CountSlots, NextRunAt)

NextM == Tick \/ ClaimDueM \/ (\E r \in runs : Finish(r)) \/ Crash \/ RestartRewind
SpecM == Init /\ [][NextM]_vars
=============================================================================
