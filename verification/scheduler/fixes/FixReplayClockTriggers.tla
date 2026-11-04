---------------------- MODULE FixReplayClockTriggers ----------------------
(* FIX for finding S3 (expect: AtJobRuns and ClaimedRunCompletes hold, and *)
(* NoOverlap / OneTriggerPerSlot still hold).                              *)
(* Code change, src/daemon.ts start(), right after s.scheduler.recover():  *)
(* for each job, take its newest 'received' clock trigger, mark the older  *)
(* 'received' ones of that job done ("superseded"), set the job's          *)
(* running_since = now, and call runJob() for the newest one with the slot *)
(* and coalesced from its payload. (reprocessStuckTriggers keeps skipping  *)
(* 'clock'; this replays them through runJob instead of route().)          *)
EXTENDS Scheduler

Stuck(j) == {tr \in triggers : tr.job = j /\ tr.status = "received"}
Newest(j) == CHOOSE tr \in Stuck(j) : \A o \in Stuck(j) : o.id <= tr.id
Replay == {j \in Jobs : Stuck(j) # {}}

RestartFix ==
    /\ ~up
    /\ up' = TRUE
    /\ runningSince' = [j \in Jobs |-> IF j \in Replay THEN now ELSE Null]
    /\ triggers' = {IF tr.status = "received" /\ tr # Newest(tr.job) THEN [tr EXCEPT !.status = "done"] ELSE tr
                    : tr \in triggers}
    /\ runs' = {[job |-> j, tid |-> Newest(j).id, started |-> now] : j \in Replay}
    /\ UNCHANGED <<now, crashes, nextRun, enabled, lastSlot, tcount>>

NextFix == Tick \/ ClaimDue \/ (\E r \in runs : Finish(r)) \/ Crash \/ RestartFix

SpecFix == Init /\ [][NextFix]_vars /\ WF_vars(Tick) /\ WF_vars(ClaimDue) /\ WF_vars(RestartFix)
           /\ \A j \in Jobs : WF_vars(\E r \in runs : r.job = j /\ Finish(r))
=============================================================================
