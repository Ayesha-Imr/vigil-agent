-------------------- MODULE MutNoCooldown --------------------
(* MUTANT for RetryBackoff (expect: Invariant RetryBackoff is violated).     *)
(* Breaks the W4 fix: src/agent/workers.ts pump drops                      *)
(*     if ((this.failedStart.get(t.id) ?? 0) > now - 60_000) continue;     *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.cooldown = FALSE])
=============================================================================
