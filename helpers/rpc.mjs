// Shared JSON-RPC helpers — rpc, rpcAny, rpcWithRetry, getLogs.
// Preserves fetch + AbortController retry semantics from monitor.mjs and
// getLogs semantics from dossier-builder.mjs.

import { RPC_URLS } from "../config.mjs";
import { sleep } from "./utils.mjs";

// Single-endpoint call with AbortController timeout.
export async function rpc(endpoint, method, params, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`non-JSON response from ${endpoint}: ${text.slice(0, 80)}`); }
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  } finally { clearTimeout(t); }
}

// Tries every endpoint in RPC_URLS until one answers.
export async function rpcAny(method, params) {
  let lastErr;
  for (const url of RPC_URLS) {
    try { return await rpc(url, method, params); } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("all RPC endpoints failed");
}

// Retries rpcAny with exponential-ish backoff.
export async function rpcWithRetry(method, params, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await rpcAny(method, params); } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

// Fetches eth_getLogs with up to 3 retry attempts (from dossier-builder.mjs).
export async function getLogs(filter) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try { return await rpcWithRetry("eth_getLogs", [filter]); } catch (e) { lastErr = e; await sleep(2000); }
  }
  throw lastErr;
}
