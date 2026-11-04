--------------------------- MODULE MutRewindOnly ---------------------------
(* GUARD DEMO for OneTriggerPerSlot (expect: no error). Only mutation 2 of *)
(* MutOneTrigger (recover() rewinds next_run_at to last_slot): the slot is *)
(* claimed again, but the UNIQUE key makes the INSERT a no-op (fresh =     *)
(* false), so there is still one trigger per slot.                         *)
EXTENDS Scheduler
NextM == Tick \/ ClaimDue \/ RunFinishes \/ Crash \/ RestartWith(TRUE, TRUE, TRUE) \/ DispatchReplays
SpecM == Init /\ [][NextM]_vars
=============================================================================
