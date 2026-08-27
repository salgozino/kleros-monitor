#!/usr/bin/env node
// stake-court34.mjs — one-time helper to stake PNK into Kleros Court 34
// (Agentic Commerce Court) on Arbitrum One. NOT a generic tool: hardcoded to
// this specific operation because it's a rare, high-stakes, one-shot action.
//
// Two steps, run in order:
//   1) PNK.approve(KlerosCore, amount)   — only if current allowance < amount
//   2) KlerosCore.setStake(34, amount)
//
// SAFETY:
//   - Simulates (eth_call / viem `simulateContract`) by default. Nothing is
//     broadcast unless --broadcast is passed explicitly.
//   - The private key is read from ~/.kleros-juror/key and used ONLY to
//     construct a viem account object; it is never printed, logged, or
//     included in any output.
//   - Reads current allowance/stake/phase before acting so a re-run after a
//     partial failure doesn't double-approve or double-stake.
//
// Usage:
//   node stake-court34.mjs --amount 11000              (simulate only)
//   node stake-court34.mjs --amount 11000 --broadcast   (actually send)

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const VIEM = "/usr/local/lib/node_modules/kleros-juror-cli/node_modules/viem";
const {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  encodeFunctionData,
} = require(VIEM);
const { privateKeyToAccount } = require(`${VIEM}/accounts`);
const { arbitrum } = require(`${VIEM}/chains`);

const RPC_URL = "https://arb1.arbitrum.io/rpc";
const PNK = "0x330bD769382cFc6d50175903434CCC8D206DCAE5";
const CORE = "0x991d2df165670b9cac3B022f4B68D65b664222ea";
const SORT = "0x21A9402aDb818744B296e1d1BE58C804118DC03D";
const COURT_ID = 34n;
const KEY_PATH = "/root/.kleros-juror/key";

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
];
const CORE_ABI = [
  { type: "function", name: "setStake", stateMutability: "nonpayable",
    inputs: [{ name: "_courtID", type: "uint96" }, { name: "_newStake", type: "uint256" }],
    outputs: [] },
];
const SORT_ABI = [
  { type: "function", name: "phase", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

function parseArgs(argv) {
  const out = { broadcast: false, amount: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--broadcast") out.broadcast = true;
    else if (argv[i] === "--amount") out.amount = argv[++i];
  }
  return out;
}

async function main() {
  const { broadcast, amount } = parseArgs(process.argv.slice(2));
  if (!amount) {
    console.error(JSON.stringify({ ok: false, error: "missing --amount <PNK whole units>" }));
    process.exit(1);
  }
  const stakeAmount = parseUnits(amount, 18);

  // Key is read once, used to build the account, never logged.
  const rawKey = readFileSync(KEY_PATH, "utf8").trim();
  const account = privateKeyToAccount(rawKey);

  const publicClient = createPublicClient({ chain: arbitrum, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: arbitrum, transport: http(RPC_URL) });

  const [pnkBalance, allowance, phase] = await Promise.all([
    publicClient.readContract({ address: PNK, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: PNK, abi: ERC20_ABI, functionName: "allowance", args: [account.address, CORE] }),
    publicClient.readContract({ address: SORT, abi: SORT_ABI, functionName: "phase" }),
  ]);

  const report = {
    juror: account.address,
    pnkBalance: formatUnits(pnkBalance, 18),
    currentAllowance: formatUnits(allowance, 18),
    requestedStake: formatUnits(stakeAmount, 18),
    sortitionPhase: Number(phase),
    phaseIsStaking: Number(phase) === 0,
    broadcast,
    steps: [],
  };

  if (pnkBalance < stakeAmount) {
    report.error = "Insufficient PNK balance for requested stake amount.";
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // Step 1: approve, only if needed.
  if (allowance < stakeAmount) {
    const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [CORE, stakeAmount] });
    if (!broadcast) {
      const sim = await publicClient.call({ account: account.address, to: PNK, data: approveData });
      report.steps.push({ step: "approve", simulated: true, ok: true, raw: sim.data ?? null });
    } else {
      const hash = await walletClient.writeContract({ address: PNK, abi: ERC20_ABI, functionName: "approve", args: [CORE, stakeAmount] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      report.steps.push({ step: "approve", broadcast: true, txHash: hash, status: receipt.status });
      if (receipt.status !== "success") {
        report.error = "approve transaction reverted";
        console.log(JSON.stringify(report, null, 2));
        process.exit(1);
      }
    }
  } else {
    report.steps.push({ step: "approve", skipped: true, reason: "allowance already sufficient" });
  }

  // Step 2: setStake. Only actually send if not doing a dry (or approve-only) run
  // in simulate mode we still simulate setStake so the caller sees the full plan.
  const setStakeArgs = [COURT_ID, stakeAmount];
  if (!broadcast) {
    try {
      const sim = await publicClient.simulateContract({
        account: account.address, address: CORE, abi: CORE_ABI, functionName: "setStake", args: setStakeArgs,
      });
      report.steps.push({ step: "setStake", simulated: true, ok: true });
    } catch (err) {
      report.steps.push({ step: "setStake", simulated: true, ok: false, error: String(err?.shortMessage || err?.message || err) });
    }
  } else {
    const hash = await walletClient.writeContract({ address: CORE, abi: CORE_ABI, functionName: "setStake", args: setStakeArgs });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    report.steps.push({ step: "setStake", broadcast: true, txHash: hash, status: receipt.status });
    if (receipt.status !== "success") {
      report.error = "setStake transaction reverted";
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.shortMessage || err?.message || err) }));
  process.exit(1);
});
