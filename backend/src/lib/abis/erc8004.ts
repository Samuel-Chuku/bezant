// ERC-8004 (Trustless Agents - Identity, Reputation, Validation registries).
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
  // parallel arrays - viem packs them into a tuple of arrays in the same
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
  // Write side: leave feedback for an agent. Permissionless per EIP-8004 (the
  // submitter just MUST NOT be the agent's owner/operator). value +1/-1 with
  // valueDecimals 0 = a thumbs up/down; tag1 namespaces the source.
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

// IdentityRegistry - ownership accessors for the link verification path
// plus the no-arg `register()` overload for M32 self-registration. The
// registry is itself an ERC-721, so ownerOf works alongside the
// agent-specific helpers, and registration mints a new token that emits
// the standard ERC-721 Transfer event with `from = 0x0`.
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
  // The no-arg register() overload - simplest entrypoint. Caller becomes
  // the owner of the newly-minted ERC-721 token; the agentId is assigned
  // incrementally by the registry. We can't read the return value off a
  // sent tx, so we parse the Transfer event from the receipt instead.
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

// Standard ERC-721 Transfer event - used to extract the agentId from a
// register() tx receipt. On mint, `from` is address(0) and `tokenId` is
// the freshly-assigned agentId.
export const erc721TransferEvent = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
  ],
} as const;
