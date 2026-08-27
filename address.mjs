// Derives the juror address from ~/.kleros-juror/key WITHOUT printing the key.
// Prints only the checksummed address. Never log the key material.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { VIEM_PATH } from "./constants.mjs";

const require = createRequire(import.meta.url);
const { privateKeyToAccount } = require(VIEM_PATH + "/accounts");

const home = process.env.KLEROS_JUROR_HOME || join(homedir(), ".kleros-juror");
const raw = readFileSync(join(home, "key"), "utf8").trim();

let pk;
try {
  // Raw hex private key (with or without 0x prefix)
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

const account = privateKeyToAccount(pk);
// Print ONLY public information:
console.log(account.address);
