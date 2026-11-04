-------------------- MODULE MutNoRunningHas --------------------
(* MUTANT for NoDoubleRun (expect: Invariant NoDoubleRun is violated).      *)
(* Code change: src/agent/workers.ts WorkerPool.pump drops                 *)
(*     if (this.running.has(t.id)) continue;                               *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.skipRunning = FALSE])
=============================================================================
