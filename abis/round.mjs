// KlerosCore getRoundInfo ABI — used to decode round data for a dispute.
export default [{
  type: "function", name: "getRoundInfo", stateMutability: "view",
  inputs: [{ type: "uint256" }, { type: "uint256" }],
  outputs: [{
    name: "", type: "tuple", components: [
      { name: "disputeKitID", type: "uint256" },
      { name: "pnkAtStakePerJuror", type: "uint256" },
      { name: "totalFeesForJurors", type: "uint256" },
      { name: "nbVotes", type: "uint256" },
      { name: "repartitions", type: "uint256" },
      { name: "pnkPenalties", type: "uint256" },
      { name: "drawnJurors", type: "address[]" },
      { name: "sumFeeRewardPaid", type: "uint256" },
      { name: "sumPnkRewardPaid", type: "uint256" },
      { name: "feeToken", type: "address" },
      { name: "drawIterations", type: "uint256" },
    ],
  }],
}];
