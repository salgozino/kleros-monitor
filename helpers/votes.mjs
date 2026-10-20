// helpers/votes.mjs — Reads EVERY juror's vote + public justification for one
// dispute/round, straight from on-chain VoteCast events. Used by Phase D so a
// post-ruling appeal review is never written from our own reasoning alone.
//
// Why this exists: verified live on dispute #300 (2026-10-20) that an appeal
// recommendation was written with "alta" confidence after reading ONLY our
// own decision.json/verdict.md against the bare on-chain tally (ruling,
// tied). The other 3 jurors' full justifications were sitting on-chain the
// whole time (VoteCast's _justification field) and were never fetched. One
// of those justifications flagged a specific textual detail (HLTV's "Default"
// annotation on the second map) that directly undercut our reading and that
// we had not addressed. Decisions about whether to recommend funding an
// appeal MUST be informed by what the majority actually argued, not just by
// the fact that they disagreed.

import { encodeFunctionData, decodeFunctionResult } from "viem";

import { CORE } from "../config.mjs";
import { rpcWithRetry } from "./rpc.mjs";
import ROUND_ABI from "../abis/round.mjs";

// DisputeKitClassic VoteCast(uint256 indexed _coreDisputeID, address indexed _juror,
//   uint256[] _voteIDs, uint256 indexed _choice, string _justification)
const VOTE_CAST_TOPIC = "0xa000893c71384499023d2d7b21234f7b9e80c78e0330f357dcd667ff578bd3a4";

const DISPUTE_KITS_ABI = [{
  type: "function", name: "disputeKits", stateMutability: "view",
  inputs: [{ type: "uint256" }], outputs: [{ type: "address" }],
}];

// DisputeKitClassic.getVoteInfo(coreDisputeID, coreRoundID, voteID). Takes the
// CORE round ID (the kit maps it to its local round internally).
const VOTE_INFO_ABI = [{
  type: "function", name: "getVoteInfo", stateMutability: "view",
  inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
  outputs: [
    { name: "account", type: "address" },
    { name: "commit", type: "bytes32" },
    { name: "choice", type: "uint256" },
    { name: "voted", type: "bool" },
  ],
}];

function pad(n) {
  return BigInt(n).toString(16).padStart(64, "0");
}

// Resolves the DisputeKit contract address for a given dispute's current
// round, by reading KlerosCore.getRoundInfo(dispute, round).disputeKitID and
// then KlerosCore.disputeKits(disputeKitID). Never hardcode the DK address —
// a dispute kit jump (classic -> gated/shutter) would silently go stale.
// Uses viem's ABI encode/decode (not manual hex slicing) because
// getRoundInfo's return tuple contains a dynamic field (drawnJurors
// address[]), which shifts the static fields behind an offset pointer —
// exactly the bug class documented in the kleros-v2-onchain skill.
async function readRoundInfo(disputeID, roundID) {
  const data = encodeFunctionData({ abi: ROUND_ABI, args: [BigInt(disputeID), BigInt(roundID)] });
  const res = await rpcWithRetry("eth_call", [{ to: CORE, data }, "latest"]);
  return decodeFunctionResult({ abi: ROUND_ABI, data: res });
}

async function readDisputeKitAddress(disputeKitID) {
  const dkData = encodeFunctionData({ abi: DISPUTE_KITS_ABI, functionName: "disputeKits", args: [disputeKitID] });
  const dkRes = await rpcWithRetry("eth_call", [{ to: CORE, data: dkData }, "latest"]);
  return decodeFunctionResult({ abi: DISPUTE_KITS_ABI, functionName: "disputeKits", data: dkRes });
}

export async function getDisputeKitAddress(disputeID, roundID) {
  const { disputeKitID } = await readRoundInfo(disputeID, roundID);
  return readDisputeKitAddress(disputeKitID);
}

// Reads the round's vote table from the DisputeKit, one slot per voteID:
// who holds it, which choice it recorded and whether it was cast. This is
// the authoritative per-round record that VoteCast logs are matched against.
async function readVoteSlots(dkAddress, disputeID, roundID, nbVotes) {
  const slots = [];
  for (let voteID = 0; voteID < nbVotes; voteID++) {
    const data = encodeFunctionData({
      abi: VOTE_INFO_ABI, functionName: "getVoteInfo",
      args: [BigInt(disputeID), BigInt(roundID), BigInt(voteID)],
    });
    const res = await rpcWithRetry("eth_call", [{ to: dkAddress, data }, "latest"]);
    const [account, , choice, voted] = decodeFunctionResult({ abi: VOTE_INFO_ABI, functionName: "getVoteInfo", data: res });
    slots.push({ account: account.toLowerCase(), choice: Number(choice), voted });
  }
  return slots;
}

// VoteCast carries no round ID, so a log belongs to this round only when every
// voteID it claims is a cast slot of this round held by the same juror with
// the same choice.
function belongsToRound(vote, slots) {
  return vote.voteIds.length > 0 && vote.voteIds.every((id) => {
    const slot = slots[id];
    return slot && slot.voted && slot.account === vote.juror && slot.choice === vote.choice;
  });
}

// ABI-decodes one VoteCast log: topics[2]=juror (indexed), topics[3]=choice
// (indexed), data holds the dynamic _voteIDs array + _justification string.
function decodeVoteCastLog(log) {
  const juror = "0x" + log.topics[2].slice(-40);
  const choice = Number(BigInt(log.topics[3]));
  const data = log.data.replace(/^0x/, "");
  const words = [];
  for (let i = 0; i < data.length; i += 64) words.push(data.slice(i, i + 64));
  const offVoteIds = Number(BigInt("0x" + words[0])) / 32;
  const offJust = Number(BigInt("0x" + words[1])) / 32;
  const lenVoteIds = Number(BigInt("0x" + words[offVoteIds]));
  const voteIds = [];
  for (let i = 0; i < lenVoteIds; i++) voteIds.push(Number(BigInt("0x" + words[offVoteIds + 1 + i])));
  const lenJustBytes = Number(BigInt("0x" + words[offJust]));
  const justWords = words.slice(offJust + 1);
  const justHex = justWords.join("").slice(0, lenJustBytes * 2);
  const justification = Buffer.from(justHex, "hex").toString("utf8");
  return { juror: juror.toLowerCase(), choice, voteIds, justification };
}

/**
 * Fetches every juror's revealed vote (choice + full public justification)
 * for one dispute/round, by reading VoteCast events from the resolved
 * DisputeKit contract and keeping only the ones that match this round's vote
 * table. Returns:
 *   { dkAddress, tally: {choiceNumber: votes}, votes: [{juror, choice, voteIds, justification, ambiguous?}] }
 * The tally counts this round's cast votes (voteIDs), which is what the ruling
 * is computed from; one VoteCast can cast several voteIDs. A vote is flagged
 * `ambiguous` when another matching log claims one of its voteIDs: the same
 * juror held the same slot with the same choice in another round, and the
 * logs alone cannot tell which justification belongs here.
 */
export async function getAllVotesWithJustifications(disputeID, roundID, { fromBlock = "0x0" } = {}) {
  const { disputeKitID, nbVotes } = await readRoundInfo(disputeID, roundID);
  const dkAddress = await readDisputeKitAddress(disputeKitID);
  const slots = await readVoteSlots(dkAddress, disputeID, roundID, Number(nbVotes));
  const disputeTopic = "0x" + pad(disputeID);
  const logs = await rpcWithRetry("eth_getLogs", [{
    address: dkAddress,
    topics: [VOTE_CAST_TOPIC, disputeTopic],
    fromBlock,
    toBlock: "latest",
  }]);
  const matched = logs.map(decodeVoteCastLog).filter((v) => belongsToRound(v, slots));
  const claims = new Map();
  for (const v of matched) for (const id of v.voteIds) claims.set(id, (claims.get(id) || 0) + 1);
  const votes = matched.map((v) => (v.voteIds.some((id) => claims.get(id) > 1) ? { ...v, ambiguous: true } : v));
  const tally = {};
  for (const slot of slots) if (slot.voted) tally[slot.choice] = (tally[slot.choice] || 0) + 1;
  return { dkAddress, tally, votes };
}
