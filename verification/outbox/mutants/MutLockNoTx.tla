----------------------------- MODULE MutLockNoTx -----------------------------
(* MUTANT for the daemon lock, checked by AtMostOnceWithoutCrashOrTimeout   *)
(* with two daemons (expect: Invariant AtMostOnceWithoutCrashOrTimeout is   *)
(* violated).                                                               *)
(* Code change, src/daemon.ts takeLock (lines 194-200): drop the            *)
(* s.db.tx(() => { ... }) around the getKv, the check and the setKv: the   *)
(* code before 4f5ff60 (finding F2c).  Two daemons started together both    *)
(* read no lock, then both write it and run.                                *)
EXTENDS Outbox

NextM ==
    \/ Enqueue
    \/ \E p \in Slots : PassStart(p)
    \/ \E p \in Slots : SendSettles(p) \/ Hang(p)
    \/ \E p \in Slots : Continue(p)
    \/ Orphans
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart
    \/ LockStepsWith(TRUE, TRUE, TRUE)
SpecM == Init /\ [][NextM]_vars
=============================================================================
