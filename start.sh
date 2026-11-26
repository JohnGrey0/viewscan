#!/bin/sh
# Starts Viewscan without Docker (Mac or Linux) and opens it in the browser.
cd "$(dirname "$0")" || exit 1
( sleep 1; command -v open >/dev/null && open "http://localhost:${PORT:-8127}/" ) &
exec node server.js
