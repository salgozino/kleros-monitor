// address.mjs — Derives the juror address from a kleros-juror home directory.
//
// Exports deriveJuror(home?) — reads the "key" file from the given directory
// and returns the checksummed Ethereum address WITHOUT printing key material.
//
// Standalone usage: node address.mjs
//   Prints the juror address for KLEROS_JUROR_HOME (or ~/.kleros-juror).
//
// NOTE: Do NOT import config.mjs at module scope here. deriveJuror() receives
// `home` as an argument so it stays pure and testable without a .env file.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Derive the checksummed juror address from the key file in `home`.
 *
 * @param {string} [home] Path to the kleros-juror home directory.
 *   Defaults to KLEROS_JUROR_HOME env var, then ~/.kleros-juror.
 * @returns {`0x${string}`} Checksummed Ethereum address.
 */
export function deriveJuror(home = process.env.KLEROS_JUROR_HOME || join(homedir(), ".kleros-juror")) {
  const raw = readFileSync(join(home, "key"), "utf8").trim();

  let pk;
  try {
    const hex = raw.toLowerCase().startsWith("0x") ? raw : "0x" + raw;
    if (/^0x[0-9a-f]{64}$/i.test(hex)) {
      pk = hex;
    } else {
      throw new Error("not raw hex");
    }
  } catch {
    console.error(JSON.stringify({ error: "Unsupported key format in " + home }));
    process.exit(1);
  }

  return privateKeyToAccount(pk).address;
}

// Standalone execution guard — prints the address when run directly.
// Compatible with: node address.mjs
if (import.meta.url === new URL(process.argv[1], "file://").href) {
  const home = process.env.KLEROS_JUROR_HOME || join(homedir(), ".kleros-juror");
  // Print ONLY public information — never log key material.
  console.log(deriveJuror(home));
}
