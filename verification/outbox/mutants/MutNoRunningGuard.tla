-------------------------- MODULE MutNoRunningGuard --------------------------
(* MUTANT for AtMostOnceWithoutCrash (expect: Invariant                     *)
(* AtMostOnceWithoutCrash is violated).                                     *)
(* Code change, src/core/outbox.ts deliverDue (line 86): delete             *)
(*   if (this.running) return 0;                                            *)
(* The 3 s timer (daemon.ts:189) and say()'s `void deliverDue()`            *)
(* (daemon.ts:407) can then both be inside the loop with the same row.      *)
EXTENDS Outbox

NextM ==
    \/ Enqueue
    \/ \E p \in Slots : PassStartWith(p, FALSE, CodeSelected, CodeBlocks)
    \/ \E p \in Slots : SendReturns(p)
    \/ \E p \in Slots : Continue(p)
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart
SpecM == Init /\ [][NextM]_vars
=============================================================================
