// Circle Gateway settlement - the optional cross-chain seller payout.
//
// The escrow always pays the seller on Arc (unchanged). When a seller chooses a
// different chain, they route their just-received USDC there via Gateway. The
// PRIMARY path is external-wallet / client-signed: the backend builds the burn
// intent + plan, the seller's own wallet signs (approve, deposit, EIP-712), and
// the backend relays the destination mint (permissionless). A dev-controlled
// helper (routePayoutViaGateway) exists only for the backend smoke.
//
// Proven end-to-end in scripts/gateway-poc.ts + gateway-poc-operator.ts.
import {
  createPublicClient,
  createWalletClient,
  http,
  pad,
  zeroAddress,
  maxUint256,
  parseUnits,
  formatUnits,
  getAddress,
  type Address,
  type Hex,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import { sepolia, optimismSepolia, arbitrumSepolia, baseSepolia, avalancheFuji } from 'viem/chains';
import { arcClient, USDC_ADDRESS as ARC_USDC } from './arc.js';

export const GATEWAY_API = process.env.GATEWAY_API_BASE_URL ?? 'https://gateway-api-testnet.circle.com/v1';
// Deterministic Gateway contract addresses - same on every supported chain.
export const GATEWAY_WALLET = getAddress('0x0077777d7EBA4688BDeF3E311b846F25870A19B9');
export const GATEWAY_MINTER = getAddress('0x0022222ABE238Cc2C7Bb1f21003F0a260052475B');
export const ARC_DOMAIN = 26;

// Fee handling: the Gateway fee is charged ON TOP of the delivered value (≈0.02
// USDC observed on testnet). To deliver exactly `amount`, the unified balance
// must cover `amount + maxFee`, so we deposit that and cap the fee here.
const MAX_FEE = parseUnits('0.1', 6); // generous ceiling; actual fee far smaller

// Destination registry - chains we can service (USDC address + RPC via the viem
// chain + a relayer with gas). Mirrors the EVM testnets in the frontend bridge
// config. Add a row (and fund the relayer there) to offer more.
export type GatewayDestination = { key: string; name: string; domain: number; chainId: number; usdc: Address; chain: Chain };
export const GATEWAY_DESTINATIONS: GatewayDestination[] = [
  { key: 'baseSepolia', name: 'Base Sepolia', domain: 6, chainId: baseSepolia.id, usdc: getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e'), chain: baseSepolia },
  { key: 'avalancheFuji', name: 'Avalanche Fuji', domain: 1, chainId: avalancheFuji.id, usdc: getAddress('0x5425890298aed601595a70AB815c96711a31Bc65'), chain: avalancheFuji },
  { key: 'arbitrumSepolia', name: 'Arbitrum Sepolia', domain: 3, chainId: arbitrumSepolia.id, usdc: getAddress('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'), chain: arbitrumSepolia },
  { key: 'optimismSepolia', name: 'OP Sepolia', domain: 2, chainId: optimismSepolia.id, usdc: getAddress('0x5fd84259d66Cd46123540766Be93DFE6D43130D7'), chain: optimismSepolia },
  { key: 'sepolia', name: 'Ethereum Sepolia', domain: 0, chainId: sepolia.id, usdc: getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'), chain: sepolia },
];

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const GATEWAY_MINTER_ABI = [
  { type: 'function', name: 'gatewayMint', stateMutability: 'nonpayable', inputs: [{ name: 'attestationPayload', type: 'bytes' }, { name: 'signature', type: 'bytes' }], outputs: [] },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addressToBytes32 = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });
const destByKey = (key: string) => {
  const d = GATEWAY_DESTINATIONS.find((x) => x.key === key);
  if (!d) throw new Error(`Unknown destination '${key}'. Supported: ${GATEWAY_DESTINATIONS.map((x) => x.key).join(', ')}`);
  return d;
};
const destByDomain = (domain: number) => GATEWAY_DESTINATIONS.find((x) => x.domain === domain);

// EIP-712 type set for burn intents (viem/client shape - EIP712Domain omitted;
// viem derives it from `domain`). Circle's signTypedData wants EIP712Domain
// included, so the dev-controlled helper adds it inline below.
const BURN_INTENT_TYPES = {
  TransferSpec: [
    { name: 'version', type: 'uint32' }, { name: 'sourceDomain', type: 'uint32' }, { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' }, { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' }, { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' }, { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' }, { name: 'salt', type: 'bytes32' }, { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [{ name: 'maxBlockHeight', type: 'uint256' }, { name: 'maxFee', type: 'uint256' }, { name: 'spec', type: 'TransferSpec' }],
} as const;
const EIP712_DOMAIN = { name: 'GatewayWallet', version: '1' } as const;

// Burn-intent message with all numeric values as strings (JSON-safe; both viem
// and Gateway hash the equivalent uints identically).
function buildBurnIntentMessage(opts: { destination: GatewayDestination; depositor: Address; recipient: Address; amountAtomic: bigint }) {
  return {
    maxBlockHeight: maxUint256.toString(),
    maxFee: MAX_FEE.toString(),
    spec: {
      version: 1, sourceDomain: ARC_DOMAIN, destinationDomain: opts.destination.domain,
      sourceContract: addressToBytes32(GATEWAY_WALLET), destinationContract: addressToBytes32(GATEWAY_MINTER),
      sourceToken: addressToBytes32(ARC_USDC), destinationToken: addressToBytes32(opts.destination.usdc),
      sourceDepositor: addressToBytes32(opts.depositor), destinationRecipient: addressToBytes32(opts.recipient),
      sourceSigner: addressToBytes32(opts.depositor), destinationCaller: addressToBytes32(zeroAddress),
      value: opts.amountAtomic.toString(), salt: ('0x' + randomBytes(32).toString('hex')) as Hex, hookData: '0x' as Hex,
    },
  };
}
type BurnIntentMessage = ReturnType<typeof buildBurnIntentMessage>;

export function getRelayerAccount() {
  const key = (process.env.GATEWAY_RELAYER_PRIVATE_KEY ?? process.env.GATEWAY_POC_PRIVATE_KEY) as Hex | undefined;
  if (!key) throw new Error('No GATEWAY_RELAYER_PRIVATE_KEY (or GATEWAY_POC_PRIVATE_KEY) set - needed to relay the destination mint.');
  return privateKeyToAccount(key);
}

export async function gatewayUnifiedBalance(depositor: Address, domain = ARC_DOMAIN): Promise<number> {
  const res = await fetch(`${GATEWAY_API}/balances`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ depositor, domain }] }),
  });
  if (!res.ok) throw new Error(`Gateway /balances → HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { balances?: Array<{ domain: number; balance: string }> };
  return parseFloat(data.balances?.find((b) => b.domain === domain)?.balance ?? '0');
}

// Which destinations Gateway currently supports (registry ∩ live /info domains).
export async function listGatewayDestinations(): Promise<Array<GatewayDestination & { supported: boolean }>> {
  const info = (await (await fetch(`${GATEWAY_API}/info`)).json()) as { domains?: Array<{ domain: number }> };
  const live = new Set((info.domains ?? []).map((d) => d.domain));
  return GATEWAY_DESTINATIONS.map((d) => ({ ...d, supported: live.has(d.domain) }));
}

// ── External (client-signed) flow ──────────────────────────────────────────

export type PayoutPlan = {
  destination: { key: string; name: string; domain: number; chainId: number };
  amountUsdc: string;
  recipient: Address;
  contracts: { gatewayWallet: Address; arcUsdc: Address };
  // Current Arc unified balance + whether the seller must deposit first.
  unifiedBalanceUsdc: string;
  needsDeposit: boolean;
  depositUsdc: string; // how much to deposit (0 when the balance already covers it)
  requiredUsdc: string; // amount + fee buffer the balance must reach
  // EIP-712 to sign (viem shape: no EIP712Domain). Numeric values are strings.
  typedData: { domain: typeof EIP712_DOMAIN; types: typeof BURN_INTENT_TYPES; primaryType: 'BurnIntent'; message: BurnIntentMessage };
};

// Build everything the seller's wallet needs to execute the payout: the deposit
// sizing and the burn-intent typed data to sign. The frontend does approve +
// deposit with the seller's wallet, then signs `typedData`, then POSTs the
// message + signature to /payout/submit.
export async function buildPayoutPlan(opts: { depositorAddress: Address; destinationKey: string; recipient: Address; amountUsdc: string }): Promise<PayoutPlan> {
  const dest = destByKey(opts.destinationKey);
  const depositor = getAddress(opts.depositorAddress);
  const recipient = getAddress(opts.recipient);
  const amount = parseUnits(opts.amountUsdc, 6);
  if (amount <= 0n) throw new Error('amountUsdc must be positive');

  const required = amount + MAX_FEE; // unified balance must reach this to transfer `amount`
  const unified = await gatewayUnifiedBalance(depositor);
  const unifiedAtomic = parseUnits(unified.toFixed(6), 6);
  const needsDeposit = unifiedAtomic < required;
  const depositAtomic = needsDeposit ? required - unifiedAtomic : 0n;

  const message = buildBurnIntentMessage({ destination: dest, depositor, recipient, amountAtomic: amount });
  return {
    destination: { key: dest.key, name: dest.name, domain: dest.domain, chainId: dest.chainId },
    amountUsdc: opts.amountUsdc,
    recipient,
    contracts: { gatewayWallet: GATEWAY_WALLET, arcUsdc: ARC_USDC },
    unifiedBalanceUsdc: unified.toString(),
    needsDeposit,
    depositUsdc: formatUnits(depositAtomic, 6),
    requiredUsdc: formatUnits(required, 6),
    typedData: { domain: EIP712_DOMAIN, types: BURN_INTENT_TYPES, primaryType: 'BurnIntent', message },
  };
}

export type GatewayPayoutResult = {
  destination: { key: string; name: string; domain: number };
  recipient: Address;
  attestationId?: string;
  mintTxHash: string;
  mintTxUrl?: string;
  recipientBefore: string;
  recipientAfter: string;
  deliveredUsdc: string;
};

// Submit a signed burn intent: get the attestation from Gateway, relay the mint
// on the destination (chosen from the message), confirm the recipient is paid.
export async function submitTransferAndRelayMint(message: BurnIntentMessage, signature: Hex): Promise<GatewayPayoutResult> {
  const dest = destByDomain(message.spec.destinationDomain);
  if (!dest) throw new Error(`Unsupported destinationDomain ${message.spec.destinationDomain}`);
  const recipient = getAddress(('0x' + message.spec.destinationRecipient.slice(-40)) as Hex);

  const relayer = getRelayerAccount();
  const dstPublic = createPublicClient({ chain: dest.chain, transport: http() });
  const dstWallet = createWalletClient({ account: relayer, chain: dest.chain, transport: http() });
  if ((await dstPublic.getBalance({ address: relayer.address })) === 0n) {
    throw new Error(`Relayer ${relayer.address} has no gas on ${dest.name} to submit the mint.`);
  }

  const tRes = await fetch(`${GATEWAY_API}/transfer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ burnIntent: message, signature }]),
  });
  const tText = await tRes.text();
  if (!tRes.ok) throw new Error(`Gateway /transfer → HTTP ${tRes.status}: ${tText}`);
  const transfer = JSON.parse(tText) as { attestation: Hex; signature: Hex; transferId?: string };

  const before = (await dstPublic.readContract({ address: dest.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] })) as bigint;
  const mintTx = await dstWallet.writeContract({ address: GATEWAY_MINTER, abi: GATEWAY_MINTER_ABI, functionName: 'gatewayMint', args: [transfer.attestation, transfer.signature] });
  const receipt = await dstPublic.waitForTransactionReceipt({ hash: mintTx });
  if (receipt.status !== 'success') throw new Error(`gatewayMint reverted on ${dest.name} (${mintTx}).`);

  let after = before;
  for (let i = 0; i < 10 && after <= before; i++) {
    await sleep(2_000);
    after = (await dstPublic.readContract({ address: dest.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] })) as bigint;
  }
  if (after <= before) throw new Error(`Recipient USDC did not increase on ${dest.name}.`);

  const explorer = dest.chain.blockExplorers?.default.url?.replace(/\/$/, '');
  return {
    destination: { key: dest.key, name: dest.name, domain: dest.domain },
    recipient,
    attestationId: transfer.transferId,
    mintTxHash: mintTx,
    mintTxUrl: explorer ? `${explorer}/tx/${mintTx}` : undefined,
    recipientBefore: formatUnits(before, 6),
    recipientAfter: formatUnits(after, 6),
    deliveredUsdc: formatUnits(after - before, 6),
  };
}

// ── Dev-controlled helper (backend smoke only; not a user route) ────────────

export interface CircleClient {
  createContractExecutionTransaction(req: {
    walletId: string; contractAddress: string; abiFunctionSignature: string; abiParameters: unknown[];
    fee: { type: 'level'; config: { feeLevel: 'LOW' | 'MEDIUM' | 'HIGH' } };
  }): Promise<{ data?: { id?: string } }>;
  getTransaction(req: { id: string }): Promise<{ data?: { transaction?: { state?: string; txHash?: string; errorReason?: string } } }>;
  signTypedData(req: { walletId: string; data: string }): Promise<{ data?: { signature?: string } }>;
}

async function operatorExec(circle: CircleClient, walletId: string, label: string, contractAddress: Address, abiFunctionSignature: string, abiParameters: unknown[]): Promise<string> {
  const exec = await circle.createContractExecutionTransaction({ walletId, contractAddress, abiFunctionSignature, abiParameters, fee: { type: 'level', config: { feeLevel: 'MEDIUM' } } });
  const id = exec.data?.id;
  if (!id) throw new Error(`${label}: Circle returned no transaction id`);
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const tx = (await circle.getTransaction({ id })).data?.transaction;
    if (tx?.state === 'CONFIRMED' || tx?.state === 'COMPLETE') return tx.txHash ?? '';
    if (['FAILED', 'CANCELED', 'DENIED'].includes(tx?.state ?? '')) throw new Error(`${label} ${tx?.state}: ${tx?.errorReason ?? 'unknown'}`);
    await sleep(2_000);
  }
  throw new Error(`${label}: Circle tx ${id} timed out`);
}

// Full payout driven by a dev-controlled Circle wallet (it deposits + signs).
// Used by scripts/smoke-gateway-payout.ts to validate the lib end-to-end.
export async function routePayoutViaGateway(opts: { circle: CircleClient; depositorWalletId: string; depositorAddress: Address; destinationKey: string; recipient: Address; amountUsdc: string }): Promise<GatewayPayoutResult> {
  const dest = destByKey(opts.destinationKey);
  const depositor = getAddress(opts.depositorAddress);
  const amount = parseUnits(opts.amountUsdc, 6);
  const required = amount + MAX_FEE;

  const unified = await gatewayUnifiedBalance(depositor);
  if (parseUnits(unified.toFixed(6), 6) < required) {
    const depositAtomic = required - parseUnits(unified.toFixed(6), 6);
    const onArc = (await arcClient.readContract({ address: ARC_USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [depositor] })) as bigint;
    if (onArc < depositAtomic) throw new Error(`Seller has ${formatUnits(onArc, 6)} USDC on Arc, needs ${formatUnits(depositAtomic, 6)} more.`);
    const allowance = (await arcClient.readContract({ address: ARC_USDC, abi: ERC20_ABI, functionName: 'allowance', args: [depositor, GATEWAY_WALLET] })) as bigint;
    if (allowance < depositAtomic) await operatorExec(opts.circle, opts.depositorWalletId, 'approve', ARC_USDC, 'approve(address,uint256)', [GATEWAY_WALLET, depositAtomic.toString()]);
    await operatorExec(opts.circle, opts.depositorWalletId, 'deposit', GATEWAY_WALLET, 'deposit(address,uint256)', [ARC_USDC, depositAtomic.toString()]);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && parseUnits((await gatewayUnifiedBalance(depositor)).toFixed(6), 6) < required) await sleep(3_000);
    if (parseUnits((await gatewayUnifiedBalance(depositor)).toFixed(6), 6) < required) throw new Error('Gateway did not credit the deposit within 120s.');
  }

  const message = buildBurnIntentMessage({ destination: dest, depositor, recipient: getAddress(opts.recipient), amountAtomic: amount });
  const typedData = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }], ...BURN_INTENT_TYPES }, domain: EIP712_DOMAIN, primaryType: 'BurnIntent', message };
  const sig = await opts.circle.signTypedData({ walletId: opts.depositorWalletId, data: JSON.stringify(typedData) });
  if (!sig.data?.signature) throw new Error('circle.signTypedData returned no signature');
  return submitTransferAndRelayMint(message, sig.data.signature as Hex);
}
