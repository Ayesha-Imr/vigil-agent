---------------------------- MODULE MutPendingOnly ----------------------------
(* MUTANT for NoLoss (expect: Temporal property NoLoss is violated).        *)
(* Code change, src/core/outbox.ts deliverDue (line 93): the due query no   *)
(* longer retries 'failing' rows:                                           *)
(*   WHERE status IN ('pending', 'failing') AND next_attempt_at <= ?        *)
(*   ->  WHERE status IN ('pending') AND next_attempt_at <= ?               *)
(* A message with BLOCKING_ATTEMPTS failures is never tried again.          *)
EXTENDS Outbox

PendingOnly(r) == status[r] = "pending"
PassStartM(p) == PassStartWith(p, TRUE, PendingOnly, CodeBlocks)
NextM ==
    \/ Enqueue
    \/ \E p \in Slots : PassStartM(p)
    \/ \E p \in Slots : SendSettles(p) \/ Hang(p)
    \/ \E p \in Slots : Continue(p)
    \/ Orphans
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart
    \/ LockSteps
FairnessM ==
    /\ WF_vars(\E p \in Slots : PassStartM(p))
    /\ WF_vars(\E p \in Slots : SendSettles(p))
    /\ WF_vars(\E p \in Slots : Continue(p))
    /\ \A r \in Rows : WF_vars(BackoffElapses(r))
    /\ WF_vars(Restart)
LiveSpecM == Init /\ [][NextM]_vars /\ FairnessM
=============================================================================
