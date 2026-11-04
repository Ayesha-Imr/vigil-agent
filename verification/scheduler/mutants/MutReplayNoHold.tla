-------------------------- MODULE MutReplayNoHold --------------------------
(* MUTANT for NoOverlap (expect: Invariant NoOverlap is violated). Breaks  *)
(* the new S3 code: src/core/scheduler.ts unfinishedRuns drops             *)
(*     for (const run of runs) this.db.run("UPDATE jobs SET running_since  *)
(*       = ? WHERE id = ?", run.claimedAt, run.job.id);                    *)
(* The replayed run then does not hold its job, and the next slot's claim  *)
(* overlaps it.                                                            *)
EXTENDS Scheduler
NextM == Tick \/ ClaimDue \/ RunFinishes \/ Crash \/ RestartWith(FALSE, TRUE, FALSE) \/ DispatchReplays
SpecM == Init /\ [][NextM]_vars
=============================================================================
