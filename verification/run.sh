#!/usr/bin/env bash
# Model-check vigil's attention governor and approvals with TLC, then run the checks other
# agents own (verification/{outbox,scheduler,workers}/check.sh).
#
#   bash verification/run.sh            required configs, modeled fixes, findings (about 2 min on 4 cores)
#   bash verification/run.sh --deep     also the deeper configs (a few more minutes)
#   bash verification/run.sh --strict   also exit nonzero while any finding is open
#   bash verification/run.sh --only governor   one spec (governor or approvals), no other agents' checks
#
# One line per check:
#   PASS     a required config or a modeled fix (fixes/*.cfg): every rule in it holds.
#   FAIL     a required config or a modeled fix broke a rule, or TLC stopped with an error.
#   FINDING  a findings/*.cfg reproduced the rule violation it names (an open finding, see README.md).
#   FIXED?   a findings/*.cfg no longer breaks its rule: the code or the model changed. Read the
#            verify skill and decide whether the finding is fixed (move it) or the model drifted.
# Then one summary line per spec. Exit code: 0 when every required check passes and every finding
# reproduces as recorded; 1 otherwise (and, with --strict, also while a finding is open).
# TLC's full output for every check is kept in verification/out/ for reading counterexamples.
set -u
. "$(dirname "$0")/lib.sh"
command -v java >/dev/null || { echo "java not found (Java 11 or later is needed)"; exit 2; }
JAR=$(find_jar) || exit 2
# The other agents' check.sh scripts read the same jar.
export TLA2TOOLS="$JAR" TLA2TOOLS_JAR="$JAR"
OUT="$VERIFY_DIR/out"; mkdir -p "$OUT"
deep=0; strict=0; only=""
while [ $# -gt 0 ]; do
	case $1 in
		--deep) deep=1 ;;
		--strict) strict=1 ;;
		--only) only=${2:-}; shift ;;
		*) echo "unknown option $1"; exit 2 ;;
	esac
	shift
done
SPECS=(governor approvals); [ -n "$only" ] && SPECS=("$only")

# spec  module  config   (each must pass)
REQUIRED=(
	"governor MCGovernor.tla Governor.cfg"
	"governor MCGovernor.tla Governor_three.cfg"
	"governor MCGovernor.tla Governor_live.cfg"
	"governor MCGovernor.tla Governor_concierge.cfg"
	"governor MCGovernor.tla Governor_concierge_mute.cfg"
	"governor MCGovernor.tla Governor_live_concierge.cfg"
	"governor MCGovernor.tla Governor_long_expiry.cfg"
	"approvals MCApprovals.tla Approvals.cfg"
	"approvals MCApprovals.tla Approvals_shutdown.cfg"
	"approvals MCApprovals.tla Approvals_live.cfg"
)
DEEP=(
	"governor MCGovernor.tla Governor_deep.cfg"
	"governor MCGovernor.tla Governor_concierge_feedback.cfg"
	"approvals MCApprovals.tla Approvals_deep.cfg"
)
[ $deep = 1 ] && REQUIRED+=("${DEEP[@]}")

failed=0; open=0
declare -A specfail specopen
line() { printf '%-8s %-44s %s\n' "$1" "$2" "$3"; }

for c in "${REQUIRED[@]}"; do
	set -- $c; spec=$1 module=$2 cfg=$3
	[ -n "$only" ] && [ "$spec" != "$only" ] && continue
	name="$spec/${cfg%.cfg}"; out="$OUT/${name//\//-}.out"; t0=$(date +%s)
	run_tlc "$VERIFY_DIR/$spec" "$module" "$cfg" "$out"
	v=$(verdict "$out"); t=$(( $(date +%s) - t0 ))
	if [ "$v" = pass ]; then line PASS "$name" "$(states "$out") states, ${t}s"
	else line FAIL "$name" "$v  (${out#"$VERIFY_DIR"/})"; failed=1; specfail[$spec]=1; fi
done

for spec in "${SPECS[@]}"; do
	module=MCGovernor.tla; [ $spec = approvals ] && module=MCApprovals.tla
	for f in "$VERIFY_DIR/$spec"/findings/*.cfg; do
		[ -f "$f" ] || continue
		cfg=findings/$(basename "$f"); name="$spec/${cfg%.cfg}"; out="$OUT/${name//\//-}.out"
		expect=$(sed -n 's/^\\\* expect: //p' "$f" | head -1)
		run_tlc "$VERIFY_DIR/$spec" "$module" "$cfg" "$out"
		v=$(verdict "$out")
		case "$v" in
			"violated: Invariant $expect is violated."|"violated: Action property $expect is violated."|"violated: Temporal properties were violated."|"violated: Temporal property $expect was violated.")
				line FINDING "$name" "$expect breaks  (${out#"$VERIFY_DIR"/})"; open=$((open + 1)); specopen[$spec]=$(( ${specopen[$spec]:-0} + 1 )) ;;
			pass) line 'FIXED?' "$name" "$expect now holds: update the verify skill (see its 'When a finding stops reproducing')"; failed=1; specfail[$spec]=1 ;;
			*) line FAIL "$name" "$v  (${out#"$VERIFY_DIR"/})"; failed=1; specfail[$spec]=1 ;;
		esac
	done
done

# Checks other agents own: each exits nonzero on failure.
for other in outbox scheduler workers; do
	[ -n "$only" ] && continue
	script="$VERIFY_DIR/$other/check.sh"
	[ -f "$script" ] || continue
	t0=$(date +%s)
	if bash "$script" >"$OUT/$other-check.out" 2>&1; then line PASS "$other/check.sh" "$(( $(date +%s) - t0 ))s"
	else line FAIL "$other/check.sh" "see out/$other-check.out"; failed=1; specfail[$other]=1; fi
done

echo
for spec in "${SPECS[@]}"; do
	if [ -n "${specfail[$spec]:-}" ]; then echo "$spec: FAIL"
	else echo "$spec: PASS (${specopen[$spec]:-0} open findings reproduce as recorded)"; fi
done
[ $strict = 1 ] && [ $open -gt 0 ] && failed=1
exit $failed
