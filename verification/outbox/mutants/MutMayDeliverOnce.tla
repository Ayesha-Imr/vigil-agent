--------------------------- MODULE MutMayDeliverOnce ---------------------------
(* MUTANT for SendsOnlyWithLock (expect: Invariant SendsOnlyWithLock is     *)
(* violated).                                                               *)
(* Code change, src/core/outbox.ts deliverDue (line 99): delete             *)
(*   if (!this.mayDeliver()) break;                                         *)
(* the code before 06d3da0 (part of finding F2d): mayDeliver is read only   *)
(* at pass start, so a daemon that lost the lock during a send goes on      *)
(* sending the rest of its snapshot.                                        *)
EXTENDS Outbox

NextM ==
    \/ Enqueue
    \/ \E p \in Slots : PassStartWithR(p, TRUE, CodeSelected, CodeBlocks, FALSE)
    \/ \E p \in Slots : SendSettles(p) \/ Hang(p)
    \/ \E p \in Slots : ContinueWithR(p, CodeBlocks, FALSE)
    \/ Orphans
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart
    \/ LockSteps
SpecM == Init /\ [][NextM]_vars
=============================================================================
