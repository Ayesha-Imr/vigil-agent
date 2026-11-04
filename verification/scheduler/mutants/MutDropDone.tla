---------------------------- MODULE MutDropDone ----------------------------
(* MUTANT for AtJobRuns / ClaimedRunCompletes (expect: Temporal property   *)
(* AtJobRuns was violated), with no crash. Code change:                    *)
(* src/agent/concierge.ts pump()'s catch stops releasing the system run:    *)
(*     if (cur?.kind === "system" && !this.disposed) cur.done?.(...)       *)
(*   -> (removed)                                                          *)
(* runJob's finish() never runs: the run is gone from memory, the job stays *)
(* held until the lease, its trigger stays received.                       *)
EXTENDS Scheduler
Abandon(r) ==
    /\ up /\ r \in runs
    /\ runs' = runs \ {r}
    /\ UNCHANGED <<now, up, starting, crashes, nextRun, runningSince, enabled, lastSlot, triggers, tcount, replay>>
NextM == Tick \/ ClaimDue \/ (\E r \in runs : Abandon(r)) \/ Crash \/ Restart \/ DispatchReplays
SpecM == Init /\ [][NextM]_vars /\ WF_vars(Tick) /\ WF_vars(ClaimDue) /\ WF_vars(Restart)
         /\ WF_vars(DispatchReplays) /\ \A j \in Jobs : WF_vars(\E r \in runs : r.job = j /\ Abandon(r))
=============================================================================
