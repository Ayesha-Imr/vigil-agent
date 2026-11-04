-------------------------- MODULE MutNextFromSlot --------------------------
(* MUTANT for NoLostSlot (expect: Invariant NoLostSlot is violated).       *)
(* Code change in src/core/scheduler.ts claimDue, "keep the cadence on the *)
(* slot grid":                                                             *)
(*     const next = nextRunAt(job.kind, job.spec, now, tz);                *)
(*  -> const next = nextRunAt(job.kind, job.spec, slot, tz);               *)
(* A late claim then counts slots in `coalesced` that later get their own  *)
(* trigger as well (accounted twice).                                      *)
EXTENDS Scheduler
NextFromSlot(j, nowArg) == NextRunAt(j, nextRun[j])
ClaimDueM == ClaimDueWith(Due, Fresh, CountSlots, NextFromSlot)
NextM == Tick \/ ClaimDueM \/ RunFinishes \/ Crash \/ Restart \/ DispatchReplays
SpecM == Init /\ [][NextM]_vars
=============================================================================
