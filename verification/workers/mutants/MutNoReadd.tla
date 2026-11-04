-------------------- MODULE MutNoReadd --------------------
(* MUTANT for InputKeptForTwoCuts (expect: Invariant InputKeptForTwoCuts is *)
(* violated). Reverts the W3 fix: src/agent/workers.ts run() drops         *)
(*     if (!persisted && fails <= 2) for (const i of inputs) addInput(...) *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.readd = FALSE])
=============================================================================
