// Draw event ABI — used to encode topic filters for eth_getLogs.
export default [{
  type: "event",
  name: "Draw",
  inputs: [
    { name: "_address", type: "address", indexed: true },
    { name: "_disputeID", type: "uint256", indexed: true },
    { name: "_roundID", type: "uint256" },
    { name: "_voteID", type: "uint256" },
  ],
}];
