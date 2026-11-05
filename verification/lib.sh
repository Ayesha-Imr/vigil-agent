# Shared helpers for verification/run.sh and verification/mutate.sh. Source it; do not run it.

VERIFY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The models use TLC 1.8 (nightly) features and output; 1.7.4 cannot run them. v1.8.0 is a rolling
# pre-release, so the checksum below pins the build the models were checked with (2026.11.03.180953)
# and a newer build only warns.
TLC_VERSION=1.8.0
TLC_URL="https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar"
TLC_SHA256=e20447644bfabd29d6bd0fc2c0eb1473fb301c1a0e4dfe1961938ce5a191edbf

# Print the path of tla2tools.jar: $TLA2TOOLS if set, else the pinned release cached in
# verification/.tools/ (downloaded and checksummed on first use).
find_jar() {
	if [ -n "${TLA2TOOLS:-}" ]; then echo "$TLA2TOOLS"; return 0; fi
	local jar="$VERIFY_DIR/.tools/tla2tools.jar"
	if [ ! -f "$jar" ]; then
		mkdir -p "$VERIFY_DIR/.tools"
		echo "downloading TLC $TLC_VERSION ..." >&2
		curl -fsSL -o "$jar.part" "$TLC_URL" || { echo "cannot download $TLC_URL; set TLA2TOOLS to a tla2tools.jar" >&2; return 1; }
		mv "$jar.part" "$jar"
	fi
	if [ -z "${TLA2TOOLS:-}" ] && command -v sha256sum >/dev/null; then
		local got; got=$(sha256sum "$jar" | cut -d' ' -f1)
		[ "$got" = "$TLC_SHA256" ] || echo "note: $jar is a different TLC build than the one the models were checked with ($got)" >&2
	fi
	echo "$jar"
}

# run_tlc DIR MODULE.tla CONFIG.cfg OUTFILE : runs TLC in DIR, writes everything it prints to OUTFILE.
run_tlc() {
	local dir=$1 module=$2 cfg=$3 out=$4 meta
	meta=$(mktemp -d "${TMPDIR:-/tmp}/vigil-tlc.XXXXXX")
	# -noGenerateSpecTE (no *_TTrace_* files beside the spec) exists only in newer TLC builds.
	if [ -z "${TLC_TE+x}" ]; then
		TLC_TE=""
		java -cp "$JAR" tlc2.TLC -help 2>&1 | grep -q noGenerateSpecTE && TLC_TE="-noGenerateSpecTE"
	fi
	(cd "$dir" && java -XX:+UseParallelGC -Xss16m -cp "$JAR" tlc2.TLC -workers "${TLC_WORKERS:-auto}" \
		-cleanup $TLC_TE -metadir "$meta" -config "$cfg" "$module") >"$out" 2>&1
	local rc=$?
	rm -rf "$meta"
	return $rc
}

# verdict OUTFILE : prints "pass", "violated: <what>", or "error: <first error line>".
verdict() {
	local out=$1
	if grep -q "Model checking completed. No error has been found." "$out"; then echo pass; return; fi
	local v
	v=$(grep -m1 -E "^Error: (Invariant .* is violated|Action property .* is violated|Temporal properties were violated|Temporal property .* was violated|Deadlock reached)" "$out" | sed 's/^Error: //')
	if [ -n "$v" ]; then echo "violated: $v"; return; fi
	echo "error: $(grep -m1 -E '^Error|Exception' "$out" || tail -1 "$out")"
}

# states OUTFILE : the distinct-state count of a run.
states() { grep -E '^[0-9,]+ states generated, [0-9,]+ distinct states found' "$1" | tail -1 | sed -E 's/.*generated, ([0-9,]+) distinct.*/\1/' | tr -d ,; }
