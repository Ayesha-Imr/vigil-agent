--------------------------- MODULE MutNoSendTimeout ---------------------------
(* MUTANT for NoLoss (expect: Temporal property NoLoss is violated).        *)
(* Code change, src/core/outbox.ts sendOne (line 128): no timeout around    *)
(* the send, as before ea743b1:                                             *)
(*   await withTimeout(SEND_TIMEOUT_MS, channel.send({...}))                *)
(*   ->  await channel.send({...})                                          *)
(* One send that never settles keeps `running` true: nothing else is sent,  *)
(* on any channel.                                                          *)
EXTENDS Outbox

NextM ==
    \/ Enqueue
    \/ \E p \in Slots : PassStart(p)
    \/ \E p \in Slots : SendReturns(p) \/ Hang(p)
    \/ \E p \in Slots : Continue(p)
    \/ Orphans
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart
    \/ LockSteps
FairnessM ==
    /\ WF_vars(\E p \in Slots : PassStart(p))
    /\ WF_vars(\E p \in Slots : SendReturns(p))
    /\ WF_vars(\E p \in Slots : Continue(p))
    /\ \A r \in Rows : WF_vars(BackoffElapses(r))
    /\ WF_vars(Restart)
LiveSpecM == Init /\ [][NextM]_vars /\ FairnessM
=============================================================================
