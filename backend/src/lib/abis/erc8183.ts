// ERC-8183 (Agentic Commerce Protocol) — view + write functions in use.
// Full interface in EIP-8183.

export const erc8183Abi = [
  {
    type: 'function',
    name: 'jobCounter',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'paymentToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'platformFeeBP',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'evaluatorFeeBP',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'platformTreasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'createJob',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'provider', type: 'address' },
      { name: 'evaluator', type: 'address' },
      { name: 'expiredAt', type: 'uint256' },
      { name: 'description', type: 'string' },
      { name: 'hook', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setBudget',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'fund',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'submit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'deliverable', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'complete',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'reason', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reject',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'reason', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimRefund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getJob',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'client', type: 'address' },
          { name: 'provider', type: 'address' },
          { name: 'evaluator', type: 'address' },
          { name: 'description', type: 'string' },
          { name: 'budget', type: 'uint256' },
          { name: 'expiredAt', type: 'uint256' },
          { name: 'status', type: 'uint8' },
          { name: 'hook', type: 'address' },
        ],
      },
    ],
  },
] as const;

// JobStatus enum order from EIP-8183: Open(0), Funded(1), Submitted(2), Completed(3), Rejected(4), Expired(5)
export const JOB_STATUS = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'] as const;

// JobCreated event — parsed from tx receipts to find the actual jobId we created
export const jobCreatedEvent = {
  type: 'event',
  name: 'JobCreated',
  inputs: [
    { name: 'jobId', type: 'uint256', indexed: true },
    { name: 'client', type: 'address', indexed: true },
    { name: 'provider', type: 'address', indexed: true },
    { name: 'evaluator', type: 'address' },
    { name: 'expiredAt', type: 'uint256' },
    { name: 'hook', type: 'address' },
  ],
} as const;

// JobFunded — emitted by fund(); carries the locked amount, not a hash.
// Indexer treats the `amount` as the row's payload (amount_raw column);
// hash_value stays empty for these rows.
export const jobFundedEvent = {
  type: 'event',
  name: 'JobFunded',
  inputs: [
    { name: 'jobId', type: 'uint256', indexed: true },
    { name: 'client', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

// Refunded — emitted when claimRefund() returns the locked budget to the
// client after the deadline. `client` is the recipient (indexed); the
// actual caller can be anyone (permissionless) so we record the recipient
// in `actor` and rely on the label to disambiguate semantics. Same
// payload shape as JobFunded — amount goes into amount_raw, hash empty.
export const jobRefundedEvent = {
  type: 'event',
  name: 'Refunded',
  inputs: [
    { name: 'jobId', type: 'uint256', indexed: true },
    { name: 'client', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

// Lifecycle events carrying the bytes32 commitments — indexer picks these up
// so the frontend can show the on-chain hash without re-scanning logs.
export const jobSubmittedEvent = {
  type: 'event',
  name: 'JobSubmitted',
  inputs: [
    { name: 'jobId', type: 'uint256', indexed: true },
    { name: 'provider', type: 'address', indexed: true },
    { name: 'deliverable', type: 'bytes32' },
  ],
} as const;

export const jobCompletedEvent = {
  type: 'event',
  name: 'JobCompleted',
  inputs: [
    { name: 'jobId', type: 'uint256', indexed: true },
    { name: 'evaluator', type: 'address', indexed: true },
    { name: 'reason', type: 'bytes32' },
  ],
} as const;

export const jobRejectedEvent = {
  type: 'event',
  name: 'JobRejected',
  inputs: [
    { name: 'jobId', type: 'uint256', indexed: true },
    { name: 'rejector', type: 'address', indexed: true },
    { name: 'reason', type: 'bytes32' },
  ],
} as const;
