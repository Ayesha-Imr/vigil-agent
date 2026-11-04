---------------------------- MODULE MCGovernor ----------------------------
(* Concrete constants for checking Governor.tla. One slot = 8 hours, D = 3 slots a day:      *)
(* slot 0 = 00-08 (night), 1 = 08-16, 2 = 16-24 (local time).                                *)
EXTENDS Governor, TLC

\* Topics and dedup keys are opaque names: renaming them changes nothing. Safety runs only
\* (symmetry can hide a liveness violation, so the liveness config does not use it).
Symmetry == Permutations(Topics) \cup Permutations(Keys)

\* GovernorPolicy records. hasQuiet = FALSE is quietHours: null; qStart/qEnd are the quiet window
\* [start, end) in slots of the day; digest is digestTimes; every duration is in slots.
MCPolicies == {
    \* Like DEFAULT_POLICY: quiet at night, a digest in the evening, a tight budget.
    [hasQuiet |-> TRUE, qStart |-> 0, qEnd |-> 1, digest |-> {2},
     maxInt |-> 1, minGap |-> 1, critCap |-> 1, dedup |-> 2, expiry |-> 2],
    \* quietHours: null, digestTimes: [] : waiting notices leave only by reply, mute or expiry.
    [hasQuiet |-> FALSE, qStart |-> 0, qEnd |-> 0, digest |-> {},
     maxInt |-> 2, minGap |-> 0, critCap |-> 1, dedup |-> 1, expiry |-> 2],
    \* Quiet window that wraps midnight (16-08), a digest time inside quiet hours (slot 0, which
    \* tick() must skip) and one when quiet hours end (slot 1), criticalPerDay = 0.
    [hasQuiet |-> TRUE, qStart |-> 2, qEnd |-> 1, digest |-> {0, 1},
     maxInt |-> 2, minGap |-> 1, critCap |-> 0, dedup |-> 2, expiry |-> 2]
}

\* For Governor_windows.cfg only: windows longer than what tick() keeps. The config there sets
\* HistorySlots = 1 as a stand-in for HISTORY_MS (7 days), so dedup = 3 > HistorySlots plays a
\* dedupWindowMinutes above 7 days, and minGap = 4 > D plays a minGapMinutes above 24 hours.
\* src/config.ts validate() accepts both.
MCLongWindowPolicies == {
    [hasQuiet |-> FALSE, qStart |-> 0, qEnd |-> 0, digest |-> {},
     maxInt |-> 2, minGap |-> 4, critCap |-> 1, dedup |-> 3, expiry |-> 1]
}
=============================================================================
