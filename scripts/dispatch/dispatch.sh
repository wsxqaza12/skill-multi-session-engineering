#!/usr/bin/env bash
# Usage: dispatch.sh <worker|review> <name> <worktree> [--effort high|xhigh].
# Put this script in your dispatch folder; each <name> is a subfolder holding prompt.md.
# Env: DISPATCH_MODEL (required), DISPATCH_UNSET_ENV (space-separated secret variable names to strip).
# Never add a fast/priority service tier flag; resuming a thread started with it brings it back.
set -euo pipefail
D=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
fail() { printf 'dispatch: %s\n' "$*" >&2; exit 2; }
[[ $# = 3 || $# = 5 ]] || fail 'usage: dispatch.sh <worker|review> <name> <worktree> [--effort high|xhigh]'
mode=$1; name=$2; worktree=$3
case $mode in worker) effort=high;; review) effort=xhigh;; *) fail 'mode must be worker or review';; esac
if (( $# == 5 )); then
  [[ $4 = --effort && ( $5 = high || $5 = xhigh ) ]] || fail 'expected --effort high|xhigh'
  effort=$5
fi
[[ $name != /* ]] || fail 'name must be relative to the dispatch directory'
dir=$(realpath -e -- "$D/$name" 2>/dev/null) || fail "dispatch directory does not exist: $name"
[[ -d $dir && $dir = "$D/"* ]] || fail 'name must be a directory inside dispatch'
[[ $(git -C "$worktree" rev-parse --is-inside-work-tree 2>/dev/null) = true ]] || fail "not a git work tree: $worktree"
worktree=$(cd -- "$worktree" && pwd -P)
head=$(git -C "$worktree" rev-parse --verify HEAD 2>/dev/null) || fail 'worktree has no HEAD'
[[ -s $dir/prompt.md ]] || fail "prompt.md is missing or empty: $name"
exec 9<"$dir"
flock -xn 9 || fail "dispatch already active: $name"
# A startup failure is terminal for waiters, but may be retried under the lock.
if [[ -f $dir/startup-failure.txt && -f $dir/exit.txt && $(< "$dir/exit.txt") = 125 ]]; then
  rm -- "$dir/exit.txt" "$dir/startup-failure.txt"
fi
[[ ! -e $dir/exit.txt && ! -L $dir/exit.txt ]] || fail 'exit.txt already exists; use a new round subdirectory'
bad_lines=$(awk '
  function empty_span(s, pos, width, rest, scan, closing, found, content) {
    pos=1
    while (pos<=length(s)) {
      if (substr(s,pos,1)!="`") { pos++; continue }
      rest=substr(s,pos); match(rest,/^`+/); width=RLENGTH
      scan=pos+width; found=0
      while (scan<=length(s)) {
        closing=index(substr(s,scan),"`"); if (!closing) break
        closing+=scan-1; rest=substr(s,closing); match(rest,/^`+/)
        if (RLENGTH==width) { found=1; break }
        scan=closing+RLENGTH
      }
      if (found) {
        content=substr(s,pos+width,closing-pos-width)
        if (content~/^[ \t]*$/) return 1
        pos=closing+width
      } else {
        if (width==2) return 1
        pos+=width
      }
    }
    return 0
  }
  {
    damaged=0
    line=$0; sub(/^[ \t]*/, "", line)
    if (line~/^```/ || line~/^~~~/) {
      char=substr(line,1,1); match(line,/^[`~]+/); width=RLENGTH
      if (!fence) { fence=char; fence_width=width }
      else if (fence==char && width>=fence_width && substr(line,width+1)~/^[ \t\r]*$/) fence=""
    } else if (!fence) {
      if ($0 ~ /^[ \t]*[^ \t:"\047`][^ \t:"\047`]*(:[0-9]+)?: command not found: [^ \t:"\047`]+[ \t]*$/ ||
          $0 ~ /^[ \t]*[^ \t:"\047`][^ \t:"\047`]*(:[0-9]+)?: line [0-9]+: [^ \t:"\047`]+: command not found[ \t]*$/) damaged=1
      if (empty_span($0)) damaged=1
    }
    if (damaged) { printf "%s%d", sep, NR; sep=", " }
  }
' "$dir/prompt.md")
[[ -z $bad_lines ]] || fail "possible shell damage in prompt.md at line(s): $bad_lines"
for cmd in codex nohup setsid; do command -v "$cmd" >/dev/null || fail "command unavailable: $cmd"; done
proc_start() {
  local stat rest
  IFS= read -r stat 2>/dev/null < "/proc/$1/stat" || return 1
  rest=${stat##*) }
  local fields=(); read -r -a fields <<< "$rest"
  [[ ${fields[0]} != Z && ${fields[0]} != X ]] || return 1
  printf '%s\n' "${fields[19]}"
}
signal_same() {
  local actual
  actual=$(proc_start "$1") || return 0
  [[ $actual = "$2" ]] || return 0
  kill -s "$3" "$1" 2>/dev/null || :
}
freeze_tree() {
  local pid=$1 identity=$2 actual children= child child_start
  actual=$(proc_start "$pid") || return 0
  [[ $actual = "$identity" ]] || return 0
  # Freeze parents before discovering children, so a stalled metadata command
  # cannot keep forking while we collect verified identities for cleanup.
  signal_same "$pid" "$identity" STOP
  stopped_pids+=("$pid"); stopped_starts+=("$identity")
  if IFS= read -r children 2>/dev/null < "/proc/$pid/task/$pid/children"; then :; fi
  for child in $children; do
    child_start=$(proc_start "$child") || continue
    freeze_tree "$child" "$child_start"
  done
}
startup_failed() {
  local reason=$1 i attempt alive
  local stopped_pids=() stopped_starts=()
  if [[ -n $launcher_start ]]; then freeze_tree "$launcher" "$launcher_start"; fi
  for ((i=${#stopped_pids[@]}-1; i>=0; i--)); do
    signal_same "${stopped_pids[i]}" "${stopped_starts[i]}" TERM
    signal_same "${stopped_pids[i]}" "${stopped_starts[i]}" CONT
  done
  for ((attempt=0; attempt<20; attempt++)); do
    alive=0
    for ((i=0; i<${#stopped_pids[@]}; i++)); do
      if [[ $(proc_start "${stopped_pids[i]}" || :) = "${stopped_starts[i]}" ]]; then alive=1; fi
    done
    (( alive )) || break
    sleep 0.05
  done
  for ((i=${#stopped_pids[@]}-1; i>=0; i--)); do
    signal_same "${stopped_pids[i]}" "${stopped_starts[i]}" KILL
  done
  wait "$launcher" 2>/dev/null || :
  printf 'dispatch: %s\n' "$reason" > "$dir/startup-failure.txt"
  printf '125\n' > "$dir/exit.txt"
  fail "$reason (startup failed; exit=125; reservation released; retry allowed)"
}
: > "$dir/dispatched.txt"
# The supervisor inherits the reservation through wait/exit.txt; Codex closes its copy.
# --fork --wait keeps the captured launcher alive as the root of the detached
# process tree, even when setsid would otherwise fork and exit during startup.
nohup setsid --fork --wait bash -c '
  set -uo pipefail
  mode=$1; effort=$2; worktree=$3; dir=$4; head=$5
  if [[ $mode = worker ]]; then sandbox=(-c sandbox_mode=danger-full-access); else sandbox=(-s read-only); fi
  # Never hand secrets in the shell environment to a worker or reviewer: list them in DISPATCH_UNSET_ENV.
  unset_args=(); for v in ${DISPATCH_UNSET_ENV:-}; do unset_args+=(-u "$v"); done
  env "${unset_args[@]}" codex exec -m "${DISPATCH_MODEL:?set DISPATCH_MODEL to the Codex model to use}" -c "model_reasoning_effort=$effort" "${sandbox[@]}" --ignore-user-config --disable hooks -C "$worktree" --json -o "$dir/last.md" < "$dir/prompt.md" > "$dir/events.jsonl" 2> "$dir/stderr.log" 9<&- &
  pid=$!
  printf "time=%s\nmode=%s\neffort=%s\nworktree=%s\nhead=%s\npid=%s\n" "$(date -Is)" "$mode" "$effort" "$worktree" "$head" "$pid" > "$dir/dispatched.txt"
  if wait "$pid"; then rc=0; else rc=$?; fi
  echo "$rc" > "$dir/exit.txt"
' bash "$mode" "$effort" "$worktree" "$dir" "$head" < /dev/null > /dev/null 2>&1 &
launcher=$!
launcher_start=$(proc_start "$launcher") || launcher_start=
for ((i=0; i<100; i++)); do
  if [[ -s $dir/dispatched.txt ]]; then
    printf 'wait-any-worker.sh %q\n' "$name"
    exit 0
  fi
  kill -0 "$launcher" 2>/dev/null || startup_failed 'detached supervisor failed to start'
  sleep 0.05
done
startup_failed 'detached supervisor did not record dispatched.txt within 5 seconds'
