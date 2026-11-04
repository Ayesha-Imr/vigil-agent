------------------------------ MODULE MutNoLock ------------------------------
(* MUTANT for the daemon lock, checked by AtMostOnceWithoutCrashOrTimeout   *)
(* with two daemons (expect: Invariant AtMostOnceWithoutCrashOrTimeout is   *)
(* violated).                                                               *)
(* Code change, src/daemon.ts start (line 220): delete  this.takeLock();    *)
(* vigil chat then starts next to vigil start on one home: the code before  *)
(* ea743b1 (finding F2).                                                    *)
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
    \/ LockStepsWith(FALSE, FALSE, TRUE)
SpecM == Init /\ [][NextM]_vars
=============================================================================
