#!/usr/bin/env bash
# Model-check vigil's governor and approvals specs with TLC, then run the other agents' checks.
#   bash verification/run.sh          the checks below (about 1-2 minutes on 4 cores)
#   bash verification/run.sh --deep   also the deeper configs (a few more minutes)
# Prints one line per check and exits nonzero when any required check fails.
# Results are kept in verification/out/ (tlc output per check) for reading counterexamples.
set -u
. "$(dirname "$0")/lib.sh"
JAR=$(find_jar) || exit 2
command -v java >/dev/null || { echo "java not found (Java 11 or later)"; exit 2; }
OUT="$VERIFY_DIR/out"; mkdir -p "$OUT"
deep=0; [ "${1:-}" = "--deep" ] && deep=1

# required: dir module cfg       (must pass)
REQUIRED=(
	"governor MCGovernor.tla Governor.cfg"
	"governor MCGovernor.tla Governor_three.cfg"
	"governor MCGovernor.tla Governor_live.cfg"
	"governor MCGovernor.tla Governor_concierge.cfg"
	"approvals MCApprovals.tla Approvals.cfg"
	"approvals MCApprovals.tla Approvals_live.cfg"
)
DEEP=(
	"governor MCGovernor.tla Governor_deep.cfg"
	"approvals MCApprovals.tla Approvals_deep.cfg"
)
# findings: checks of open findings that are not DESIGN.md rules or need a non-default config.
# They print FINDING while the finding is open and do not fail the run (see verification/README.md).
FINDINGS=(
	"governor MCGovernor.tla Governor_stale.cfg"
	"governor MCGovernor.tla Governor_window_gap.cfg"
	"governor MCGovernor.tla Governor_window_dedup.cfg"
	"approvals MCApprovals.tla Approvals_httpopt.cfg"
)

failed=0
check() { # kind dir module cfg
	local kind=$1 dir=$2 module=$3 cfg=$4 name out t0 v n
	name="$dir/${cfg%.cfg}"; out="$OUT/$dir-${cfg%.cfg}.out"
	t0=$(date +%s)
	run_tlc "$VERIFY_DIR/$dir" "$module" "$cfg" "$out"
	v=$(verdict "$out"); n=$(states "$out"); t=$(( $(date +%s) - t0 ))
	if [ "$v" = pass ]; then
		printf '%-8s %-34s %10s states %4ss\n' PASS "$name" "${n:-?}" "$t"
	elif [ "$kind" = finding ] && [ "${v#violated}" != "$v" ]; then
		printf '%-8s %-34s %s  (%s)\n' FINDING "$name" "$v" "${out#$VERIFY_DIR/}"
	else
		printf '%-8s %-34s %s  (%s)\n' FAIL "$name" "$v" "${out#$VERIFY_DIR/}"
		failed=1
	fi
}

echo "TLC: $JAR"
for c in "${REQUIRED[@]}"; do check required $c; done
if [ $deep = 1 ]; then for c in "${DEEP[@]}"; do check required $c; done; fi
for c in "${FINDINGS[@]}"; do check finding $c; done

# Checks other agents own: each exits nonzero on failure.
for other in outbox scheduler workers; do
	script="$VERIFY_DIR/$other/check.sh"
	[ -f "$script" ] || continue
	t0=$(date +%s)
	if bash "$script" >"$OUT/$other-check.out" 2>&1; then
		printf '%-8s %-34s %21s %4ss\n' PASS "$other/check.sh" "" "$(( $(date +%s) - t0 ))"
	else
		printf '%-8s %-34s see %s\n' FAIL "$other/check.sh" "out/$other-check.out"
		failed=1
	fi
done

[ $failed = 0 ] && echo "all required checks pass" || echo "some required checks FAIL"
exit $failed
