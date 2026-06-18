import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  pad,
  zeroAddress,
  maxUint256,
  formatUnits,
  parseUnits,
  getAddress,
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

// ─────────────────────────────────────────────────────────────────────────────
// Circle Gateway PoC — PRODUCTION SIGNER pass.
//
// Proves the real seller-payout path: the backend Circle OPERATOR wallet (a
// developer-controlled MPC EOA on Arc) funds a Gateway unified balance on Arc
// and signs the burn intent via circle.signTypedData — then the seller is paid
// CROSS-CHAIN on Base Sepolia. This is the direction that matters: escrow funds
// live on Arc; the seller is settled on their chain of choice, no CCTP hop.
//
// Discovery that makes this possible: Arc Testnet is a Gateway spend-chain now
// (domain 26), and GatewayWallet/GatewayMinter are deployed on Arc.
//
// The operator is the burn-intent SIGNER (the security boundary). The mint on
// the destination is just a relayed submission — anyone with gas can send it
// (destinationCaller = 0x0), so the throwaway EOA submits it on Base Sepolia.
//
// Run:  npx tsx scripts/gateway-poc-operator.ts   (npm run gateway:poc:operator)
// ─────────────────────────────────────────────────────────────────────────────

const GATEWAY_API = process.env.GATEWAY_API_BASE_URL ?? 'https://gateway-api-testnet.circle.com/v1';
const DEPOSIT_USDC = process.env.GATEWAY_POC_DEPOSIT ?? '5';
const TRANSFER_USDC = process.env.GATEWAY_POC_TRANSFER ?? '2';
const RECIPIENT_OVERRIDE = process.env.GATEWAY_POC_RECIPIENT as Address | undefined;

const GATEWAY_WALLET = getAddress('0x0077777d7EBA4688BDeF3E311b846F25870A19B9');
const GATEWAY_MINTER = getAddress('0x0022222ABE238Cc2C7Bb1f21003F0a260052475B');

// Source = Arc Testnet (escrow funds live here; operator is a Circle wallet here).
const ARC_RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const SOURCE = {
  name: 'Arc Testnet',
  domain: 26,
  usdc: getAddress('0x3600000000000000000000000000000000000000'), // Arc USDC precompile, 6 decimals
} as const;

// Destination = Base Sepolia (where the seller gets paid).
const DEST = {
  name: 'Base Sepolia',
  chain: baseSepolia,
  domain: 6,
  usdc: getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
} as const;

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const GATEWAY_MINTER_ABI = [
  { type: 'function', name: 'gatewayMint', stateMutability: 'nonpayable', inputs: [{ name: 'attestationPayload', type: 'bytes' }, { name: 'signature', type: 'bytes' }], outputs: [] },
] as const;

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const step = (l: string) => console.log(`\n${BOLD}── ${l} ──${RESET}`);
const ok = (m: string) => console.log(`${GREEN}✓${RESET} ${m}`);
const note = (m: string) => console.log(`${DIM}${m}${RESET}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addressToBytes32 = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});
const OPERATOR_WALLET_ID = process.env.CIRCLE_OPERATOR_WALLET_ID!;

// Drive an Arc tx through the operator's Circle MPC wallet and wait for finality.
async function operatorExec(label: string, contractAddress: Address, abiFunctionSignature: string, abiParameters: unknown[]) {
  const exec = await circle.createContractExecutionTransaction({
    walletId: OPERATOR_WALLET_ID,
    contractAddress,
    abiFunctionSignature,
    abiParameters,
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  const id = exec.data?.id;
  if (!id) throw new Error(`${label}: Circle returned no transaction id`);
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const tx = (await circle.getTransaction({ id })).data?.transaction;
    if (tx?.state === 'CONFIRMED' || tx?.state === 'COMPLETE') return tx.txHash;
    if (['FAILED', 'CANCELED', 'DENIED'].includes(tx?.state ?? '')) throw new Error(`${label} ${tx?.state}: ${tx?.errorReason ?? 'unknown'}`);
    await sleep(2_000);
  }
  throw new Error(`${label}: tx ${id} timed out`);
}

async function gatewayBalance(depositor: Address, domain: number): Promise<number> {
  const res = await fetch(`${GATEWAY_API}/balances`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ depositor, domain }] }),
  });
  if (!res.ok) throw new Error(`POST /balances → HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { balances: Array<{ domain: number; balance: string }> };
  return parseFloat(data.balances?.find((b) => b.domain === domain)?.balance ?? '0');
}

async function main() {
  const operator = getAddress(process.env.CIRCLE_OPERATOR_ADDRESS ?? '0x069CC52417A89554e5ac9dfc48c7690C7A7768B1');
  const minterKey = process.env.GATEWAY_POC_PRIVATE_KEY as Hex | undefined;
  if (!minterKey) throw new Error('GATEWAY_POC_PRIVATE_KEY missing — needed (with Base Sepolia ETH) to relay the destination mint.');
  const minter = privateKeyToAccount(minterKey);
  const recipient = RECIPIENT_OVERRIDE ? getAddress(RECIPIENT_OVERRIDE) : minter.address;
  const transferAtomic = parseUnits(TRANSFER_USDC, 6);
  const depositAtomic = parseUnits(DEPOSIT_USDC, 6);

  const arc = createPublicClient({ transport: http(ARC_RPC) });
  const dstPublic = createPublicClient({ chain: DEST.chain, transport: http() });
  const dstWallet = createWalletClient({ account: minter, chain: DEST.chain, transport: http() });

  console.log(`${BOLD}Circle Gateway PoC — operator signer${RESET}  ${SOURCE.name} → ${DEST.name}`);
  console.log(`  Operator (Circle MPC EOA, signer/depositor): ${operator}`);
  console.log(`  Mint relayer (throwaway EOA on ${DEST.name}):  ${minter.address}`);
  console.log(`  Recipient (the "seller"):                      ${recipient}`);
  console.log(`  Transfer: ${TRANSFER_USDC} USDC  ${DIM}(deposit buffer ${DEPOSIT_USDC})${RESET}`);

  // 1. Confirm Gateway supports Arc + the destination right now.
  step('1/5 Gateway /info — confirm chain support');
  const info = (await (await fetch(`${GATEWAY_API}/info`)).json()) as { domains: Array<{ chain: string; network: string; domain: number }> };
  for (const c of [SOURCE, DEST]) {
    const d = info.domains.find((x) => x.domain === c.domain);
    if (!d) throw new Error(`${c.name} (domain ${c.domain}) not in Gateway /info — support changed.`);
    note(`  ${c.name}: ${d.chain} ${d.network} (domain ${d.domain})`);
  }
  ok('Arc (26) is a Gateway spend-chain; destination supported.');

  // 2. Preflight.
  step('2/5 Preflight — operator balances & relayer gas');
  const [opUsdc, unified, dstGas] = await Promise.all([
    arc.readContract({ address: SOURCE.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [operator] }),
    gatewayBalance(operator, SOURCE.domain),
    dstPublic.getBalance({ address: minter.address }),
  ]);
  note(`  Operator USDC on ${SOURCE.name}: ${formatUnits(opUsdc, 6)}`);
  note(`  Operator Gateway unified balance on ${SOURCE.name}: ${unified} USDC`);
  note(`  Relayer gas on ${DEST.name}: ${formatUnits(dstGas, 18)} ETH`);
  if (dstGas === 0n) throw new Error(`No ETH on ${DEST.name} for the mint tx (relayer ${minter.address}).`);

  // 3. Fund the operator's unified balance on Arc (approve + deposit via Circle).
  step('3/5 Fund unified balance on Arc (operator MPC wallet)');
  if (unified >= parseFloat(TRANSFER_USDC)) {
    ok(`Unified balance already covers the transfer (${unified} ≥ ${TRANSFER_USDC}). Skipping deposit.`);
  } else {
    if (opUsdc < depositAtomic) throw new Error(`Operator needs ${DEPOSIT_USDC} USDC on Arc, has ${formatUnits(opUsdc, 6)}.`);
    const allowance = await arc.readContract({ address: SOURCE.usdc, abi: ERC20_ABI, functionName: 'allowance', args: [operator, GATEWAY_WALLET] });
    if (allowance < depositAtomic) {
      const h = await operatorExec('approve', SOURCE.usdc, 'approve(address,uint256)', [GATEWAY_WALLET, depositAtomic.toString()]);
      ok(`Operator approved GatewayWallet for ${DEPOSIT_USDC} USDC  ${DIM}${h}${RESET}`);
    } else {
      note('  Allowance already sufficient.');
    }
    const dh = await operatorExec('deposit', GATEWAY_WALLET, 'deposit(address,uint256)', [SOURCE.usdc, depositAtomic.toString()]);
    ok(`Operator deposited ${DEPOSIT_USDC} USDC into GatewayWallet  ${DIM}${dh}${RESET}`);
    note('  Waiting for Gateway to credit the unified balance…');
    const deadline = Date.now() + 120_000;
    let credited = 0;
    while (Date.now() < deadline) {
      credited = await gatewayBalance(operator, SOURCE.domain);
      if (credited >= parseFloat(TRANSFER_USDC)) break;
      await sleep(3000);
    }
    if (credited < parseFloat(TRANSFER_USDC)) throw new Error(`Unified balance still ${credited} USDC after 120s.`);
    ok(`Unified balance credited: ${credited} USDC.`);
  }

  // 4. Build the burn intent and sign it with the OPERATOR wallet via Circle.
  step('4/5 Operator signs burn intent (circle.signTypedData) → attestation');
  const spec = {
    version: 1,
    sourceDomain: SOURCE.domain,
    destinationDomain: DEST.domain,
    sourceContract: addressToBytes32(GATEWAY_WALLET),
    destinationContract: addressToBytes32(GATEWAY_MINTER),
    sourceToken: addressToBytes32(SOURCE.usdc),
    destinationToken: addressToBytes32(DEST.usdc),
    sourceDepositor: addressToBytes32(operator),
    destinationRecipient: addressToBytes32(recipient),
    sourceSigner: addressToBytes32(operator),
    destinationCaller: addressToBytes32(zeroAddress),
    value: transferAtomic.toString(),
    salt: ('0x' + randomBytes(32).toString('hex')) as Hex,
    hookData: '0x' as Hex,
  };
  const message = { maxBlockHeight: maxUint256.toString(), maxFee: (2_010000).toString(), spec };
  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
      ],
      TransferSpec: [
        { name: 'version', type: 'uint32' }, { name: 'sourceDomain', type: 'uint32' }, { name: 'destinationDomain', type: 'uint32' },
        { name: 'sourceContract', type: 'bytes32' }, { name: 'destinationContract', type: 'bytes32' },
        { name: 'sourceToken', type: 'bytes32' }, { name: 'destinationToken', type: 'bytes32' },
        { name: 'sourceDepositor', type: 'bytes32' }, { name: 'destinationRecipient', type: 'bytes32' },
        { name: 'sourceSigner', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' },
        { name: 'value', type: 'uint256' }, { name: 'salt', type: 'bytes32' }, { name: 'hookData', type: 'bytes' },
      ],
      BurnIntent: [
        { name: 'maxBlockHeight', type: 'uint256' }, { name: 'maxFee', type: 'uint256' }, { name: 'spec', type: 'TransferSpec' },
      ],
    },
    domain: { name: 'GatewayWallet', version: '1' },
    primaryType: 'BurnIntent',
    message,
  };

  const sig = await circle.signTypedData({ walletId: OPERATOR_WALLET_ID, data: JSON.stringify(typedData) });
  const signature = sig.data?.signature as Hex | undefined;
  if (!signature) throw new Error('circle.signTypedData returned no signature');
  ok(`Operator wallet signed the burn intent (EIP-712 via Circle).  ${DIM}${signature.slice(0, 18)}…${RESET}`);

  const tRes = await fetch(`${GATEWAY_API}/transfer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ burnIntent: message, signature }]),
  });
  const tText = await tRes.text();
  if (!tRes.ok) throw new Error(`POST /transfer → HTTP ${tRes.status}: ${tText}`);
  const transfer = JSON.parse(tText) as { attestation: Hex; signature: Hex; transferId?: string };
  ok(`Attestation received.${transfer.transferId ? `  ${DIM}id ${transfer.transferId}${RESET}` : ''}`);

  // 5. Relay the mint on the destination and confirm the seller is paid.
  step(`5/5 Mint on ${DEST.name} → confirm seller paid`);
  const before = await dstPublic.readContract({ address: DEST.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] });
  const mintTx = await dstWallet.writeContract({ address: GATEWAY_MINTER, abi: GATEWAY_MINTER_ABI, functionName: 'gatewayMint', args: [transfer.attestation, transfer.signature] });
  const receipt = await dstPublic.waitForTransactionReceipt({ hash: mintTx });
  if (receipt.status !== 'success') throw new Error(`gatewayMint reverted on ${DEST.name}  ${mintTx}`);
  ok(`gatewayMint mined in block ${receipt.blockNumber}  ${DIM}${mintTx}${RESET}`);

  let after = before;
  for (let i = 0; i < 10 && after <= before; i++) {
    await sleep(2000);
    after = await dstPublic.readContract({ address: DEST.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] });
  }
  const delta = after - before;
  if (delta <= 0n) throw new Error(`Recipient USDC did not increase on ${DEST.name} (before ${formatUnits(before, 6)}, after ${formatUnits(after, 6)}).`);

  console.log();
  console.log(`${GREEN}${BOLD}✓ Operator-signed cross-chain settlement proven.${RESET}`);
  console.log(`  The Circle operator wallet on ${SOURCE.name} settled ${BOLD}${formatUnits(delta, 6)} USDC${RESET} to the seller on ${DEST.name}.`);
  console.log(`  ${DEST.name} recipient balance: ${formatUnits(before, 6)} → ${formatUnits(after, 6)} USDC`);
}

main().catch((err) => {
  console.error(`\n${RED}✗ ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
