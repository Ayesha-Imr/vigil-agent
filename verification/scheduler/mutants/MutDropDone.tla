---------------------------- MODULE MutDropDone ----------------------------
(* MUTANT for AtJobRuns / ClaimedRunCompletes (expect: Temporal properties *)
(* were violated), with no crashes at all.                                 *)
(* Code change: src/agent/concierge.ts handle(), the twice-preempted       *)
(* branch drops its callback:                                              *)
(*     else input.done?.("interrupted twice; skipped");   ->   (removed)   *)
(* runJob's finish() (daemon.ts, passed as `done: finish`) never runs:     *)
(* the run is gone from memory, the job stays held until the lease, and    *)
(* its trigger stays 'received'.                                           *)
EXTENDS Scheduler

\* The run ends without calling finish(): memory only, no DB write.
Abandon(r) ==
    /\ up
    /\ r \in runs
    /\ runs' = runs \ {r}
    /\ UNCHANGED <<now, up, crashes, nextRun, runningSince, enabled, lastSlot, triggers, tcount>>

NextM == Tick \/ ClaimDue \/ (\E r \in runs : Abandon(r)) \/ Crash \/ Restart
SpecM == Init /\ [][NextM]_vars /\ WF_vars(Tick) /\ WF_vars(ClaimDue) /\ WF_vars(Restart)
         /\ \A j \in Jobs : WF_vars(\E r \in runs : r.job = j /\ Abandon(r))
=============================================================================
