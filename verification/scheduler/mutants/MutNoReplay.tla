---------------------------- MODULE MutNoReplay ----------------------------
(* MUTANT for AtJobRuns / ClaimedRunCompletes (expect: Temporal property   *)
(* AtJobRuns was violated), with one crash. Reverts the S3 fix:            *)
(* src/daemon.ts start() drops                                             *)
(*     const unfinished = s.scheduler.unfinishedRuns(DAY);                 *)
(*     ... for (const run of unfinished) void this.runJob(run);            *)
EXTENDS Scheduler
NextM == Tick \/ ClaimDue \/ RunFinishes \/ Crash \/ RestartWith(FALSE, FALSE, TRUE) \/ DispatchReplays
SpecM == Init /\ [][NextM]_vars /\ WF_vars(Tick) /\ WF_vars(ClaimDue)
         /\ WF_vars(RestartWith(FALSE, FALSE, TRUE)) /\ WF_vars(DispatchReplays)
         /\ \A j \in Jobs : WF_vars(\E r \in runs : r.job = j /\ Finish(r))
=============================================================================
