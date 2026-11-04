--------------------------- MODULE MutRefOutsideTx ---------------------------
(* MUTANT for RefRecorded (expect: Invariant RefRecorded is violated).      *)
(* Code change, src/core/outbox.ts sendOne (lines 136-148): drop the        *)
(* this.db.tx(() => { ... }) wrapper, so the UPDATE ... status = 'sent'     *)
(* and the INSERT OR REPLACE INTO message_refs are two separate commits.    *)
(* A process death between them (kill -9, power loss, OOM) leaves a row     *)
(* marked sent with no message_refs row.  The model gives that boundary its *)
(* own step (RecordRef) so Crash can fall on it.                            *)
EXTENDS Outbox

NextM ==
    \/ Enqueue
    \/ \E p \in Slots : PassStart(p)
    \/ \E p \in Slots : SucceedWith(p, FALSE) \/ FailTransient(p) \/ FailPermanent(p)
                        \/ TimeoutFires(p) \/ Hang(p)
    \/ \E p \in Slots : RecordRef(p)
    \/ \E p \in Slots : Continue(p)
    \/ Orphans
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart
    \/ LockSteps
SpecM == Init /\ [][NextM]_vars
=============================================================================
