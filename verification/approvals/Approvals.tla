----------------------------- MODULE Approvals -----------------------------
(***************************************************************************)
(* Approvals for risky tool calls: src/core/approvals.ts (request, wait,   *)
(* decide, consume, expire), the gate that uses them (approvalGate in      *)
(* src/agent/gate.ts), and the inbox path that turns a button press into   *)
(* decide() (Daemon.route -> handleButton in src/daemon.ts, isOwner in     *)
(* src/config.ts).                                                         *)
(*                                                                         *)
(* One action per indivisible step of the code. node:sqlite is synchronous *)
(* and the daemon is one JS thread, so a run of code with no await is one  *)
(* step:                                                                   *)
(*                                                                         *)
(*  Request(c)     gate.ts tool_call hook: request() INSERT, h.ask()       *)
(*                 (outbox enqueue of the buttons), wait() reads the row   *)
(*                 and registers its waiter and timer: no await between.   *)
(*  Press(p,a,b)   Daemon.route(msg): isOwner(), the HTTP refusal for      *)
(*                 approve/deny unless channels.http.allowApprovals, then  *)
(*                 handleButton -> decide(id, approve), which also calls   *)
(*                 the waiter of that id.                                  *)
(*  Timer(c)       wait()'s setTimeout: expire(), then done(status ===     *)
(*                 "approved" ? "approved" : "expired").                   *)
(*  Sweep          Daemon.tickGovernorAndClock: approvals.expire().        *)
(*  Abort(c)       wait()'s abort listener: UPDATE ... SET status =        *)
(*                 'expired' for this id if pending/approved; done().      *)
(*  Continue(c,a)  the gate after `await wait()`: if "approved", consume(  *)
(*                 a, callHash(tool, input)) and run the call on true;     *)
(*                 otherwise block it.                                     *)
(*  Retry(c)       the worker's model issues the same tool call again.     *)
(*  Dispose        Approvals.dispose() at shutdown: every waiter gets      *)
(*                 "expired"; a later wait() returns "expired" at once.    *)
(*  Advance        the clock moves on.                                     *)
(*                                                                         *)
(* Who can press a button (the boundary that decide() itself does not      *)
(* check; it has no identity parameter):                                   *)
(*  "owner"    the owner in Telegram / Discord / WhatsApp (an identity in  *)
(*             owner.identities) or at the `vigil chat` terminal (stdin).  *)
(*  "stranger" anyone else in a chat app: isOwner() is false, dropped.     *)
(*  "http"     anyone holding the HTTP token or a signed ntfy button URL,  *)
(*             including the agent's own tools: isOwner() is true for the  *)
(*             http channel, so the only guard is allowApprovals.          *)
(* Only "owner" presses are the owner's word (ownerWord).                  *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS
    Calls,               \* tool calls that hit the gate (one pi tool_call event each, retried as new events)
    Hashes,              \* callHash(tool, args) values; two calls with the same hash are the same call
    MaxApprovals,        \* approval rows a behavior may create (bound)
    TTL,                 \* approvals.ttlMinutes, in slots
    MaxTime,             \* the clock stops here (bound)
    AllowHttpApprovals,  \* cfg.channels.http.allowApprovals (default false)
    AnyIdToConsume       \* TRUE: the gate may present any approval id to consume() (gate.ts presents
                         \* its own a.id; TRUE checks that approvals.ts alone keeps the rules)

People == {"owner", "stranger", "http"}
Ids == 1..MaxApprovals
NoRow == [status |-> "none", hash |-> CHOOSE h \in Hashes : TRUE, expiresAt |-> 0]

VARIABLES
    now,        \* Clock.now()
    ap,         \* the approvals table: id -> [status, hash, expiresAt]
    nextId,     \* next id request() hands out
    hashOf,     \* the hash of each call's tool and arguments (fixed per behavior)
    pc,         \* where each call is in the gate: idle, waiting, woken, running, refused
    myAp,       \* the approval id each call asked for (a.id)
    outcome,    \* what wait() resolved to: none, approved, denied, expired
    aborted,    \* ctx.signal fired for this call's current approval
    disposed,   \* Approvals.disposed (shutdown)
    \* ghosts
    ownerWord,  \* the owner's first press on an approval before it expired: none, approve, deny
    decidedBy,  \* who caused decide() to change the row: none or a principal
    execs       \* every run of a call: [c, a, at, consumed]

vars == <<now, ap, nextId, hashOf, pc, myAp, outcome, aborted, disposed, ownerWord, decidedBy, execs>>

Init ==
    /\ now = 0
    /\ ap = [a \in Ids |-> NoRow]
    /\ nextId = 1
    /\ hashOf \in [Calls -> Hashes]
    /\ pc = [c \in Calls |-> "idle"]
    /\ myAp = [c \in Calls |-> 0]
    /\ outcome = [c \in Calls |-> "none"]
    /\ aborted = [c \in Calls |-> FALSE]
    /\ disposed = FALSE
    /\ ownerWord = [a \in Ids |-> "none"]
    /\ decidedBy = [a \in Ids |-> "none"]
    /\ execs = {}

Existing == 1..(nextId - 1)

\* The waiter registered for approval a (wait() keeps one per id), if its call still waits.
WaiterOf(a) == {c \in Calls : pc[c] = "waiting" /\ myAp[c] = a}

\* expire(): every pending or approved row past its time becomes expired; their waiters get "expired".
ExpiredNow == {a \in Existing : ap[a].status \in {"pending", "approved"} /\ ap[a].expiresAt <= now}
ApAfterExpire == [a \in Ids |-> IF a \in ExpiredNow THEN [ap[a] EXCEPT !.status = "expired"] ELSE ap[a]]

(* gate.ts: request(), ask(), wait() up to its first await. *)
Request(c) ==
    /\ pc[c] = "idle"
    /\ nextId <= MaxApprovals
    /\ now + TTL <= MaxTime            \* bound: the timer can still fire inside the model
    /\ ap' = [ap EXCEPT ![nextId] = [status |-> "pending", hash |-> hashOf[c], expiresAt |-> now + TTL]]
    /\ nextId' = nextId + 1
    /\ myAp' = [myAp EXCEPT ![c] = nextId]
    \* wait(): the row is pending, so it registers a waiter, unless disposed: then "expired" at once
    /\ pc' = [pc EXCEPT ![c] = IF disposed THEN "woken" ELSE "waiting"]
    /\ outcome' = [outcome EXCEPT ![c] = IF disposed THEN "expired" ELSE "none"]
    /\ aborted' = [aborted EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<now, hashOf, disposed, ownerWord, decidedBy, execs>>

(* Daemon.route for a button press "approve:<id>" / "deny:<id>" from principal p. *)
Press(p, a, approve) ==
    /\ a \in Existing                  \* any button ever sent: stale ones and other calls' included
    /\ LET passesInbox == p # "stranger"                        \* isOwner(cfg, channel, senderId)
           passesHttp  == p # "http" \/ AllowHttpApprovals      \* refused over HTTP unless allowed
           \* decide(): UPDATE ... WHERE id = ? AND status = 'pending' AND expires_at > now
           changes == passesInbox /\ passesHttp
                      /\ ap[a].status = "pending"
                      /\ ap[a].expiresAt > now
           result == IF approve THEN "approved" ELSE "denied"
       IN /\ ap' = IF changes THEN [ap EXCEPT ![a].status = result] ELSE ap
          \* this.waiters.get(id)?.(outcome): the waiting gate's promise resolves
          /\ outcome' = [c \in Calls |-> IF changes /\ c \in WaiterOf(a) THEN result ELSE outcome[c]]
          /\ pc' = [c \in Calls |-> IF changes /\ c \in WaiterOf(a) THEN "woken" ELSE pc[c]]
          /\ decidedBy' = IF changes THEN [decidedBy EXCEPT ![a] = p] ELSE decidedBy
          \* ghost: what the owner said, first word only, while the request was still open
          /\ ownerWord' = IF p = "owner" /\ ownerWord[a] = "none" /\ now < ap[a].expiresAt
                            THEN [ownerWord EXCEPT ![a] = IF approve THEN "approve" ELSE "deny"]
                            ELSE ownerWord
    /\ UNCHANGED <<now, nextId, hashOf, myAp, aborted, disposed, execs>>

\* expire() as one step, waking the waiters of the rows it expired.
ExpireStep(extraWoken, extraOutcome) ==
    LET woken == {c \in Calls : pc[c] = "waiting" /\ myAp[c] \in ExpiredNow}
    IN /\ ap' = ApAfterExpire
       /\ pc' = [c \in Calls |-> IF c \in woken \/ c \in extraWoken THEN "woken" ELSE pc[c]]
       /\ outcome' = [c \in Calls |-> IF c \in woken THEN "expired"
                                      ELSE IF c \in extraWoken THEN extraOutcome[c]
                                      ELSE outcome[c]]

(* wait()'s timer, set for expires_at + 50 ms: expire(), then done(get(id).status === "approved" ...). *)
Timer(c) ==
    /\ pc[c] = "waiting"
    /\ now >= ap[myAp[c]].expiresAt
    /\ ExpireStep({c}, [x \in Calls |-> IF ApAfterExpire[myAp[x]].status = "approved" THEN "approved" ELSE "expired"])
    /\ UNCHANGED <<now, nextId, hashOf, myAp, aborted, disposed, ownerWord, decidedBy, execs>>

(* Daemon.tickGovernorAndClock, every 30 s: approvals.expire(). *)
Sweep ==
    /\ ExpiredNow # {}
    /\ ExpireStep({}, outcome)
    /\ UNCHANGED <<now, nextId, hashOf, myAp, aborted, disposed, ownerWord, decidedBy, execs>>

(* ctx.signal aborts (the turn is stopped). The listener stays attached after wait() resolved. *)
Abort(c) ==
    /\ pc[c] \in {"waiting", "woken"}
    /\ ~aborted[c]
    /\ aborted' = [aborted EXCEPT ![c] = TRUE]
    /\ ap' = IF ap[myAp[c]].status \in {"pending", "approved"}
               THEN [ap EXCEPT ![myAp[c]].status = "expired"] ELSE ap
    \* done("expired"): resolves the promise if it has not resolved yet
    /\ outcome' = IF pc[c] = "waiting" THEN [outcome EXCEPT ![c] = "expired"] ELSE outcome
    /\ pc' = [pc EXCEPT ![c] = "woken"]
    /\ UNCHANGED <<now, nextId, hashOf, myAp, disposed, ownerWord, decidedBy, execs>>

ConsumeIds(c) == IF AnyIdToConsume THEN Existing ELSE {myAp[c]}

(* gate.ts: if (outcome === "approved" && consume(a.id, callHash(tool, input))) run, else block. *)
Continue(c, a) ==
    /\ pc[c] = "woken"
    /\ a \in ConsumeIds(c)
    /\ IF outcome[c] = "approved"
         THEN LET ok == /\ ap[a].status = "approved"      \* consume(): UPDATE ... WHERE status = 'approved'
                        /\ ap[a].hash = hashOf[c]         \*   AND hash = ?
                        /\ ap[a].expiresAt > now          \*   AND expires_at > now
              IN /\ ap' = IF ok THEN [ap EXCEPT ![a].status = "consumed"] ELSE ap
                 /\ pc' = [pc EXCEPT ![c] = IF ok THEN "running" ELSE "refused"]
                 /\ execs' = IF ok THEN execs \cup {[c |-> c, a |-> a, at |-> now, consumed |-> TRUE]} ELSE execs
         ELSE /\ pc' = [pc EXCEPT ![c] = "refused"]
              /\ UNCHANGED <<ap, execs>>
    /\ UNCHANGED <<now, nextId, hashOf, myAp, outcome, aborted, disposed, ownerWord, decidedBy>>

(* Approvals.dispose(): disposed = true; every registered waiter's done("expired"). Rows unchanged. *)
Dispose ==
    /\ ~disposed
    /\ disposed' = TRUE
    /\ pc' = [c \in Calls |-> IF pc[c] = "waiting" THEN "woken" ELSE pc[c]]
    /\ outcome' = [c \in Calls |-> IF pc[c] = "waiting" THEN "expired" ELSE outcome[c]]
    /\ UNCHANGED <<now, ap, nextId, hashOf, myAp, aborted, ownerWord, decidedBy, execs>>

(* The model calls the same tool again: a new tool_call event, a new approval. *)
Retry(c) ==
    /\ pc[c] = "refused"
    /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ UNCHANGED <<now, ap, nextId, hashOf, myAp, outcome, aborted, disposed, ownerWord, decidedBy, execs>>

Advance ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ UNCHANGED <<ap, nextId, hashOf, pc, myAp, outcome, aborted, disposed, ownerWord, decidedBy, execs>>

PressAny == \E p \in People, a \in Ids, b \in BOOLEAN : Press(p, a, b)
TimerAny == \E c \in Calls : Timer(c)
AbortAny == \E c \in Calls : Abort(c)
ContinueAny == \E c \in Calls, a \in Ids : Continue(c, a)

(* The bound is reached: time stopped and no call is held by the gate. Changes nothing. *)
Done ==
    /\ now = MaxTime
    /\ \A c \in Calls : pc[c] \notin {"waiting", "woken"}
    /\ UNCHANGED vars

Next ==
    \/ Done
    \/ \E c \in Calls : Request(c)
    \/ PressAny
    \/ TimerAny
    \/ Sweep
    \/ AbortAny
    \/ ContinueAny
    \/ \E c \in Calls : Retry(c)
    \/ Dispose
    \/ Advance

\* Timers fire, the gate's continuation runs, and the clock moves on.
Fairness == WF_vars(TimerAny) /\ WF_vars(ContinueAny) /\ WF_vars(Advance)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
    /\ nextId \in 1..(MaxApprovals + 1)
    /\ pc \in [Calls -> {"idle", "waiting", "woken", "running", "refused"}]
    /\ \A a \in Ids : ap[a].status \in {"none", "pending", "approved", "denied", "expired", "consumed"}

\* NoUnapprovedExecution: a call runs only if consume() returned true for an approval with this
\* call's hash that the owner approved before it expired.
NoUnapprovedExecution ==
    \A e \in execs : e.consumed /\ ap[e.a].hash = hashOf[e.c] /\ ownerWord[e.a] = "approve"

\* SingleUse: one approval lets at most one call run, once.
SingleUse == \A a \in Ids : Cardinality({e \in execs : e.a = a}) <= 1

\* DeniedNeverRuns: when the owner's (first) word on a request was deny, nothing runs on it.
DeniedNeverRuns == \A e \in execs : ownerWord[e.a] # "deny"

\* ExpiredNeverRuns: nothing runs on an approval at or after its expiry.
ExpiredNeverRuns == \A e \in execs : e.at < ap[e.a].expiresAt

\* OwnerOnly: every decision that changed an approval came from the owner.
OwnerOnly == \A a \in Ids : decidedBy[a] \in {"none", "owner"}

\* Liveness: a call held by the gate is eventually run or blocked (the gate never hangs).
GateResolves == \A c \in Calls : (pc[c] = "waiting") ~> (pc[c] \in {"running", "refused"})
=============================================================================
