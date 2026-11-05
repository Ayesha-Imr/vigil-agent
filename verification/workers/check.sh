#!/usr/bin/env bash
# Model-check the worker pool and ticket inputs (Workers.tla) and prove every property can fail.
# Usage: verification/workers/check.sh [--deep]   (from anywhere; ~70-85 s on 4 cores; --deep adds ~5 min)
# Needs Java 17+ and tla2tools.jar: set TLA2TOOLS_JAR, else /home/user/tools/tla2tools.jar
# or ~/tools/tla2tools.jar. Verified with TLC 2026.11.03.180953 (rev 309e489).
# Prints one PASS/FAIL line per check and exits 1 if any result is not the expected one.
# Read a counterexample with the pstack /statechart skill (see .claude/skills/verify-worker-slots).
set -u
DEEP=${DEEP:-0}; [ "${1:-}" = "--deep" ] && DEEP=1
cd "$(dirname "$0")"
JAR=${TLA2TOOLS_JAR:-${TLA2TOOLS:-}}
for c in "$JAR" /home/user/tools/tla2tools.jar "$HOME/tools/tla2tools.jar"; do [ -n "$c" ] && [ -f "$c" ] && JAR=$c && break; done
# Else the pinned, checksummed TLC that verification/lib.sh downloads (as CI does).
if [ ! -f "$JAR" ]; then
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
  JAR=$(find_jar) || exit 2
fi
[ -f "$JAR" ] || { echo "FAIL: tla2tools.jar not found (set TLA2TOOLS_JAR)"; exit 2; }
TE=$(java -cp "$JAR" tlc2.TLC -help 2>&1 | grep -q noGenerateSpecTE && echo -noGenerateSpecTE)  # nightlies only; 1.7.4 does not write trace specs anyway
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
        ${TE:-} -metadir "$TMP/meta$i" "$tla" -config "$cfg" 2>&1)
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

section "== required: the model of the current code (expect pass) =="
check_big "Workers.cfg: slots, stop, inputs, retries (2 tickets, no crash)" Workers.tla Workers.cfg pass
check "WorkersCrash.cfg: the same with a crash (1 ticket)"               Workers.tla WorkersCrash.cfg pass
check_big "WorkersLive.cfg: OwnerNeverStarved NoInputStuck (2 tickets)"   Workers.tla WorkersLive.cfg pass
check "WorkersLiveCrash.cfg: the same with a crash (1 ticket)"           Workers.tla WorkersLiveCrash.cfg pass
check "WorkersOutage.cfg: EventLoopProgress RetryBackoff (models vanish)" Workers.tla WorkersOutage.cfg pass
if [ "$DEEP" = 1 ]; then
check_big "WorkersDeep.cfg: safety, 2 tickets + a crash (--deep)"         Workers.tla WorkersDeep.cfg pass
check_big "WorkersLiveDeep.cfg: liveness, 2 tickets, 2 inputs (--deep)"   Workers.tla WorkersLiveDeep.cfg pass
fi

section "== regressions: the old findings W1-W4, fixed in 166ea0c / 4e2683a (expect pass) =="
check "W1 StopDuringStart: /stop while the session builds"               Workers.tla regressions/StopDuringStart.cfg pass
check "W2 OwnerInputStranded: input pending at 'ready' is delivered"     Workers.tla regressions/OwnerInputStranded.cfg pass
check "W3 InputLostCutTurn: a cut turn re-queues unpersisted inputs"     Workers.tla regressions/InputLostCutTurn.cfg pass
check "W4 HotLoop: no worker model does not starve the event loop"       Workers.tla regressions/HotLoop.cfg pass

section "== open findings (expect the violation; a PASS here means 'still reproduces') =="
check "W3c CrashLosesInput: crash in a first turn loses its input"       Workers.tla findings/CrashLosesInput.cfg "inv InputNeverLostSilently"
check "suggested fix for W3c: session_file stored before the prompt"     Workers.tla findings/FixW3c.cfg pass

section "== by design (expect the violation) =="
check "the reserved slot is one slot; a 2nd owner ticket waits"          Workers.tla bydesign/SecondOwnerWaits.cfg "inv SecondOwnerNeverWaits"
check "the 3rd cut turn in a row drops its inputs (owner is told)"       Workers.tla bydesign/DroppedAfterThreeCuts.cfg "inv InputNeverLost"

section "== mutants (expect the named violation; guard demos expect pass) =="
check "MutNoRunningHas -> NoDoubleRun"                         mutants/MutNoRunningHas.tla mutants/MutNoRunningHas.cfg "inv NoDoubleRun"
check "MutAnyInputReserves -> SlotLimit"                       mutants/MutAnyInputReserves.tla mutants/MutAnyInputReserves.cfg "inv SlotLimit"
check "MutNoReservedSlot -> ReservedSlotWorks"                 mutants/MutNoReservedSlot.tla mutants/MutNoReservedSlot.cfg "inv ReservedSlotWorks"
check "MutAddInputIgnoresStop -> StoppedStaysStopped"          mutants/MutAddInputIgnoresStop.tla mutants/MutAddInputIgnoresStop.cfg "inv StoppedStaysStopped"
check "MutNoRecheck (revert W1) -> StoppedNeverRunsAgain"      mutants/MutNoRecheck.tla mutants/MutNoRecheck.cfg "inv StoppedNeverRunsAgain"
check "MutReportEnds (revert W2) -> OwnerNeverStarved"         mutants/MutReportEnds.tla mutants/MutReportEnds.cfg "temporal OwnerNeverStarved"
check "MutRunnableQueuedOnly -> NoInputStuck"                  mutants/MutRunnableQueuedOnly.tla mutants/MutRunnableQueuedOnly.cfg "temporal NoInputStuck"
check "MutNoReadd (revert W3) -> InputKeptForTwoCuts"          mutants/MutNoReadd.tla mutants/MutNoReadd.cfg "inv InputKeptForTwoCuts"
check "MutTakeAtCap -> InputKeptForTwoCuts"                    mutants/MutTakeAtCap.tla mutants/MutTakeAtCap.cfg "inv InputKeptForTwoCuts"
check "MutNoReaddCap (break 4e2683a) -> RetriesBounded"        mutants/MutNoReaddCap.tla mutants/MutNoReaddCap.cfg "inv RetriesBounded"
check "MutNoCooldown (break W4) -> RetryBackoff"               mutants/MutNoCooldown.tla mutants/MutNoCooldown.cfg "inv RetryBackoff"
check "MutRepumpAfterFailedStart (revert W4) -> EventLoopProgress" mutants/MutRepumpAfterFailedStart.tla mutants/MutRepumpAfterFailedStart.cfg "temporal EventLoopProgress"
check "MutRepumpOnly (guard demo: failedStart test alone holds it)" mutants/MutRepumpOnly.tla mutants/MutRepumpOnly.cfg pass

wait
while read -r i; do cat "$TMP/r$i"; done < "$TMP/order"
grep -q "^FAIL" "$TMP"/r* && bad=1
[ $bad = 0 ] && echo "ALL AS EXPECTED" || echo "UNEXPECTED RESULTS (see FAIL lines)"
exit $bad
