#!/usr/bin/env bash
# Model-check vigil's outbox (src/core/outbox.ts). One command:
#   bash verification/outbox/check.sh          # ~1-2 min
#   bash verification/outbox/check.sh --deep   # adds three larger runs, a few min more
# Needs Java 11+ and tla2tools.jar (TLC). Set TLA2TOOLS to its path if it is not at the default.
# Every line is PASS or FAIL. The current code passes the properties; each mutant must fail its
# own property; each finding and characterization must still show its violation. Exit 1 on any
# unexpected result.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAR="${TLA2TOOLS:-/home/user/tools/tla2tools.jar}"
# Else the pinned, checksummed TLC that verification/lib.sh downloads (as CI does).
if [ ! -f "$JAR" ]; then
	. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
	JAR=$(find_jar) || exit 1
fi
[ -f "$JAR" ] || { echo "FAIL tla2tools.jar not found at $JAR (set TLA2TOOLS)"; exit 1; }
TE=$(java -cp "$JAR" tlc2.TLC -help 2>&1 | grep -q noGenerateSpecTE && echo -noGenerateSpecTE)  # nightlies only; 1.7.4 does not write trace specs anyway
command -v java >/dev/null || { echo "FAIL java not on PATH"; exit 1; }
META="$(mktemp -d)"; trap 'rm -rf "$META"' EXIT
bad=0

# Each TLC run stops after OUTBOX_TLC_TIMEOUT seconds (default 300) and counts as FAIL: a model
# change that makes the state space explode should be seen, not waited for.
LIMIT=()
command -v timeout >/dev/null && LIMIT=(timeout "${OUTBOX_TLC_TIMEOUT:-300}")
tlc() { # spec-dir spec cfg -> TLC output
	( cd "$1" && "${LIMIT[@]}" java -XX:+UseParallelGC -DTLA-Library="$DIR" -cp "$JAR" tlc2.TLC -workers auto -cleanup \
		${TE:-} -metadir "$META/$(basename "$3" .cfg)" -config "$3" "$2" 2>&1 )
}
states() { grep -Eo '[0-9,]+ distinct states found' <<<"$1" | tail -1 | cut -d' ' -f1; }

expect_pass() { # label spec-dir spec cfg
	local out; out="$(tlc "$2" "$3" "$4")"
	if grep -q "Model checking completed. No error has been found." <<<"$out"; then
		echo "PASS $1: no error ($(states "$out") distinct states)"
	else
		bad=1; echo "FAIL $1: expected no error"
		grep -q "Finished in\|Error" <<<"$out" || echo "     (no TLC result: timed out after ${OUTBOX_TLC_TIMEOUT:-300} s or crashed)"
		grep -E "^Error|violated|Exception" <<<"$out" | head -5 | sed 's/^/     /'
	fi
}
expect_violation() { # label spec-dir spec cfg property
	local out; out="$(tlc "$2" "$3" "$4")"
	if grep -Eq "(Invariant $5 is violated|Temporal property $5 was violated)" <<<"$out"; then
		echo "PASS $1: $5 violated, as expected"
	else
		bad=1; echo "FAIL $1: expected $5 to be violated"
		grep -q "Finished in\|Error" <<<"$out" || echo "     (no TLC result: timed out after ${OUTBOX_TLC_TIMEOUT:-300} s or crashed)"
		grep -E "^Error|violated|No error|Exception" <<<"$out" | head -5 | sed 's/^/     /'
	fi
}

if [ "${1:-}" = "--trace" ]; then
	# Print the counterexample of one config, one worker so the trace is the same every run.
	# Usage: check.sh --trace findings/TicketQuestionOutOfOrder.cfg  (or a mutants/*.cfg)
	cfg="$(cd "$DIR" && realpath "${2:?give a .cfg path relative to verification/outbox}")"
	spec="$DIR/Outbox.tla"; [ "$(basename "$(dirname "$cfg")")" = mutants ] && spec="${cfg%.cfg}.tla"
	( cd "$(dirname "$spec")" && java -XX:+UseParallelGC -DTLA-Library="$DIR" -cp "$JAR" tlc2.TLC -workers 1 \
		-cleanup ${TE:-} -metadir "$META/trace" -config "$cfg" "$(basename "$spec")" 2>&1 ) |
		sed -n '/is violated\|was violated/,/states generated/p' |
		awk '/^(\/\\ |State [0-9]+|Error|Back to state|[0-9]+ states generated)/ { if (buf != "") print buf; buf = $0; next }
		     { sub(/^ +/, " "); buf = buf $0 } END { if (buf != "") print buf }' |
		grep -E '^(Error|State [0-9]+|Back to state)|^/\\ (status|attempts|due|okey|ext|refs|up|chanUp|log|pass|orphans|proc|lock|fresh) ' |
		sed -E -e 's/ line [0-9]+, col [0-9]+ to line [0-9]+, col [0-9]+ of module [A-Za-z]+//' \
			-e 's/(ord|split|splitBA|gap|tkt) \|-> (TRUE|FALSE),? ?//g' -e 's/fl \|-> \[ *\]/fl/g' \
			-e 's/todo \|-> <<>>, //g' -e 's/ +/ /g'
	exit 0
fi

echo "== current code (src/core/outbox.ts, services.ts, sessions.ts, daemon.ts lock)"
expect_pass "safety  Outbox.cfg        " "$DIR" Outbox.tla Outbox.cfg
expect_pass "liveness OutboxLive.cfg   " "$DIR" Outbox.tla OutboxLive.cfg
expect_pass "fixed   TwoDaemonsLocked  " "$DIR" Outbox.tla fixed/TwoDaemonsLocked.cfg
expect_pass "fixed   ApprovalAskInOrder" "$DIR" Outbox.tla fixed/ApprovalAskInOrder.cfg
if [ "${1:-}" = "--deep" ]; then
	expect_pass "safety  OutboxDeep.cfg     " "$DIR" Outbox.tla OutboxDeep.cfg
	expect_pass "safety  OutboxDeepRows.cfg " "$DIR" Outbox.tla OutboxDeepRows.cfg
	expect_pass "liveness OutboxLiveDeep.cfg" "$DIR" Outbox.tla OutboxLiveDeep.cfg
fi

echo "== mutants (each must break its property; see the header of each .tla)"
M="$DIR/mutants"
expect_violation "mutant MutHeldBackDueOnly   " "$M" MutHeldBackDueOnly.tla MutHeldBackDueOnly.cfg OrderPreserved
expect_violation "mutant MutNoSplitKey        " "$M" MutNoSplitKey.tla MutNoSplitKey.cfg SplitPartsInOrder
expect_violation "mutant MutQuestionNoTicketId" "$M" MutQuestionNoTicketId.tla MutQuestionNoTicketId.cfg TicketMessagesInOrder
expect_violation "mutant MutApprovalNoKey     " "$M" MutApprovalNoKey.tla MutApprovalNoKey.cfg TicketMessagesInOrder
expect_violation "mutant MutNoRunningGuard    " "$M" MutNoRunningGuard.tla MutNoRunningGuard.cfg AtMostOnceWithoutCrashOrTimeout
expect_violation "mutant MutNoLock            " "$M" MutNoLock.tla MutNoLock.cfg AtMostOnceWithoutCrashOrTimeout
expect_violation "mutant MutLockNoTx          " "$M" MutLockNoTx.tla MutLockNoTx.cfg AtMostOnceWithoutCrashOrTimeout
expect_violation "mutant MutRefOutsideTx      " "$M" MutRefOutsideTx.tla MutRefOutsideTx.cfg RefRecorded
expect_violation "mutant MutPendingOnly       " "$M" MutPendingOnly.tla MutPendingOnly.cfg NoLoss
expect_violation "mutant MutNoSendTimeout     " "$M" MutNoSendTimeout.tla MutNoSendTimeout.cfg NoLoss

echo "== open findings (bugs in the current code; PASS = still reproduced)"
F="$DIR/findings"
expect_violation "finding HelperApprovalOutOfOrder" "$DIR" Outbox.tla "$F/HelperApprovalOutOfOrder.cfg" TicketMessagesInOrder
expect_violation "finding NoProcStaleTakeover     " "$DIR" Outbox.tla "$F/NoProcStaleTakeover.cfg" AtMostOnceWithoutCrashOrTimeout

echo "== characterizations (behavior by design, stated plainly; PASS = still behaves so)"
C="$DIR/characterizations"
expect_violation "characterization SplitOvertakesBlockedPart" "$DIR" Outbox.tla "$C/SplitOvertakesBlockedPart.cfg" SplitPartsWaitForBlockedPart
expect_violation "characterization SplitGapAfterDrop        " "$DIR" Outbox.tla "$C/SplitGapAfterDrop.cfg" SplitPartsNoGap
expect_violation "characterization CrashResends             " "$DIR" Outbox.tla "$C/CrashResends.cfg" NoDuplicates
expect_violation "characterization CrashCopyUnroutable      " "$DIR" Outbox.tla "$C/CrashCopyUnroutable.cfg" EveryCopyRoutable
expect_violation "characterization TimeoutResends           " "$DIR" Outbox.tla "$C/TimeoutResends.cfg" AtMostOnceWithoutCrash
expect_violation "characterization ErrorAfterDeliveryResends" "$DIR" Outbox.tla "$C/ErrorAfterDeliveryResends.cfg" AtMostOnceWithoutCrashOrTimeout
expect_violation "characterization ChannelDownStrands       " "$DIR" Outbox.tla "$C/ChannelDownStrands.cfg" NoLoss

if [ "$bad" -ne 0 ]; then echo "RESULT: FAIL (unexpected result above)"; exit 1; fi
echo "RESULT: PASS"
