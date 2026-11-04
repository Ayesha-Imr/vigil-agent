------------------------- MODULE MutHeldBackDueOnly -------------------------
(* MUTANT for OrderPreserved (expect: Invariant OrderPreserved is violated). *)
(* Code change, src/core/outbox.ts heldBack (lines 106-111): only earlier   *)
(* rows that are due right now hold a later one back:                       *)
(*   ... AND status IN ('pending', 'failing') AND attempts < ?              *)
(*   ->  ... AND status IN ('pending', 'failing') AND attempts < ?          *)
(*           AND next_attempt_at <= ?            (bound to this.clock.now())*)
(* An earlier message waiting out its backoff no longer holds back the next.*)
EXTENDS Outbox

DueBlocks(i) == CodeBlocks(i) /\ due[i]
NextM ==
    \/ Enqueue
    \/ \E p \in Slots : PassStartWith(p, TRUE, CodeSelected, DueBlocks)
    \/ \E p \in Slots : SendReturns(p)
    \/ \E p \in Slots : ContinueWith(p, DueBlocks)
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart
SpecM == Init /\ [][NextM]_vars
=============================================================================
