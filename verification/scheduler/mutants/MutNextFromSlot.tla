-------------------------- MODULE MutNextFromSlot --------------------------
(* MUTANT for NoLostSlot (expect: Invariant NoLostSlot is violated).       *)
(* The current code already breaks NoLostSlot (finding S1), so the mutant  *)
(* starts from the fix (FixCountSlots: countSlots breaks on next > to) and *)
(* makes one code change in src/core/scheduler.ts claimDue:                *)
(*     const next = nextRunAt(job.kind, job.spec, now, tz);                *)
(* becomes "keep the cadence on the slot grid":                            *)
(*     const next = nextRunAt(job.kind, job.spec, slot, tz);               *)
(* A late claim then counts slots in `coalesced` that later get their own  *)
(* trigger as well (accounted twice).                                      *)
EXTENDS Scheduler

RECURSIVE CountLoopFix(_, _, _, _)
CountLoopFix(j, t, to, n) ==
    LET next == NextRunAt(j, t) IN
    IF next = Null \/ next > to THEN n ELSE CountLoopFix(j, next, to, n + 1)
CountSlotsFix(j, from, to) == IF Kind[j] = "at" THEN 0 ELSE CountLoopFix(j, from, to, 0)

\* nextRunAt(kind, spec, slot): NextOp gets `now`, so read the slot from nextRun.
NextFromSlot(j, nowArg) == NextRunAt(j, nextRun[j])

ClaimDueM == ClaimDueWith(Due, Fresh, CountSlotsFix, NextFromSlot)
NextM == Tick \/ ClaimDueM \/ (\E r \in runs : Finish(r)) \/ Crash \/ Restart
SpecM == Init /\ [][NextM]_vars
=============================================================================
