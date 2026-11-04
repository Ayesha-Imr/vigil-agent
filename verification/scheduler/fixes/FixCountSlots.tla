--------------------------- MODULE FixCountSlots ---------------------------
(* FIX for finding S1 (expect: NoLostSlot holds).                          *)
(* Code change: src/core/scheduler.ts countSlots, the loop's break test    *)
(*     if (next === null || next >= to) break;                             *)
(* becomes                                                                 *)
(*     if (next === null || next > to) break;                              *)
(* so a slot exactly at `now` is counted in `coalesced` (nextRunAt(now) is *)
(* strictly after now, so it would otherwise fall between the two).        *)
EXTENDS Scheduler

RECURSIVE CountLoopFix(_, _, _, _)
CountLoopFix(j, t, to, n) ==
    LET next == NextRunAt(j, t) IN
    IF next = Null \/ next > to THEN n ELSE CountLoopFix(j, next, to, n + 1)

CountSlotsFix(j, from, to) == IF Kind[j] = "at" THEN 0 ELSE CountLoopFix(j, from, to, 0)

ClaimDueFix == ClaimDueWith(Due, Fresh, CountSlotsFix, NextRunAt)

NextFix == Tick \/ ClaimDueFix \/ (\E r \in runs : Finish(r)) \/ Crash \/ Restart

SpecFix == Init /\ [][NextFix]_vars /\ WF_vars(Tick) /\ WF_vars(ClaimDueFix) /\ WF_vars(Restart)
           /\ \A j \in Jobs : WF_vars(\E r \in runs : r.job = j /\ Finish(r))
=============================================================================
