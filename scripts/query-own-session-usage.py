#!/usr/bin/env python3
"""Self-audit helper: an agent calls this ON ITSELF, mid-run, right before
writing its final verdict, to report which model(s) actually served its OWN
session so far -- instead of guessing or reporting the nominal job-configured
model as if it were verified fact.

Prints a compact per-model breakdown (tokens + cost) meant to be pasted close
to verbatim into a public report: it deliberately NEVER prints the session id
or any other internal identifier to stdout -- that only exists to run the
query below and never leaves this process. Debug info (including the session
id) goes to stderr only.

KNOWN GAP: the API call that is CURRENTLY generating the text calling this
script has not finished yet, so it cannot appear in its own breakdown.
Report this as "as of the last completed call", not total completeness.

Cost: uses Hermes' own estimated_cost_usd (computed from an official pricing
docs snapshot -- see cost_source/cost_status columns), never a value guessed
by this script or by the calling agent. actual_cost_usd is not used: as of
this writing it is always 0 in practice (not yet populated by Hermes). Any
row whose cost_status isn't exactly "estimated" reports cost as "unknown" --
never silently treated as free or backfilled with a guess.

Usage (no args, reads $HERMES_SESSION_ID):
    python3 query-own-session-usage.py
"""
import os
import sqlite3
import sys
from pathlib import Path

STATE_DB = Path.home() / ".hermes" / "state.db"


def main():
    session_id = os.environ.get("HERMES_SESSION_ID", "").strip()
    if not session_id:
        print("ERROR: $HERMES_SESSION_ID is not set in this environment.",
              file=sys.stderr)
        sys.exit(1)

    con = sqlite3.connect(str(STATE_DB))
    try:
        cur = con.cursor()
        cur.execute(
            "SELECT model, billing_provider, api_call_count, input_tokens, "
            "output_tokens, cache_read_tokens, cache_write_tokens, "
            "reasoning_tokens, estimated_cost_usd, cost_status "
            "FROM session_model_usage WHERE session_id = ? "
            "ORDER BY api_call_count DESC",
            (session_id,),
        )
        rows = cur.fetchall()
    finally:
        con.close()

    if not rows:
        print(
            f"No completed API calls recorded yet for session {session_id} "
            "(too early in the run, or usage tracking hasn't flushed).",
            file=sys.stderr,
        )
        sys.exit(1)

    # Merge rows sharing the same (model, provider) -- session_model_usage can
    # have more than one row per pair (e.g. split by internal "task" bucket).
    merged = {}
    for model, provider, calls, in_tok, out_tok, cache_r, cache_w, reason_tok, cost, status in rows:
        key = (model, provider or "?")
        m = merged.setdefault(key, {
            "calls": 0, "in": 0, "out": 0, "cache_r": 0,
            "cache_w": 0, "reason": 0, "cost": 0.0, "known": True,
        })
        m["calls"] += calls or 0
        m["in"] += in_tok or 0
        m["out"] += out_tok or 0
        m["cache_r"] += cache_r or 0
        m["cache_w"] += cache_w or 0
        m["reason"] += reason_tok or 0
        m["cost"] += cost or 0.0
        m["known"] = m["known"] and (status == "estimated")

    total_tokens = total_calls = 0
    total_cost = 0.0
    all_known = True
    lines = []
    for (model, provider), m in sorted(merged.items(), key=lambda kv: -kv[1]["calls"]):
        cache_note = ""
        if m["cache_r"]:
            cache_note += f", {m['cache_r']:,} cache-read"
        if m["cache_w"]:
            cache_note += f", {m['cache_w']:,} cache-write"
        cost_str = f"${m['cost']:.4f}" if m["known"] else "unknown"
        lines.append(
            f"{model} via {provider}: {m['in']:,} in / {m['out']:,} out / "
            f"{m['reason']:,} reasoning{cache_note} tokens ({m['calls']} call(s)) "
            f"\u2014 cost: {cost_str}"
        )
        total_tokens += m["in"] + m["out"] + m["reason"]
        total_calls += m["calls"]
        total_cost += m["cost"]
        all_known = all_known and m["known"]

    if len(merged) > 1:
        total_str = f"${total_cost:.4f}" if all_known else "unknown (one or more models lack pricing data)"
        lines.append(f"TOTAL: {total_tokens:,} tokens ({total_calls} call(s)) \u2014 cost: {total_str}")

    print("\n".join(lines))
    print(f"(debug: session_id={session_id})", file=sys.stderr)


if __name__ == "__main__":
    main()
