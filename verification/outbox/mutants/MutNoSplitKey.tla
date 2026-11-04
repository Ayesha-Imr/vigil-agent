---------------------------- MODULE MutNoSplitKey ----------------------------
(* MUTANT for SplitPartsInOrder (expect: Invariant SplitPartsInOrder is     *)
(* violated).                                                               *)
(* Code change, src/core/outbox.ts enqueue (line 60): no generated key for  *)
(* the parts of a long message:                                             *)
(*   const orderKey = item.orderKey ?? (parts.length > 1 ? `split:...` : null);*)
(*   ->  const orderKey = item.orderKey ?? null;                            *)
(* OrderPreserved still holds (the parts have no key at all); only the      *)
(* split property sees it.                                                  *)
EXTENDS Outbox

NextM ==
    \/ EnqueueWith(CallerKey)
    \/ \E p \in Slots : PassStart(p)
    \/ \E p \in Slots : SendReturns(p)
    \/ \E p \in Slots : Continue(p)
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart
SpecM == Init /\ [][NextM]_vars
=============================================================================
