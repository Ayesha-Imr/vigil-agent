#!/usr/bin/env bash
# Model-check the worker pool and ticket inputs (Workers.tla) and prove every property can fail.
# Usage: verification/workers/check.sh        (from anywhere; ~45 s on 4 cores)
# Needs Java 17+ and tla2tools.jar: set TLA2TOOLS_JAR, else /home/user/tools/tla2tools.jar
# or ~/tools/tla2tools.jar. Verified with TLC 2026.11.03.180953 (rev 309e489).
# Prints one PASS/FAIL line per check and exits 1 if any result is not the expected one.
# Read a counterexample with the pstack /statechart skill (see .claude/skills/verify-worker-slots).
set -u
cd "$(dirname "$0")"
JAR=${TLA2TOOLS_JAR:-}
for c in "$JAR" /home/user/tools/tla2tools.jar "$HOME/tools/tla2tools.jar"; do [ -n "$c" ] && [ -f "$c" ] && JAR=$c && break; done
[ -f "$JAR" ] || { echo "FAIL: tla2tools.jar not found (set TLA2TOOLS_JAR)"; exit 2; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
bad=0
JOBS=${JOBS:-$(nproc 2>/dev/null || echo 2)}
n=0

# check LABEL MODULE CFG EXPECT [SPEC]
#   EXPECT: pass | "inv NAME" (Invariant NAME is violated) | "temporal NAME" (Temporal property NAME was violated)
#   SPEC:   replace the cfg's SPECIFICATION (for fix variants defined inside the module)
# Checks run in parallel (JOBS at a time, one TLC worker each); check_big runs alone on all
# cores. Results print in the order of this file.
run_one() {
  local i=$1 w=$2 label=$3 tla=$4 cfg=$5 expect=$6 spec=${7:-}
  if [ -n "$spec" ]; then sed "s/^SPECIFICATION .*/SPECIFICATION $spec/" "$cfg" > "$TMP/c$i.cfg"; cfg=$TMP/c$i.cfg; fi
  local out got states
  out=$(java -XX:+UseParallelGC -DTLA-Library="$PWD" -cp "$JAR" tlc2.TLC -workers "$w" -cleanup \
        -noGenerateSpecTE -metadir "$TMP/meta$i" "$tla" -config "$cfg" 2>&1)
  if grep -q "No error has been found" <<<"$out"; then got=pass
  elif v=$(grep -oE "Invariant [A-Za-z0-9_]+ is violated" <<<"$out" | head -1) && [ -n "$v" ]; then got="inv $(awk '{print $2}' <<<"$v")"
  elif v=$(grep -oE "Temporal property [A-Za-z0-9_]+ was violated" <<<"$out" | head -1) && [ -n "$v" ]; then got="temporal $(awk '{print $3}' <<<"$v")"
  else got="error: $(grep -m1 -E 'Error|error' <<<"$out")"; fi
  states=$(grep -oE "[0-9]+ distinct states found" <<<"$out" | tail -1)
  if [ "$got" = "$expect" ]; then echo "PASS  $label  ($expect; $states)" > "$TMP/r$i"
  else echo "FAIL  $label  expected [$expect] got [$got]" > "$TMP/r$i"; fi
}
check() {
  n=$((n + 1))
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n 2>/dev/null || sleep 0.2; done
  run_one "$n" 1 "$@" &
  echo "$n" >> "$TMP/order"
}
# A large model: run it alone, with every core, before the parallel batch.
check_big() { n=$((n + 1)); run_one "$n" auto "$@"; echo "$n" >> "$TMP/order"; }
section() { n=$((n + 1)); echo "$1" > "$TMP/r$n"; echo "$n" >> "$TMP/order"; }

section "== model of the current code (expect pass) =="
check_big "Workers.cfg: NoDoubleRun SlotLimit ReservedSlotWorks StoppedRejectsInputs" Workers.tla Workers.cfg pass

section "== findings in the current code (expect the violation; a PASS here means 'still reproduces') =="
check "W1 StopDuringStart: /stop while the session builds, mandate still starts" Workers.tla findings/StopDuringStart.cfg "inv StoppedNeverRunsAgain"
check "W2 OwnerInputStranded: input pending at 'ready' never delivered"          Workers.tla findings/OwnerInputStranded.cfg "temporal OwnerNeverStarved"
check "W3 InputLost: cut first turn, next run has a new session"                 Workers.tla findings/InputLost.cfg "inv InputNeverLost"
check "W4 HotLoop: no worker model -> run/fail/pump microtask loop"              Workers.tla findings/HotLoop.cfg "temporal EventLoopProgress"
check "by design: the reserved slot is one slot; a 2nd owner ticket waits"      Workers.tla findings/SecondOwnerWaits.cfg "inv SecondOwnerNeverWaits"

section "== fix variants (expect pass) =="
check "fix W1 alone: run() re-reads the ticket after await session"   Workers.tla findings/StopDuringStart.cfg pass SpecFixW1
check "fix W3 alone: session_file stored before the first prompt"     Workers.tla findings/InputLost.cfg pass SpecFixW3
check "fix W4 alone: no re-pump after a failed session start"         Workers.tla findings/HotLoop.cfg pass SpecFixW4
check_big "all fixes: every property incl. OwnerNeverStarved NoInputLost" Workers.tla fixes/FixAll.cfg pass

section "== mutants (expect the named violation) =="
check "MutNoRunningHas -> NoDoubleRun"                     mutants/MutNoRunningHas.tla mutants/MutNoRunningHas.cfg "inv NoDoubleRun"
check "MutAnyInputReserves -> SlotLimit"                   mutants/MutAnyInputReserves.tla mutants/MutAnyInputReserves.cfg "inv SlotLimit"
check "MutNoReservedSlot -> ReservedSlotWorks"             mutants/MutNoReservedSlot.tla mutants/MutNoReservedSlot.cfg "inv ReservedSlotWorks"
check "MutAddInputIgnoresStop -> StoppedRejectsInputs"     mutants/MutAddInputIgnoresStop.tla mutants/MutAddInputIgnoresStop.cfg "inv StoppedRejectsInputs"
check "MutStopIgnoredOnFix -> StoppedNeverRunsAgain"       mutants/MutStopIgnoredOnFix.tla mutants/MutStopIgnoredOnFix.cfg "inv StoppedNeverRunsAgain"
check "MutRunnableQueuedOnly -> OwnerNeverStarved"         mutants/MutRunnableQueuedOnly.tla mutants/MutRunnableQueuedOnly.cfg "temporal OwnerNeverStarved"
check "MutTakeAtCap -> NoInputLost (InputNeverLost)"       mutants/MutTakeAtCap.tla mutants/MutTakeAtCap.cfg "inv InputNeverLost"
check "MutRepumpAfterFailedStart -> EventLoopProgress"     mutants/MutRepumpAfterFailedStart.tla mutants/MutRepumpAfterFailedStart.cfg "temporal EventLoopProgress"

wait
while read -r i; do cat "$TMP/r$i"; done < "$TMP/order"
grep -q "^FAIL" "$TMP"/r* && bad=1
[ $bad = 0 ] && echo "ALL AS EXPECTED" || echo "UNEXPECTED RESULTS (see FAIL lines)"
exit $bad
