#!/bin/bash
# sync-cron-prompt.sh — regenerate veredict-skill.md from the harness template
# and push it as the live prompt of the kleros-draw-monitor cron job.
#
# Single source of truth: harnesses/hermes/veredict-skill.md (template with
# {{WORKDIR}} placeholder). This script renders it to $WORKDIR/veredict-skill.md
# and syncs that into ~/.hermes/cron/jobs.json via hermes cron edit --prompt.
#
# Usage: ./scripts/sync-cron-prompt.sh [job_id]
set -euo pipefail
cd "$(dirname "$0")/.."

JOB_ID="${1:-f5df979787c1}"

echo "1/2 Regenerating veredict-skill.md from harness template..."
node bin/kleros-monitor.mjs skill generate --harness hermes

echo "2/2 Syncing into cron job ${JOB_ID}..."
hermes cron edit "${JOB_ID}" --prompt "$(cat veredict-skill.md)"

echo "Done. Verify with: hermes cron list | grep -A3 ${JOB_ID}"
