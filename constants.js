// Computes event topic + function selectors needed by the monitor (constants).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const viemPath = "/usr/local/lib/node_modules/kleros-juror-cli/node_modules/viem";
const { keccak256, stringToHex, encodeEventTopics, pad } = require(viemPath);

const DRAW_SIG = "Draw(address,uint256,uint256,uint256)";
console.log("TOPIC_DRAW =", keccak256(stringToHex(DRAW_SIG)));

const JUROR = "0x606D2DD4Ca178349b327Ed7ACacf68058bd748Bc";
const topics = encodeEventTopics({
  abi: [{
    type: "event",
    name: "Draw",
    inputs: [
      { name: "_address", type: "address", indexed: true },
      { name: "_disputeID", type: "uint256", indexed: true },
      { name: "_roundID", type: "uint256" },
      { name: "_voteID", type: "uint256" },
    ],
  }],
  args: { _address: JUROR }, // leave dispute wildcard
});
console.log("topics filter =", JSON.stringify(topics));

const sel = keccak256(stringToHex("getRoundInfo(uint256,uint256)")).slice(0, 10);
console.log("SELECTOR_GETROUNDINFO =", sel);

const sel2 = keccak256(stringToHex("numberOfRounds(uint256)")).slice(0, 10);
console.log("SELECTOR_NUMBEROFROUNDS =", sel2);
