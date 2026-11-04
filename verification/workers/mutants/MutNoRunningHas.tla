-------------------- MODULE MutNoRunningHas --------------------
(* MUTANT for NoDoubleRun (expect: Invariant NoDoubleRun is violated).      *)
(* Code change: src/agent/workers.ts WorkerPool.pump drops                 *)
(*     if (this.running.has(t.id)) continue;                               *)
(* A ticket the owner reopens (stage queued) while its run is in flight   *)
(* gets a second run.                                                      *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.skipRunning = FALSE])
=============================================================================
