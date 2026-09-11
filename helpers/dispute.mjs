// Shared helper — reads a KlerosCore dispute's static header fields.
// Extracted from monitor.mjs so both Phase B (draw monitor) and Phase D
// (appeal review) can read dispute state without duplicating the ABI
// decoding logic. Read-only, no key involved.

import { keccak256, stringToHex } from "viem";
import { CORE } from "../config.mjs";
import { rpcWithRetry } from "./rpc.mjs";

// disputes(): the deployed proxy returns the 5 STATIC leading fields as flat words:
// (uint96 courtID, address arbitrated, uint8 period, bool ruled, uint256 lastPeriodChange)
// (the dynamic Round[] tail is truncated out by the ABI encoder for this accessor shape)
export async function getDisputeHeader(disputeID) {
  const sel = keccak256(stringToHex("disputes(uint256)")).slice(0, 10);
  const arg = BigInt(disputeID).toString(16).padStart(64, "0");
  const res = await rpcWithRetry("eth_call", [{ to: CORE, data: sel + arg }, "latest"]);
  const b = res.replace(/^0x/, "");
  if (b.length < 64 * 5) throw new Error(`disputes(${disputeID}): unexpected returndata length ${b.length / 2}`);
  const w = [];
  for (let i = 0; i < 5; i++) w.push(BigInt("0x" + b.slice(i * 64, (i + 1) * 64)));
  return {
    courtID: w[0].toString(),
    arbitrated: "0x" + w[1].toString(16).padStart(40, "0").slice(-40),
    period: Number(w[2]),
    ruled: w[3] !== 0n,
    lastPeriodChange: w[4],
  };
}
