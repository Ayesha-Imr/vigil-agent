---------------------------- MODULE MutCountGe ----------------------------
(* MUTANT for NoLostSlot (expect: Invariant NoLostSlot is violated).       *)
(* Reverts the S1 fix: src/core/scheduler.ts countSlots break test         *)
(*     if (next === null || next > to) break;  ->  next >= to              *)
EXTENDS Scheduler
ClaimDueM == ClaimDueWith(Due, Fresh, CountSlotsGe, NextRunAt)
NextM == Tick \/ ClaimDueM \/ RunFinishes \/ Crash \/ Restart \/ DispatchReplays
SpecM == Init /\ [][NextM]_vars
=============================================================================
