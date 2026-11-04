-------------------------- MODULE MutNoUniqueOnly --------------------------
(* GUARD DEMO for OneTriggerPerSlot (expect: no error). Only mutation 1 of *)
(* MutOneTrigger (no UNIQUE key on triggers): claimDue still moves         *)
(* next_run_at past now in the same transaction, so no slot is claimed     *)
(* twice.                                                                  *)
EXTENDS Scheduler
AlwaysFresh(j) == TRUE
ClaimDueM == ClaimDueWith(Due, AlwaysFresh, CountSlots, NextRunAt)
NextM == Tick \/ ClaimDueM \/ RunFinishes \/ Crash \/ Restart \/ DispatchReplays
SpecM == Init /\ [][NextM]_vars
=============================================================================
