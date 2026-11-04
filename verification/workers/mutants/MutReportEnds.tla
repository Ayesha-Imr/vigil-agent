-------------------- MODULE MutReportEnds --------------------
(* MUTANT for OwnerNeverStarved (expect: Temporal property                  *)
(* OwnerNeverStarved was violated). Reverts the W2 fix: src/core/tickets.ts*)
(* report:  const ends = (kind === "ready" || kind === "dropped") &&       *)
(*          !this.hasPendingInputs(id);   ->   ... (no pending test)       *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.reportKeepsOpen = FALSE])
=============================================================================
