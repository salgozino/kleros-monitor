#!/usr/bin/env node
// dossier-builder.mjs — deterministic (NO LLM) evidence extraction for a dispute.
// Called by the cron agent (or manually) when we are drawn in a case:
//   node dossier-builder.mjs <disputeID> <roundID>
//
// Pipeline:
//   1. Read the dispute template + evidence URIs from on-chain events.
//   2. Download IPFS artifacts (template JSON, evidence files incl. PDFs).
//   3. Extract text from PDFs/images metadata into plain-text chunks.
//   4. Write /root/kleros-monitor/dossiers/<dispute>-r<round>/ with:
//        template.json     - resolution criteria, options, policy
//        evidence/         - raw downloaded files
//        chunks/chunk-NNN.txt - ~4000-char text pieces for LLM ticks
//        manifest.json     - what was extracted, chunk count, sources
//
// Everything here is mechanical: no reasoning, no token cost. The 1-hour
// script timeout of Hermes cron covers even huge PDFs comfortably.

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { statSync as fsStatSync } from "node:fs";

import { CORE, DISPUTERESOLVER, DRT, RPC_URLS, IPFS_GATEWAYS, WORKDIR, EVIDENCE_CHAIN } from "./config.mjs";
import { rpcWithRetry, getLogs } from "./helpers/rpc.mjs";
import { fetchIpfs } from "./helpers/ipfs.mjs";
import { sleep } from "./helpers/utils.mjs";

const DOSSIER_DIR = `${WORKDIR}/dossiers`;

// Extract text from a file based on its type. Returns { text, meta } or null.
function extractText(filePath, mime) {
  const head = readFileSync(filePath).subarray(0, 16);
  const isPdf = head.subarray(0, 4).toString() === "%PDF";
  const isPng = head[0] === 0x89 && head[1] === 0x50;
  const isJpg = head[0] === 0xff && head[1] === 0xd8;

  if (isPdf || filePath.endsWith(".pdf")) {
    // pdftotext ships with poppler-utils; fall back to python pymupdf.
    try {
      const txt = execFileSync("pdftotext", ["-layout", filePath, "-"], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
      return { text: txt.toString(), extractor: "pdftotext" };
    } catch {
      try {
        const py = `import fitz,sys;d=fitz.open(sys.argv[1]);print("\\n".join(p.get_text() for p in d))`;
        const txt = execFileSync("python3", ["-c", py, filePath], { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
        return { text: txt.toString(), extractor: "pymupdf" };
      } catch (e2) {
        return { text: `[PDF binary, ${filePath}: text extraction failed (${e2.message.slice(0, 80)})]`, extractor: "failed" };
      }
    }
  }
  if ((isPng || isJpg) && mime?.startsWith("image")) {
    // Images can't be text-extracted here; note them so the agent knows to
    // look at the original URI if needed (vision analysis is out of scope).
    const kb = Math.ceil(fsStatSync(filePath).size / 1024);
    return { text: `[image file ${filePath}, ${kb} KB - see original at the listed URI]`, extractor: "image-note" };
  }
  // Try as text
  try {
    const txt = readFileSync(filePath, "utf8");
    // Heuristic: mostly printable?
    const sample = txt.slice(0, 2000);
    const printable = [...sample].filter((c) => c.charCodeAt(0) >= 32 || c === "\n").length / Math.max(1, sample.length);
    if (printable > 0.9) return { text: txt, extractor: "utf8" };
  } catch {}
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const [disputeID, roundArg] = argv;
  if (!disputeID) { console.error("usage: dossier-builder.mjs <disputeID> [round]"); process.exit(1); }

  const dir = `${DOSSIER_DIR}/${disputeID}-r${roundArg ?? 0}`;
  mkdirSync(`${dir}/evidence`, { recursive: true });
  mkdirSync(`${dir}/chunks`, { recursive: true });

  const manifest = { disputeID, round: Number(roundArg ?? 0), builtAt: new Date().toISOString(), sources: [], files: [], warnings: [] };

  // ---- 1. Template: find the dispute CREATION tx via DisputeCreation event
  // (the Draw event fires in a later tx; the template lives in the creation
  // receipt, as observed on dispute #163).
  const headHex = await rpcWithRetry("eth_blockNumber", []);
  const head = parseInt(headHex, 16);
  const fromBlock = "0x" + Math.max(0, head - 3_000_000).toString(16); // ~10 days

  const DISPUTE_CREATION_TOPIC = "0x141dfc18aa6a56fc816f44f0e9e2f1ebc92b15ab167770e17db5b084c10ed995"; // keccak(DisputeCreation(uint256,address))
  const creationLogs = await getLogs({
    address: CORE,
    topics: [DISPUTE_CREATION_TOPIC, "0x" + BigInt(disputeID).toString(16).padStart(64, "0")],
    fromBlock,
    toBlock: "latest",
  });
  if (!creationLogs.length) { console.error(`no creation event found for dispute ${disputeID} in last ~10 days`); process.exit(2); }
  const txHash = creationLogs[0].transactionHash;

  const receipt = await rpcWithRetry("eth_getTransactionReceipt", [txHash]);
  manifest.sources.push({ type: "creationTx", hash: txHash });

  // NewTemplate(uint256 indexed _templateId, address indexed owner, string tag, string data)
  const NEW_TEMPLATE_TOPIC = "0x00f7cd7255d1073b4e136dd477c38ea0020c051ab17110cc5bfab0c840ff9924";
  const tplLog = (receipt.logs || []).find((l) => l.address.toLowerCase() === DRT.toLowerCase() && l.topics[0] === NEW_TEMPLATE_TOPIC);
  if (tplLog) {
    const d = Buffer.from(tplLog.data.replace(/^0x/, ""), "hex");
    const offTag = Number(BigInt("0x" + d.subarray(0, 32).toString("hex")));
    const offData = Number(BigInt("0x" + d.subarray(32, 64).toString("hex")));
    const readStr = (off) => {
      const len = Number(BigInt("0x" + d.subarray(off, off + 32).toString("hex")));
      return d.subarray(off + 32, off + 32 + len).toString("utf8");
    };
    const s1 = readStr(offTag);
    const s2 = offData ? readStr(offData) : "";
    // Field order varies by registry version: pick whichever string parses as
    // a JSON template (has "question"); fall back to the non-empty one.
    let parsed = null;
    for (const cand of [s1, s2]) {
      try {
        const p = JSON.parse(cand);
        if (p && typeof p === "object" && ("question" in p || "title" in p || "answers" in p)) { parsed = p; break; }
      } catch {}
    }
    writeFileSync(`${dir}/template.json`, JSON.stringify(parsed ?? (s1.length >= s2.length ? s1 : s2), null, 2));
    // The other string (or empty) is the human tag.
    writeFileSync(`${dir}/template-tag.txt`, s1.length <= s2.length ? s1 : s2);
    manifest.templateId = Number(BigInt(tplLog.topics[1]));
    manifest.files.push({ path: "template.json", kind: "resolution-criteria" });
  } else {
    manifest.warnings.push("NewTemplate event not found in creation receipt — template must be fetched manually");
  }

  // Evidence: use the Kleros Agent Kit (`kleros evidence list`), which resolves
  // evidence submissions + their IPFS CIDs for a dispute correctly across
  // resolvers. The previous hand-rolled event scraping matched no events on
  // this resolver and always returned zero evidence files.
  const cidFromUri = (u) => {
    const m = String(u || "").match(/(?:ipfs:\/\/|ipfs\/)?(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{20,})/);
    return m ? m[1] : null;
  };
  let evItems = [];
  try {
    let cursor = null;
    do {
      const args = ["evidence", "list", "--chain", EVIDENCE_CHAIN, "--dispute", String(disputeID), "--format", "json", "--limit", "100"];
      if (cursor) args.push("--cursor", cursor);
      const out = execFileSync("kleros", args, { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }).toString();
      const parsed = JSON.parse(out);
      evItems = evItems.concat(parsed.items || []);
      cursor = parsed.hasMore ? parsed.nextCursor : null;
    } while (cursor);
  } catch (e) {
    manifest.warnings.push(`kleros evidence list failed: ${String(e.message || e).slice(0, 160)}`);
  }
  let idx = 0;
  for (const it of evItems) {
    // The actual attachment/file (PDF, image, etc.) lives in fileUri/attachedUri.
    const fileCid = cidFromUri(it.fileUri || it.attachedUri);
    if (fileCid) {
      const fname = `${dir}/evidence/ev-${String(idx++).padStart(3, "0")}-${fileCid.slice(0, 10)}`;
      const size = await fetchIpfs(fileCid, fname);
      manifest.sources.push({ type: "evidence", cid: fileCid, bytes: size, uri: it.fileUri, title: it.title, description: it.description, disputeEvidenceId: it.id });
      if (!size) manifest.warnings.push(`could not fetch evidence CID ${fileCid}`);
      await sleep(300);
    }
    // The evidence document itself (ERC-1497 JSON), when distinct from the file.
    const docCid = cidFromUri(it.uri);
    if (docCid && docCid !== fileCid) {
      const fname = `${dir}/evidence/ev-${String(idx++).padStart(3, "0")}-${docCid.slice(0, 10)}`;
      const size = await fetchIpfs(docCid, fname);
      manifest.sources.push({ type: "evidence-doc", cid: docCid, bytes: size, uri: it.uri, title: it.title });
      if (!size) manifest.warnings.push(`could not fetch evidence doc CID ${docCid}`);
      await sleep(300);
    }
  }

  // ---- 4. Chunking (~4000 chars each) -------------------------------------
  let chunkIdx = 0;
  const CHUNK = 4000;
  const texts2 = [];

  // Template goes FIRST so the agent reads resolution criteria before evidence.
  try {
    const tpl = readFileSync(`${dir}/template.json`, "utf8");
    if (tpl.trim() && tpl !== '""') texts2.push({ file: "template.json (CRITERIOS DE RESOLUCIÓN - LEER PRIMERO)", extractor: "json", text: tpl });
  } catch {}

  // Policy URI from the template (court policy).
  try {
    const parsed = JSON.parse(readFileSync(`${dir}/template.json`, "utf8"));
    const m = (parsed.policyURI || "").match(/(?:ipfs:\/\/|\/ipfs\/)?(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{20,})/);
    if (m) {
      const psize = await fetchIpfs(m[1], `${dir}/evidence/policy-${m[1].slice(0, 10)}`);
      manifest.sources.push({ type: "policy", cid: m[1], bytes: psize });
      if (!psize) manifest.warnings.push(`could not fetch policy CID ${m[1]}`);
    }
  } catch {}

  for (const f of readdirSync(`${dir}/evidence`)) {
    const p = `${dir}/evidence/${f}`;
    if (!statSync(p).isFile()) continue;
    const res = extractText(p);
    if (res) texts2.push({ file: f, ...res });
  }

  for (const t of texts2) {
    if ((t.extractor === "failed" || !t.text || !t.text.trim())) { manifest.warnings.push(`no text extracted from ${t.file}`); continue; }
    const header = `\n===== SOURCE: ${t.file} (${t.extractor}) =====\n`;
    const body = header + t.text;
    for (let i = 0; i < body.length; i += CHUNK) {
      writeFileSync(`${dir}/chunks/chunk-${String(chunkIdx).padStart(3, "0")}.txt`,
        `chunk ${chunkIdx} | source ${t.file} | part ${Math.floor(i / CHUNK) + 1}\n\n${body.slice(i, i + CHUNK)}`);
      chunkIdx++;
    }
  }
  manifest.chunkCount = chunkIdx;

  writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));

  // stdout: compact summary for the agent
  console.log(JSON.stringify({
    ok: true,
    dir,
    chunks: chunkIdx,
    evidenceFiles: manifest.sources.filter((s) => s.type === "evidence").length,
    hasTemplate: !!tplLog,
    warnings: manifest.warnings,
  }, null, 2));
}

// Standalone execution guard — runs when invoked directly via `node dossier-builder.mjs`.
if (import.meta.url === new URL(process.argv[1], "file://").href) {
  main(process.argv.slice(2)).catch((e) => { console.error("dossier-builder error:", e.message || e); process.exit(1); });
}
