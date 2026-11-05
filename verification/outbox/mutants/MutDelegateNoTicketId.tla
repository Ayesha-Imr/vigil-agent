------------------------- MODULE MutDelegateNoTicketId -------------------------
(* MUTANT for TicketMessagesInOrder (expect: Invariant                      *)
(* TicketMessagesInOrder is violated).                                      *)
(* Code change, src/agent/delegate.ts (lines 40-41): delete  ticketId,      *)
(* and  approvalRoute,  from the helper's buildSession spec: the code       *)
(* before 2fed3cb (finding F1c).  The helper's approval ask then has no     *)
(* order key (sessions.ts:105) and overtakes the ticket's question.         *)
EXTENDS Outbox

NoHelperKey(g) ==
    IF Items[g].kind \in {"ticket", "attention", "approval"} THEN Items[g].ticket
    ELSE IF Items[g].parts > 1 THEN "split:" \o Items[g].name ELSE NoKey
NextM ==
    \/ EnqueueWith(NoHelperKey)
    \/ \E p \in Slots : PassStart(p)
    \/ \E p \in Slots : SendSettles(p) \/ Hang(p)
    \/ \E p \in Slots : Continue(p)
    \/ Orphans
    \/ \E r \in Rows : BackoffElapses(r)
    \/ Crash
    \/ Restart
    \/ LockSteps
SpecM == Init /\ [][NextM]_vars
=============================================================================
