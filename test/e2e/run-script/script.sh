#!/bin/sh
# Sum the integers read on stdin and flag if the total exceeds THRESHOLD
# (default 0). POSIX sh so it runs on `local` and inside the Alpine guest.
set -eu

total=0
count=0
while read -r n; do
  total=$((total + n))
  count=$((count + 1))
done

echo "count=$count total=$total"
if [ "$total" -gt "${THRESHOLD:-0}" ]; then
  echo "ALERT: total $total exceeds threshold ${THRESHOLD:-0}"
else
  echo "ok: total $total within threshold ${THRESHOLD:-0}"
fi
