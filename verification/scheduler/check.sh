#!/usr/bin/env bash
# Model-check the job scheduler (Scheduler.tla) and prove every property can fail.
# Usage: verification/scheduler/check.sh        (from anywhere; ~10 s on 4 cores)
# Needs Java 17+ and tla2tools.jar: set TLA2TOOLS_JAR, else /home/user/tools/tla2tools.jar
# or ~/tools/tla2tools.jar. Verified with TLC 2026.11.03.180953 (rev 309e489).
# Prints one PASS/FAIL line per check and exits 1 if any result is not the expected one.
# Read a counterexample with the pstack /statechart skill (see .claude/skills/verify-scheduler).
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
check "Scheduler.cfg: OneTriggerPerSlot NoOverlap AtJobsFireOnce (2 crashes)" Scheduler.tla Scheduler.cfg pass
check "SchedulerLive.cfg: + ClaimedRunCompletes AtJobRuns (no crash)"     Scheduler.tla SchedulerLive.cfg pass

section "== findings in the current code (expect the violation; a PASS here means 'still reproduces') =="
check "S1 LostSlotAtNow: slot at the claim instant not counted"          Scheduler.tla findings/LostSlotAtNow.cfg "inv NoLostSlot"
check "S2 StaleComplete: old run's complete() frees the re-claimed job"  Scheduler.tla findings/StaleComplete.cfg "inv OverlapOnlyAfterLease"
check "S3 CrashDropsRun: claimed run cut by a crash never runs"          Scheduler.tla findings/CrashDropsRun.cfg "temporal AtJobRuns"
check "by design: a run past RUN_LEASE_MS overlaps the next"             Scheduler.tla findings/LeaseOverlap.cfg "inv NoOverlap"

section "== fix variants (expect pass) =="
check "fix S1: countSlots breaks on next > to"                           fixes/FixCountSlots.tla fixes/FixCountSlots.cfg pass
check "fix S2: complete() WHERE running_since = claimedAt"               fixes/FixStaleComplete.tla fixes/FixStaleComplete.cfg pass
check "fix S3: start() re-runs the newest 'received' clock trigger"      fixes/FixReplayClockTriggers.tla fixes/FixReplayClockTriggers.cfg pass

section "== mutants (expect the named violation) =="
check "MutOneTrigger -> OneTriggerPerSlot"                               mutants/MutOneTrigger.tla mutants/MutOneTrigger.cfg "inv OneTriggerPerSlot"
check "MutRewindOnly (guard demo: UNIQUE key alone holds it)"            mutants/MutRewindOnly.tla mutants/MutRewindOnly.cfg pass
check "MutNoUniqueOnly (guard demo: next_run_at alone holds it)"         mutants/MutNoUniqueOnly.tla mutants/MutNoUniqueOnly.cfg pass
check "MutNoLeaseCheck -> NoOverlap"                                     mutants/MutNoLeaseCheck.tla mutants/MutNoLeaseCheck.cfg "inv NoOverlap"
check "MutOverlapOnFix -> OverlapOnlyAfterLease"                         mutants/MutOverlapOnFix.tla mutants/MutOverlapOnFix.cfg "inv OverlapOnlyAfterLease"
check "MutNextFromSlot -> NoLostSlot"                                    mutants/MutNextFromSlot.tla mutants/MutNextFromSlot.cfg "inv NoLostSlot"
check "MutAtTwice -> AtJobsFireOnce"                                     mutants/MutAtTwice.tla mutants/MutAtTwice.cfg "inv AtJobsFireOnce"
check "MutDropDone -> AtJobRuns"                                         mutants/MutDropDone.tla mutants/MutDropDone.cfg "temporal AtJobRuns"

wait
while read -r i; do cat "$TMP/r$i"; done < "$TMP/order"
grep -q "^FAIL" "$TMP"/r* && bad=1
[ $bad = 0 ] && echo "ALL AS EXPECTED" || echo "UNEXPECTED RESULTS (see FAIL lines)"
exit $bad
