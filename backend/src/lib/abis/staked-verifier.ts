// StakedVerifierModule (Arm 2) — the slice the backend encodes calldata for and
// reads. Write fns are encoded for /unsigned builders (client-signed) except
// assignPanel, which the operator signs via createContractExecutionTransaction.
export const stakedVerifierAbi = [
  // writes
  { type: 'function', name: 'stake', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'unstake', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'fundVerification', stateMutability: 'nonpayable', inputs: [{ name: 'tradeId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'vote', stateMutability: 'nonpayable', inputs: [{ name: 'tradeId', type: 'uint256' }, { name: 'pass', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'resolveTimeout', stateMutability: 'nonpayable', inputs: [{ name: 'tradeId', type: 'uint256' }], outputs: [] },
  // reads
  { type: 'function', name: 'panelSize', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'feeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'slashBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'bondBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'minStake', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'voteWindow', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'verifierCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'stakeOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'lockedOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'correctVotes', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'totalVotes', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'feePrepaid', stateMutability: 'view', inputs: [{ name: 'tradeId', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'panelOf', stateMutability: 'view', inputs: [{ name: 'tradeId', type: 'uint256' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'voteOf', stateMutability: 'view', inputs: [{ name: 'tradeId', type: 'uint256' }, { name: 'verifier', type: 'address' }], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'verificationOf',
    stateMutability: 'view',
    inputs: [{ name: 'tradeId', type: 'uint256' }],
    outputs: [
      { name: 'assigned', type: 'bool' },
      { name: 'resolved', type: 'bool' },
      { name: 'deadline', type: 'uint64' },
      { name: 'passes', type: 'uint8' },
      { name: 'fails', type: 'uint8' },
      { name: 'cast', type: 'uint8' },
      { name: 'fee', type: 'uint256' },
    ],
  },
  // events (for the verifier stake/unstake indexer)
  { type: 'event', name: 'Staked', inputs: [{ name: 'verifier', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Unstaked', inputs: [{ name: 'verifier', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
] as const;
