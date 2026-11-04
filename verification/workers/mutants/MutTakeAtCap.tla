-------------------- MODULE MutTakeAtCap --------------------
(* MUTANT for InputKeptForTwoCuts (expect: Invariant InputKeptForTwoCuts is *)
(* violated). Code change in src/agent/workers.ts run():                   *)
(*     for (let turn = 0; turn < 20; turn++) { const inputs = takeInputs...*)
(*  -> for (let turn = 0; ; turn++) { const inputs = takeInputs(t.id);     *)
(*       if (turn >= 20) break; ...                                        *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.takeAtCap = TRUE])
=============================================================================
