// Helpers for reading the CURRENT provisional ruling of a Kleros v2 dispute
// (used by Phase D — appeal review — to decide whether our vote landed with
// the majority once a dispute enters the Appeal period).
//
// currentRuling(uint256) on KlerosCore returns (ruling, tied, overridden).
// Verified selector: 0x1c3db16d (see kleros-onchain-data skill,
// references/arbitrum-one.md). Read-only, no key involved.

import { CORE } from "../config.mjs";
import { rpcWithRetry } from "./rpc.mjs";

const CURRENT_RULING_SELECTOR = "0x1c3db16d";

// Returns { ruling: number, tied: boolean, overridden: boolean }.
export async function getCurrentRuling(disputeID) {
  const arg = BigInt(disputeID).toString(16).padStart(64, "0");
  const res = await rpcWithRetry("eth_call", [{ to: CORE, data: CURRENT_RULING_SELECTOR + arg }, "latest"]);
  const b = res.replace(/^0x/, "");
  if (b.length < 64 * 3) throw new Error(`currentRuling(${disputeID}): unexpected returndata length ${b.length / 2}`);
  const ruling = Number(BigInt("0x" + b.slice(0, 64)));
  const tied = BigInt("0x" + b.slice(64, 128)) !== 0n;
  const overridden = BigInt("0x" + b.slice(128, 192)) !== 0n;
  return { ruling, tied, overridden };
}
