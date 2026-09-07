#!/bin/bash
# sync-cron-prompt.sh — regenerate veredict-skill.md from the harness template
# and push it as the live prompt of the kleros-draw-monitor cron job.
#
# Single source of truth: harnesses/hermes/veredict-skill.md (template with
# {{WORKDIR}} placeholder). This script renders it to $WORKDIR/veredict-skill.md
# and syncs that into ~/.hermes/cron/jobs.json via hermes cron edit --prompt.
#
# WARNING: hermes cron edit touches a LIVE production job (runs every minute).
# Changes are immediate — there is no staging step.
#
# Usage: ./scripts/sync-cron-prompt.sh [job_id]
set -euo pipefail
cd "$(dirname "$0")/.."

JOB_ID="${1:-f5df979787c1}"

# --- preflight ---
if ! command -v hermes &>/dev/null; then
  echo "ERROR: hermes is not in PATH. Install it or add it to PATH before running this script." >&2
  exit 1
fi

# --- backup current prompt ---
echo "1/3 Backing up current prompt for job ${JOB_ID}..."
BACKUP_FILE=".prompt-backup-${JOB_ID}.txt"
if hermes cron show "${JOB_ID}" --prompt > "${BACKUP_FILE}" 2>/dev/null; then
  echo "    Backup saved to ${BACKUP_FILE} ($(wc -c < "${BACKUP_FILE}") bytes)"
else
  echo "    WARNING: could not back up current prompt (new job or hermes error). Continuing anyway." >&2
fi

# --- generate ---
echo "2/3 Regenerating veredict-skill.md from harness template..."
node bin/kleros-monitor.mjs skill generate --harness hermes

# --- sync ---
echo "3/3 Syncing into cron job ${JOB_ID}..."
hermes cron edit "${JOB_ID}" --prompt "$(cat veredict-skill.md)"

echo "Done. Verify with: hermes cron list | grep -A3 ${JOB_ID}"
