#!/bin/zsh
# Draw Things keeps everything it draws, API runs and warm-ups included, in its project files
# (Documents/*.sqlite3), about 1.7 MB a picture. What we keep is already in content/, so these
# copies can go. Without --yes the script only lists them; with --yes it moves them to the Trash,
# and Draw Things must be closed for that. Models and settings are left alone.
#
#   zsh mac/scripts/dt_clean.sh          # what is there
#   zsh mac/scripts/dt_clean.sh --yes    # to the Trash
set -eu

docs="$HOME/Library/Containers/com.liuliu.draw-things/Data/Documents"
projects=("$docs"/*.sqlite3(N))

if (( ${#projects} == 0 )); then
  echo "No Draw Things projects: nothing to clean."
  exit 0
fi

for db in $projects; do
  count=$(sqlite3 -readonly "file:$db?mode=ro" "select count(*) from tensorhistorynode;" \
    2>/dev/null || echo "?")
  print "$(du -h "$db" | cut -f1)\t${db:t}\t$count pictures in history"
done

if [[ "${1:-}" != "--yes" ]]; then
  echo "Nothing moved. To move these to the Trash: quit Draw Things, then add --yes."
  exit 0
fi

if pgrep -x DrawThings >/dev/null; then
  echo "Draw Things is running: quit it first (Cmd+Q)." >&2
  exit 1
fi

for db in $projects; do
  trash "$db" "$db"-wal(N) "$db"-shm(N)
done
echo "Moved to the Trash: put them back from there if a picture is missed."
