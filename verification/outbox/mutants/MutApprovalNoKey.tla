--------------------------- MODULE MutApprovalNoKey ---------------------------
(* MUTANT for TicketMessagesInOrder (expect: Invariant                      *)
(* TicketMessagesInOrder is violated).                                      *)
(* Code change, src/agent/sessions.ts approval ask (line 105): delete       *)
(*   orderKey: spec.ticketId ? `${spec.ticketId}:...` : undefined,          *)
(* the code before 4f5ff60 (finding F1b): a worker's approval ask overtakes *)
(* the ticket's question when that send fails once.                         *)
EXTENDS Outbox

NoApprovalKey(g) ==
    IF Items[g].kind \in {"ticket", "attention"} THEN Items[g].ticket
    ELSE IF Items[g].parts > 1 THEN "split:" \o Items[g].name ELSE NoKey
NextM ==
    \/ EnqueueWith(NoApprovalKey)
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
