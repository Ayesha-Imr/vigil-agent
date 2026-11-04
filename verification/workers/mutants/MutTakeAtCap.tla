-------------------- MODULE MutTakeAtCap --------------------
(* MUTANT for NoInputLost (expect: Invariant InputNeverLost is violated).   *)
(* The current code already breaks it (finding W3), so this starts from    *)
(* Workers!Fixed and makes one change in src/agent/workers.ts run():       *)
(*     for (let turn = 0; turn < 20; turn++) { const inputs = takeInputs ...*)
(* becomes                                                                 *)
(*     for (let turn = 0; ; turn++) { const inputs = takeInputs(t.id);     *)
(*       if (turn >= 20) break; ...                                        *)
(* Inputs taken at the cap are marked delivered and never prompted.        *)
EXTENDS Workers

SpecM == SpecWith([Fixed EXCEPT !.takeAtCap = TRUE])
=============================================================================
