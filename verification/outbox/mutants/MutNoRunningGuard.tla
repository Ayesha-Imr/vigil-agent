-------------------------- MODULE MutNoRunningGuard --------------------------
(* MUTANT for AtMostOnceWithoutCrashOrTimeout (expect: Invariant            *)
(* AtMostOnceWithoutCrashOrTimeout is violated).                            *)
(* Code change, src/core/outbox.ts deliverDue (line 88): drop the running  *)
(* test:                                                                    *)
(*   if (this.running || !this.mayDeliver()) return 0;                     *)
(*   ->  if (!this.mayDeliver()) return 0;                                  *)
(* The 3 s timer (daemon.ts:250) and say()'s `void deliverDue()`            *)
(* (daemon.ts:497) can then both be inside the loop with the same row.      *)
EXTENDS Outbox

NextM ==
    \/ Enqueue
    \/ \E p \in Slots : PassStartWith(p, FALSE, CodeSelected, CodeBlocks)
    \/ \E p \in Slots : SendSettles(p) \/ Hang(p)
    \/ \E p \in Slots : Continue(p)
    \/ Orphans
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart
    \/ LockSteps
SpecM == Init /\ [][NextM]_vars
=============================================================================
