-------------------- MODULE MutNoRecheck --------------------
(* MUTANT for StoppedNeverRunsAgain (expect: Invariant                      *)
(* StoppedNeverRunsAgain is violated). Reverts the W1 fix: src/agent/      *)
(* workers.ts run() drops the re-read after `await this.session(t0)`:      *)
(*     const t = this.s.tickets.get(t0.id);                                *)
(*     if (!t || t.stopped_by_owner || t.status === "ended") return true;  *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.recheckAfterSession = FALSE])
=============================================================================
