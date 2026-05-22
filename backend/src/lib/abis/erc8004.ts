// ERC-8004 (Trustless Agents — Identity, Reputation, Validation registries).
// Only the bits we consume here: read-side ReputationRegistry surface +
// minimal IdentityRegistry methods to verify ownership when a user claims
// an agentId. Writing feedback (giveFeedback / revokeFeedback) is done
// externally; we only read.

export const reputationRegistryAbi = [
  {
    type: 'function',
    name: 'getIdentityRegistry',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  // Aggregated rollup across the supplied clients + tag filters. Pass
  // empty strings for tag1/tag2 to skip filtering. count fits in uint64;
  // summaryValue is a signed fixed-point int128 with valueDecimals.
  {
    type: 'function',
    name: 'getSummary',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
  // Every (client, feedbackIndex) tuple for the agent, with optional tag
  // filter and a flag for whether to include revoked entries. Returns 7
  // parallel arrays — viem packs them into a tuple of arrays in the same
  // declaration order as the outputs.
  {
    type: 'function',
    name: 'readAllFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'includeRevoked', type: 'bool' },
    ],
    outputs: [
      { name: 'clients', type: 'address[]' },
      { name: 'feedbackIndexes', type: 'uint64[]' },
      { name: 'values', type: 'int128[]' },
      { name: 'valueDecimals', type: 'uint8[]' },
      { name: 'tag1s', type: 'string[]' },
      { name: 'tag2s', type: 'string[]' },
      { name: 'revokedStatuses', type: 'bool[]' },
    ],
  },
  {
    type: 'function',
    name: 'getClients',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getLastIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
    ],
    outputs: [{ type: 'uint64' }],
  },
] as const;

// IdentityRegistry — only the ownership accessors we need to verify a user
// is allowed to claim a given agentId. The registry is itself an ERC-721,
// so ownerOf works alongside the agent-specific helpers.
export const identityRegistryAbi = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  // Optional override that delegates an agent's on-chain operations to a
  // wallet other than the ERC-721 owner. Returns the zero address when
  // unset; callers should treat zero as "fall back to ownerOf".
  {
    type: 'function',
    name: 'getAgentWallet',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
] as const;
