#!/usr/bin/env bash
# Model-check the job scheduler (Scheduler.tla) and prove every property can fail.
# Usage: verification/scheduler/check.sh [--deep]   (from anywhere; ~45-60 s on 4 cores; --deep adds ~2 min)
# Needs Java 17+ and tla2tools.jar: set TLA2TOOLS_JAR, else /home/user/tools/tla2tools.jar
# or ~/tools/tla2tools.jar. Verified with TLC 2026.11.03.180953 (rev 309e489).
# Prints one PASS/FAIL line per check and exits 1 if any result is not the expected one.
# Read a counterexample with the pstack /statechart skill (see .claude/skills/verify-scheduler).
set -u
DEEP=${DEEP:-0}; [ "${1:-}" = "--deep" ] && DEEP=1
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

section "== required: the model of the current code (expect pass) =="
check "Scheduler.cfg: OneTriggerPerSlot NoOverlap NoLostSlot AtJobsFireOnce (2 crashes)" Scheduler.tla Scheduler.cfg pass
check "SchedulerLive.cfg: ClaimedRunCompletes AtJobRuns (1 crash)"         Scheduler.tla SchedulerLive.cfg pass
check "SchedulerLease.cfg: OverlapOnlyAfterLease (runs may outlive lease)" Scheduler.tla SchedulerLease.cfg pass
if [ "$DEEP" = 1 ]; then
check_big "SchedulerDeep.cfg: safety, clock 0..18, 3 crashes (--deep)"    Scheduler.tla SchedulerDeep.cfg pass
fi

section "== regressions: the old findings S1-S3, fixed in 166ea0c (expect pass) =="
check "S1 LostSlotAtNow: slot at the claim instant is counted"           Scheduler.tla regressions/LostSlotAtNow.cfg pass
check "S2 StaleComplete: an old run's complete() keeps the newer claim"  Scheduler.tla regressions/StaleComplete.cfg pass
check "S3 CrashDropsRun: a claimed run cut by a crash runs after restart" Scheduler.tla regressions/CrashDropsRun.cfg pass

section "== by design (expect the violation) =="
check "a run past RUN_LEASE_MS overlaps the next claim"                  Scheduler.tla bydesign/LeaseOverlap.cfg "inv NoOverlap"
check "down longer than unfinishedRuns' maxAge: the claimed run is lost" Scheduler.tla bydesign/ReplayWindow.cfg "temporal AtJobRuns"

section "== mutants (expect the named violation; guard demos expect pass) =="
check "MutOneTrigger -> OneTriggerPerSlot"                               mutants/MutOneTrigger.tla mutants/MutOneTrigger.cfg "inv OneTriggerPerSlot"
check "MutRewindOnly (guard demo: UNIQUE key alone holds it)"            mutants/MutRewindOnly.tla mutants/MutRewindOnly.cfg pass
check "MutNoUniqueOnly (guard demo: next_run_at alone holds it)"         mutants/MutNoUniqueOnly.tla mutants/MutNoUniqueOnly.cfg pass
check "MutNoLeaseCheck -> NoOverlap"                                     mutants/MutNoLeaseCheck.tla mutants/MutNoLeaseCheck.cfg "inv NoOverlap"
check "MutReplayNoHold (S3 rerun holds no job) -> NoOverlap"             mutants/MutReplayNoHold.tla mutants/MutReplayNoHold.cfg "inv NoOverlap"
check "MutCompleteById (revert S2) -> OverlapOnlyAfterLease"             mutants/MutCompleteById.tla mutants/MutCompleteById.cfg "inv OverlapOnlyAfterLease"
check "MutCountGe (revert S1) -> NoLostSlot"                             mutants/MutCountGe.tla mutants/MutCountGe.cfg "inv NoLostSlot"
check "MutNextFromSlot -> NoLostSlot"                                    mutants/MutNextFromSlot.tla mutants/MutNextFromSlot.cfg "inv NoLostSlot"
check "MutAtTwice -> AtJobsFireOnce"                                     mutants/MutAtTwice.tla mutants/MutAtTwice.cfg "inv AtJobsFireOnce"
check "MutDropDone (concierge catch drops done) -> AtJobRuns"            mutants/MutDropDone.tla mutants/MutDropDone.cfg "temporal AtJobRuns"
check "MutNoReplay (revert S3) -> AtJobRuns"                             mutants/MutNoReplay.tla mutants/MutNoReplay.cfg "temporal AtJobRuns"

wait
while read -r i; do cat "$TMP/r$i"; done < "$TMP/order"
grep -q "^FAIL" "$TMP"/r* && bad=1
[ $bad = 0 ] && echo "ALL AS EXPECTED" || echo "UNEXPECTED RESULTS (see FAIL lines)"
exit $bad
