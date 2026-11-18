#!/usr/bin/env bash
# Usage: wait-any-worker.sh <name-or-absolute-path>...; exits 0 on the first non-empty exit.txt.
set -euo pipefail
D=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
fail() { printf 'wait-any-worker: %s\n' "$*" >&2; exit 2; }
(( $# )) || fail 'usage: wait-any-worker.sh <name-or-absolute-path>...'
dirs=()
for name in "$@"; do
  candidate=$name
  [[ $candidate = /* ]] || candidate=$D/$candidate
  [[ -d $candidate ]] || fail "directory does not exist: $name"
  dir=$(realpath -e -- "$candidate") || fail "cannot resolve directory: $name"
  [[ $dir = "$D" || $dir = "$D/"* ]] || fail "directory is outside dispatch: $name"
  dirs+=("$dir")
done
while true; do
  i=0
  for name in "$@"; do
    if [[ -s ${dirs[$i]}/exit.txt ]]; then
      printf '%s %s exit=%s\n' "$(date +%T)" "$name" "$(cat -- "${dirs[$i]}/exit.txt")"
      exit 0
    fi
    i=$((i + 1))
  done
  sleep 60
done
