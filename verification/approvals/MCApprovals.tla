---------------------------- MODULE MCApprovals ----------------------------
EXTENDS Approvals, TLC
\* Calls and hashes are opaque names: renaming them changes nothing. Safety runs only (symmetry
\* can hide a liveness violation, so Approvals_live.cfg does not use it).
Symmetry == Permutations(Calls) \cup Permutations(Hashes)
=============================================================================
