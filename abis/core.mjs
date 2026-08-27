// KlerosCore ABI subset — setStake.
export default [
  { type: "function", name: "setStake", stateMutability: "nonpayable",
    inputs: [{ name: "_courtID", type: "uint96" }, { name: "_newStake", type: "uint256" }],
    outputs: [] },
];
