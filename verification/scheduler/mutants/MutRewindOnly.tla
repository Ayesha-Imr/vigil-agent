--------------------------- MODULE MutRewindOnly ---------------------------
(* GUARD DEMO for OneTriggerPerSlot (expect: no error).                    *)
(* Only mutation 2 of MutOneTrigger: recover() rewinds next_run_at to      *)
(* last_slot. The slot is claimed again, but the UNIQUE key turns the      *)
(* INSERT into a no-op (fresh = false): still one trigger per slot.        *)
EXTENDS Scheduler

RestartRewind ==
    /\ ~up
    /\ up' = TRUE
    /\ nextRun' = [j \in Jobs |-> IF runningSince[j] # Null THEN lastSlot[j] ELSE nextRun[j]]
    /\ runningSince' = [j \in Jobs |-> Null]
    /\ UNCHANGED <<now, crashes, enabled, lastSlot, triggers, tcount, runs>>

NextM == Tick \/ ClaimDue \/ (\E r \in runs : Finish(r)) \/ Crash \/ RestartRewind
SpecM == Init /\ [][NextM]_vars
=============================================================================
