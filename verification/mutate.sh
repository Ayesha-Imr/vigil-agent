#!/usr/bin/env bash
# Prove that every property can fail: for each verification/mutants/*.mutant, copy the spec,
# apply the broken variant (it mirrors one named change to the code), check only that mutant's
# property, and expect TLC to report the violation. A mutant that TLC does not catch is a
# check that cannot fail: fix the model or the property, never the mutant.
#   bash verification/mutate.sh             all mutants
#   bash verification/mutate.sh governor-05 the mutants whose name starts with governor-05
# Exits nonzero if any mutant survives or errors.
set -u
. "$(dirname "$0")/lib.sh"
JAR=$(find_jar) || exit 2
OUT="$VERIFY_DIR/out/mutants"; mkdir -p "$OUT"
filter=${1:-}
survived=0
for m in "$VERIFY_DIR"/mutants/*.mutant; do
	name=$(basename "$m" .mutant)
	[ -n "$filter" ] && [ "${name#"$filter"}" = "$name" ] && continue
	field() { sed -n "s/^$1: //p" "$m" | head -1; }
	spec=$(field spec); run=$(field run); cfg=$(field config); prop=$(field check); kind=$(field kind)
	work=$(mktemp -d "${TMPDIR:-/tmp}/vigil-mutant.XXXXXX")
	cp "$VERIFY_DIR/$spec"/*.tla "$VERIFY_DIR/$spec"/*.cfg "$work/"
	# Apply every old -> new block; each old text must occur exactly once in the spec's base module.
	if ! python3 -I - "$m" "$work" "$cfg" "$prop" "$kind" <<'PY'
import sys, pathlib, re
mfile, work, cfg, prop, kind = sys.argv[1:]
text = pathlib.Path(mfile).read_text()
blocks = re.findall(r"@@@ old\n(.*?)@@@ new\n(.*?)@@@ end", text, re.S)
if not blocks:
    sys.exit("no @@@ old/new/end blocks")
work = pathlib.Path(work)
for old, new in blocks:
    hits = [p for p in work.glob("*.tla") if p.read_text().count(old) == 1]
    if len(hits) != 1:
        sys.exit(f"old text must occur exactly once in exactly one module: {old!r}")
    p = hits[0]
    p.write_text(p.read_text().replace(old, new))
# A config with the same constants, VIEW and SYMMETRY, and only this mutant's property.
src = (work / cfg).read_text().splitlines()
keep = []
for line in src:
    if re.match(r"^(INVARIANTS?|PROPERTY|PROPERTIES)\b", line):
        break
    keep.append(line)
if kind == "property":
    keep = [l for l in keep if not l.startswith("SYMMETRY")]  # symmetry is unsound for liveness
keep.append(("PROPERTIES" if kind == "property" else "INVARIANTS"))
keep.append("    " + prop)
(work / "mutant.cfg").write_text("\n".join(keep) + "\n")
PY
	then
		printf '%-8s %-40s could not apply the mutant\n' ERROR "$name"; survived=1; rm -rf "$work"; continue
	fi
	out="$OUT/$name.out"
	run_tlc "$work" "$run" mutant.cfg "$out"
	v=$(verdict "$out")
	case "$v" in
		"violated: Invariant $prop is violated."|"violated: Action property $prop is violated."|"violated: Temporal properties were violated.")
			printf '%-8s %-40s %s\n' CAUGHT "$name" "$prop" ;;
		pass) printf '%-8s %-40s %s holds on the mutant: the check cannot see this break\n' SURVIVED "$name" "$prop"; survived=1 ;;
		*) printf '%-8s %-40s %s\n' ERROR "$name" "$v"; survived=1 ;;
	esac
	rm -rf "$work"
done
[ $survived = 0 ] && echo "every mutant was caught" || echo "some mutants were NOT caught"
exit $survived
