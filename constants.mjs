// constants.mjs — Protocol-generic constants only.
//
// This module exports ONLY values that are identical for every operator and
// every deployment: on-chain event topics, period names, lookback/block
// timing constants, and ABI-related exports.
//
// Operator-specific values (addresses, paths, RPC URLs, WORKDIR, COURT_ID,
// KLEROS_JUROR_HOME, EVIDENCE_CHAIN) live in config.mjs. Import from there.
//
// REMOVED: VIEM_PATH, JUROR, KEY_PATH, WORKDIR, COURT_ID, CORE, PNK, SORT,
//          DISPUTERESOLVER, DRT, RPC_URLS, IPFS_GATEWAYS, EVIDENCE_CHAIN.

import { keccak256, stringToHex } from "viem";

// ----- on-chain identifiers -----
export const TOPIC_DRAW = keccak256(stringToHex("Draw(address,uint256,uint256,uint256)")); // draw event topic

// ----- display constants -----
export const PERIOD_NAMES = ["evidence", "commit", "vote", "appeal", "execution"];

// ----- block timing -----
export const INIT_LOOKBACK_BLOCKS = 5_000_000; // ~2 weeks on Arbitrum (env override in monitor.mjs)
export const BLOCKS_PER_DAY = 345_600; // ~250 ms/block, used for hints only
