import { createPublicClient, http } from 'viem';

const ARC_RPC_URL = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';

export const arcClient = createPublicClient({
  transport: http(ARC_RPC_URL),
});
