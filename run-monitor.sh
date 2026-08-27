#!/bin/bash
# Wrapper for the kleros-draw-monitor cron job (no_agent mode).
# Contract: empty stdout = nothing new (silent tick); alert text on draw; exit != 0 on error.
exec /usr/local/bin/node /root/kleros-monitor/monitor.mjs "$@"
