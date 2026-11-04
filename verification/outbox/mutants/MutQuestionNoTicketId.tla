------------------------ MODULE MutQuestionNoTicketId ------------------------
(* MUTANT for TicketMessagesInOrder (expect: Invariant                      *)
(* TicketMessagesInOrder is violated).                                      *)
(* Code change, src/agent/tools.ts ask_owner (line 337): drop the ticketId  *)
(* option again:                                                            *)
(*   { buttons, replyTo: ticket().origin.externalId, ticketId }             *)
(*   ->  { buttons, replyTo: ticket().origin.externalId }                   *)
(* sendSolicited (services.ts:98-101) then keys only ref.kind "ticket", so  *)
(* the question has no order key: the code before ea743b1 (finding F1).     *)
EXTENDS Outbox

NoTicketIdKey(g) ==
    IF Items[g].kind = "ticket" THEN Items[g].ticket
    ELSE IF Items[g].parts > 1 THEN "split:" \o Items[g].name ELSE NoKey
NextM ==
    \/ EnqueueWith(NoTicketIdKey)
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
