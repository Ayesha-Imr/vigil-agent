------------------------- MODULE FixStaleComplete -------------------------
(* FIX for finding S2 (expect: OverlapOnlyAfterLease holds).               *)
(* Code change: JobRun carries the claim instant, and complete() frees the *)
(* job only while this run still holds it:                                 *)
(*   src/core/scheduler.ts complete(jobId, status, claimedAt):             *)
(*     UPDATE jobs SET running_since = NULL, ... WHERE id = ?              *)
(*       AND running_since = ?          -- claimedAt                       *)
(*   src/daemon.ts runJob finish: s.scheduler.complete(job.id, status,     *)
(*     run.claimedAt)                                                      *)
EXTENDS Scheduler

ReleaseMine(r) ==
    IF runningSince[r.job] = r.started THEN [runningSince EXCEPT ![r.job] = Null] ELSE runningSince

FinishFix(r) == FinishWith(r, ReleaseMine)

NextFix == Tick \/ ClaimDue \/ (\E r \in runs : FinishFix(r)) \/ Crash \/ Restart

SpecFix == Init /\ [][NextFix]_vars /\ WF_vars(Tick) /\ WF_vars(ClaimDue) /\ WF_vars(Restart)
           /\ \A j \in Jobs : WF_vars(\E r \in runs : r.job = j /\ FinishFix(r))
=============================================================================
