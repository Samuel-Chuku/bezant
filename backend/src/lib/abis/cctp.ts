// CCTP V2 MessageTransmitter MessageReceived event — emitted on the
// destination chain when a cross-chain message is delivered. Pairs with a
// USDC mint Transfer event in the same tx; the indexer joins the two by
// tx hash to attach sourceDomain to bridge-inbound history rows.
//
// Reference: https://developers.circle.com/stablecoins/cctp-getting-started
export const cctpMessageReceivedEvent = {
  type: 'event',
  name: 'MessageReceived',
  inputs: [
    { name: 'caller', type: 'address', indexed: true },
    { name: 'sourceDomain', type: 'uint32', indexed: false },
    { name: 'nonce', type: 'bytes32', indexed: true },
    { name: 'sender', type: 'bytes32', indexed: false },
    { name: 'finalityThresholdExecuted', type: 'uint32', indexed: false },
    { name: 'messageBody', type: 'bytes', indexed: false },
  ],
} as const;
