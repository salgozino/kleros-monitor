// Shared IPFS fetch helper — fetchIpfs with gateway fallback.
// Gateway order preserved from dossier-builder.mjs.

import { writeFileSync } from "node:fs";
import { IPFS_GATEWAYS } from "../config.mjs";

export async function fetchIpfs(cid, destPath) {
  for (const gw of IPFS_GATEWAYS) {
    try {
      const res = await fetch(gw + cid, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(destPath, buf);
      return buf.length;
    } catch { /* next gateway */ }
  }
  return 0;
}
