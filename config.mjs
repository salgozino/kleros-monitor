// config.mjs — Single source of truth for operator-specific configuration.
//
// Loads from .env via dotenv/config. Fail-closed on REQUIRED fields:
// WORKDIR, COURT_ID, KLEROS_JUROR_HOME — any missing or empty field throws
// before any export is populated.
//
// Sane defaults are applied for all other fields so operators only need
// to override what differs from the standard Arbitrum One / Kleros setup.
//
// Coupling note: viem is pinned to 2.55.19 — the version bundled by
// kleros-juror-cli@0.1.0. Do not upgrade independently of kleros-juror-cli.
// See README.md (WU2) for the full coupling section.

import "dotenv/config";

// REQUIRED — throws if missing or empty; no sane default exists for these.
const REQUIRED = ["WORKDIR", "COURT_ID", "KLEROS_JUROR_HOME"];

// Default RPC endpoints for Arbitrum One (public, no key required).
const DEFAULT_RPC_URLS = [
  "https://arb1.arbitrum.io/rpc", // official; generous getLogs ranges
  "https://arbitrum-one-rpc.publicnode.com",
];

// Default IPFS gateways (tried in order; first responsive wins).
const DEFAULT_IPFS_GATEWAYS = [
  "https://cdn.kleros.link/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

// Default contract addresses on Arbitrum One (42161).
// Override via .env only when targeting a fork or test deployment.
const DEFAULTS = {
  RPC_URLS: DEFAULT_RPC_URLS,
  IPFS_GATEWAYS: DEFAULT_IPFS_GATEWAYS,
  CORE: "0x991d2df165670b9cac3B022f4B68D65b664222ea", // KlerosCore proxy
  PNK: "0x330bD769382cFc6d50175903434CCC8D206DCAE5", // PNK token
  SORT: "0x21A9402aDb818744B296e1d1BE58C804118DC03D", // SortitionModule
  DISPUTERESOLVER: "0xb5526d022962a1fff6ed32c93e8b714c901f4323",
  DRT: "0x0cFBaCA5C72e7Ca5fFABE768E135654fB3F2a5A2", // DisputeTemplateRegistry
  EVIDENCE_CHAIN: "arbitrum-one", // chain name for `kleros evidence list --chain`
};

/**
 * loadConfig(env) — testable factory. Receives an env-like object and returns
 * a fully validated configuration object. Throws with the field name if any
 * REQUIRED field is missing or empty.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ WORKDIR: string, COURT_ID: string, KLEROS_JUROR_HOME: string,
 *             RPC_URLS: string[], IPFS_GATEWAYS: string[], CORE: string,
 *             PNK: string, SORT: string, DISPUTERESOLVER: string,
 *             DRT: string, EVIDENCE_CHAIN: string, HARNESS: string }}
 */
export function loadConfig(env) {
  // Validate all required fields up front.
  for (const key of REQUIRED) {
    if (!env[key] || env[key].trim() === "") {
      throw new Error(`Missing required config field: ${key}`);
    }
  }

  // Helper: parse a field that may be a JSON array string or use the default.
  function parseArray(key) {
    const raw = env[key];
    if (!raw) return DEFAULTS[key];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON — treat as a single-entry array if non-empty.
      if (raw.trim()) return [raw.trim()];
    }
    return DEFAULTS[key];
  }

  return {
    // Required fields (already validated above).
    WORKDIR: env.WORKDIR,
    COURT_ID: env.COURT_ID,
    KLEROS_JUROR_HOME: env.KLEROS_JUROR_HOME,

    // Array fields — support JSON override via env.
    RPC_URLS: parseArray("RPC_URLS"),
    IPFS_GATEWAYS: parseArray("IPFS_GATEWAYS"),

    // Address fields — fall back to Arbitrum One defaults.
    CORE: env.CORE || DEFAULTS.CORE,
    PNK: env.PNK || DEFAULTS.PNK,
    SORT: env.SORT || DEFAULTS.SORT,
    DISPUTERESOLVER: env.DISPUTERESOLVER || DEFAULTS.DISPUTERESOLVER,
    DRT: env.DRT || DEFAULTS.DRT,

    // Chain/network fields.
    EVIDENCE_CHAIN: env.EVIDENCE_CHAIN || DEFAULTS.EVIDENCE_CHAIN,

    // Harness selector — which LLM harness to use for skill generation.
    // Optional; defaults to "hermes". No validation here: unknown names
    // are caught at runtime by getHarness() in lib/harness.mjs.
    HARNESS: env.HARNESS?.trim() || "hermes",
  };
}

// Module-level exports — called once at startup with process.env.
// dotenv/config has already populated process.env from .env before this runs.
const _cfg = loadConfig(process.env);

export const WORKDIR = _cfg.WORKDIR;
export const COURT_ID = _cfg.COURT_ID;
export const KLEROS_JUROR_HOME = _cfg.KLEROS_JUROR_HOME;
export const RPC_URLS = _cfg.RPC_URLS;
export const IPFS_GATEWAYS = _cfg.IPFS_GATEWAYS;
export const CORE = _cfg.CORE;
export const PNK = _cfg.PNK;
export const SORT = _cfg.SORT;
export const DISPUTERESOLVER = _cfg.DISPUTERESOLVER;
export const DRT = _cfg.DRT;
export const EVIDENCE_CHAIN = _cfg.EVIDENCE_CHAIN;
export const HARNESS = _cfg.HARNESS;
