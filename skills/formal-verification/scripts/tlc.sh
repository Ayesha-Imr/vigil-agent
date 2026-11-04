#!/usr/bin/env bash
# Run TLC on a TLA+ spec: finds or downloads tla2tools.jar, then runs the model checker.
set -euo pipefail
if [ $# -lt 1 ]; then echo "usage: tlc.sh Spec.tla [TLC options]" >&2; exit 2; fi
VERSION="${TLA2TOOLS_VERSION:-v1.8.0}"
find_jar() {
  for p in "${TLA2TOOLS_JAR:-}" "$HOME/.vigil/tools/tla2tools.jar" "${VIGIL_HOME:-/nonexistent}/tools/tla2tools.jar" /opt/vigil/tools/tla2tools.jar /home/user/tools/tla2tools.jar; do
    if [ -n "$p" ] && [ -f "$p" ]; then echo "$p"; return 0; fi
  done
  return 1
}
JAR="$(find_jar || true)"
if [ -z "$JAR" ]; then
  mkdir -p "$HOME/.vigil/tools"
  JAR="$HOME/.vigil/tools/tla2tools.jar"
  echo "downloading tla2tools.jar ($VERSION) to $JAR" >&2
  curl -fsSL -o "$JAR" "https://github.com/tlaplus/tlaplus/releases/download/$VERSION/tla2tools.jar"
fi
command -v java >/dev/null || { echo "java not found: install a JRE (11+) to run TLC" >&2; exit 3; }
SPEC="$1"; shift
cd "$(dirname "$SPEC")"
exec java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers auto -cleanup "$(basename "$SPEC")" "$@"
