# aurora — is it Aurora?  Shell wrapper for the EMR Sheffield ⇄ London board.
#
# Install (zsh or bash) — appends this function to your shell rc:
#   curl -fsSL https://tomsmilton.github.io/isitaurora/aurora.sh >> ~/.zshrc && exec zsh
#
# Then just run:
#   aurora               # today, Sheffield → London
#   aurora next          # the next departure — is it an Aurora?
#   aurora tomorrow both # tomorrow, both directions
#   aurora --help
#
# It caches the little Node CLI in ~/.cache/isitaurora and refreshes it once a
# day, so you automatically pick up fixes. Data comes from the published feed —
# no API token needed.
aurora() {
  local url="https://tomsmilton.github.io/isitaurora/aurora.mjs"
  local dir="${XDG_CACHE_HOME:-$HOME/.cache}/isitaurora"
  local script="$dir/aurora.mjs"
  command -v node >/dev/null 2>&1 || { echo "aurora: needs Node.js — https://nodejs.org" >&2; return 1; }
  mkdir -p "$dir"
  # (re)download if missing or older than a day; keep the old copy if offline
  if [ ! -f "$script" ] || [ -n "$(find "$script" -mtime +1 2>/dev/null)" ]; then
    curl -fsSL "$url" -o "$script.tmp" 2>/dev/null && mv "$script.tmp" "$script"
  fi
  [ -f "$script" ] || { echo "aurora: couldn't download the tool (offline?)" >&2; return 1; }
  node "$script" "$@"
}
