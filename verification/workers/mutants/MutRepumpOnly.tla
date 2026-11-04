-------------------- MODULE MutRepumpOnly --------------------
(* GUARD DEMO for EventLoopProgress (expect: no error). Only the first half *)
(* of MutRepumpAfterFailedStart (always re-pump): the failedStart test in  *)
(* pump alone still keeps the loop from spinning.                          *)
EXTENDS Workers

SpecM == SpecWith([Base EXCEPT !.pumpAfterFailedStart = TRUE])
=============================================================================
