// Single source of truth for all shared constants in kleros-monitor.
// All 16 named constants are exported below.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const VIEM_PATH = "/usr/local/lib/node_modules/kleros-juror-cli/node_modules/viem";
const { keccak256, stringToHex } = require(VIEM_PATH);

// ----- contract addresses -----
export const CORE = "0x991d2df165670b9cac3B022f4B68D65b664222ea"; // KlerosCore proxy, Arbitrum One
export const JUROR = "0x606D2DD4Ca178349b327Ed7ACacf68058bd748Bc"; // default juror address
export const PNK = "0x330bD769382cFc6d50175903434CCC8D206DCAE5"; // PNK token, Arbitrum One
export const SORT = "0x21A9402aDb818744B296e1d1BE58C804118DC03D"; // SortitionModule
export const DISPUTERESOLVER = "0xb5526d022962a1fff6ed32c93e8b714c901f4323"; // DisputeResolver
export const DRT = "0x0cFBaCA5C72e7Ca5fFABE768E135654fB3F2a5A2"; // DisputeTemplateRegistry

// ----- paths -----
export { VIEM_PATH };
export const WORKDIR = "/root/kleros-monitor";
export const KEY_PATH = "/root/.kleros-juror/key";

// ----- network -----
export const RPC_URLS = [
  "https://arb1.arbitrum.io/rpc", // official; generous getLogs ranges
  "https://arbitrum-one-rpc.publicnode.com", // rejects old ranges without token
];
export const IPFS_GATEWAYS = [
  "https://cdn.kleros.link/ipfs/", // Kleros gateway (IPFS_GATEWAY in kleros-v2 web)
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

// ----- on-chain identifiers -----
export const COURT_ID = 34n;
export const TOPIC_DRAW = keccak256(stringToHex("Draw(address,uint256,uint256,uint256)")); // draw event topic

// ----- numeric / display constants -----
export const PERIOD_NAMES = ["evidence", "commit", "vote", "appeal", "execution"];
export const INIT_LOOKBACK_BLOCKS = 5_000_000; // ~2 weeks on Arbitrum (env override in monitor.mjs)
export const BLOCKS_PER_DAY = 345_600; // ~250 ms/block, used for hints only
