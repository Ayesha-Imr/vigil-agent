--------------------------- MODULE MutOneTrigger ---------------------------
(* MUTANT for OneTriggerPerSlot (expect: Invariant OneTriggerPerSlot is    *)
(* violated). The property has two independent guards, so the mutant      *)
(* removes both (each alone keeps it: see MutRewindOnly, MutNoUniqueOnly): *)
(*  1. src/store/db.ts triggers: drop UNIQUE (source, external_id), so     *)
(*     claimDue's INSERT ... ON CONFLICT DO NOTHING always inserts.        *)
(*  2. src/core/scheduler.ts recover(): also rewind the schedule,          *)
(*       UPDATE jobs SET next_run_at = last_slot, running_since = NULL     *)
(*       WHERE running_since IS NOT NULL                                   *)
EXTENDS Scheduler
AlwaysFresh(j) == TRUE
ClaimDueM == ClaimDueWith(Due, AlwaysFresh, CountSlots, NextRunAt)
NextM == Tick \/ ClaimDueM \/ RunFinishes \/ Crash \/ RestartWith(TRUE, TRUE, TRUE) \/ DispatchReplays
SpecM == Init /\ [][NextM]_vars
=============================================================================
