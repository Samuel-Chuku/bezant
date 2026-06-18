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
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { avalancheFuji, baseSepolia } from 'viem/chains';

// ─────────────────────────────────────────────────────────────────────────────
// Circle Gateway PoC — throwaway proof of a REAL cross-chain USDC settlement.
//
// Proves the seller-payout climax: instead of a same-chain usdc.transfer, money
// moves from a unified Gateway balance funded on one chain (Avalanche Fuji) to a
// recipient on another (Base Sepolia) — instant, off a single signed burn intent.
//
// Why these chains: Arc is NOT a Gateway spend-chain yet (Gateway = Eth/Avax/Base
// testnets; Arc is reached via CCTP). Avalanche Fuji has instant finality, so the
// Gateway deposit is picked up in seconds — best source for a live demo.
//
// Auth model note: Gateway's API is PERMISSIONLESS (no API key). The only "auth"
// is an EIP-712 burn-intent signature from the wallet holding the unified balance.
// This first pass signs with a throwaway EOA to de-risk Gateway in isolation; a
// follow-on pass swaps in the Circle operator MPC wallet via circle.signTypedData.
//
// Run:  npx tsx scripts/gateway-poc.ts
// First run with no key prints a fresh EOA + faucet instructions and exits.
// ─────────────────────────────────────────────────────────────────────────────

const GATEWAY_API = process.env.GATEWAY_API_BASE_URL ?? 'https://gateway-api-testnet.circle.com/v1';
const DEPOSIT_USDC = process.env.GATEWAY_POC_DEPOSIT ?? '5'; // funded into source unified balance
const TRANSFER_USDC = process.env.GATEWAY_POC_TRANSFER ?? '2'; // settled cross-chain to recipient
const RECIPIENT_OVERRIDE = process.env.GATEWAY_POC_RECIPIENT as Address | undefined;

// Gateway contracts are deployed at the same deterministic address on every chain.
const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as const;
const GATEWAY_MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B' as const;

// Source = Avalanche Fuji (instant finality). Destination = Base Sepolia.
const SOURCE = {
  name: 'Avalanche Fuji',
  chain: avalancheFuji,
  domain: 1,
  usdc: getAddress('0x5425890298aed601595a70AB815c96711a31Bc65'),
  gasSymbol: 'AVAX',
  gasFaucet: 'https://faucet.avax.network (or https://core.app/tools/testnet-faucet)',
} as const;

const DEST = {
  name: 'Base Sepolia',
  chain: baseSepolia,
  domain: 6,
  usdc: getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
  gasSymbol: 'ETH',
  gasFaucet: 'https://docs.base.org/chain/network-faucets (Base Sepolia ETH)',
} as const;

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

const GATEWAY_WALLET_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'availableBalance', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'depositor', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const GATEWAY_MINTER_ABI = [
  { type: 'function', name: 'gatewayMint', stateMutability: 'nonpayable', inputs: [{ name: 'attestationPayload', type: 'bytes' }, { name: 'signature', type: 'bytes' }], outputs: [] },
] as const;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function step(label: string) {
  console.log(`\n${BOLD}── ${label} ──${RESET}`);
}
function ok(msg: string) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}
function note(msg: string) {
  console.log(`${DIM}${msg}${RESET}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addressToBytes32 = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });

// ── EOA: load throwaway key, or mint one and bail with faucet instructions ──
function loadAccount() {
  const key = process.env.GATEWAY_POC_PRIVATE_KEY as Hex | undefined;
  if (key) return privateKeyToAccount(key);

  const fresh = generatePrivateKey();
  const acct = privateKeyToAccount(fresh);
  console.log(`\n${YELLOW}No GATEWAY_POC_PRIVATE_KEY set. Generated a throwaway EOA.${RESET}\n`);
  console.log(`  Address:     ${BOLD}${acct.address}${RESET}`);
  console.log(`  Private key: ${fresh}`);
  console.log(`\n${BOLD}Next:${RESET}`);
  console.log(`  1. Add to backend/.env:  GATEWAY_POC_PRIVATE_KEY=${fresh}`);
  console.log(`  2. Fund this address (testnet, free):`);
  console.log(`       • USDC on ${SOURCE.name}:  https://faucet.circle.com`);
  console.log(`       • ${SOURCE.gasSymbol} gas (${SOURCE.name}):  ${SOURCE.gasFaucet}`);
  console.log(`       • ${DEST.gasSymbol} gas (${DEST.name}):  ${DEST.gasFaucet}`);
  console.log(`  3. Re-run:  npx tsx scripts/gateway-poc.ts\n`);
  console.log(`${DIM}(Throwaway key — never reuse it for anything real.)${RESET}`);
  process.exit(0);
}

// ── Gateway API ──
async function gatewayInfo() {
  const res = await fetch(`${GATEWAY_API}/info`);
  if (!res.ok) throw new Error(`GET /info → HTTP ${res.status}`);
  return res.json() as Promise<{ domains: Array<{ chain: string; network: string; domain: number }> }>;
}

async function gatewayBalance(depositor: Address, domain: number): Promise<number> {
  const res = await fetch(`${GATEWAY_API}/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ depositor, domain }] }),
  });
  if (!res.ok) throw new Error(`POST /balances → HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { balances: Array<{ domain: number; balance: string }> };
  const entry = data.balances?.find((b) => b.domain === domain);
  return entry ? parseFloat(entry.balance) : 0;
}

async function gatewayTransfer(body: unknown) {
  const res = await fetch(`${GATEWAY_API}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /transfer → HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as { attestation: Hex; signature: Hex; transferId?: string; fees?: unknown };
}

async function main() {
  const account = loadAccount();
  const recipient = RECIPIENT_OVERRIDE ? getAddress(RECIPIENT_OVERRIDE) : account.address;
  const transferAtomic = parseUnits(TRANSFER_USDC, 6);
  const depositAtomic = parseUnits(DEPOSIT_USDC, 6);

  const srcPublic = createPublicClient({ chain: SOURCE.chain, transport: http() });
  const dstPublic = createPublicClient({ chain: DEST.chain, transport: http() });
  const srcWallet = createWalletClient({ account, chain: SOURCE.chain, transport: http() });
  const dstWallet = createWalletClient({ account, chain: DEST.chain, transport: http() });

  console.log(`${BOLD}Circle Gateway PoC${RESET}  ${SOURCE.name} → ${DEST.name}`);
  console.log(`  Signer (depositor): ${account.address}`);
  console.log(`  Recipient:          ${recipient}${recipient === account.address ? `  ${DIM}(self — override with GATEWAY_POC_RECIPIENT)${RESET}` : ''}`);
  console.log(`  Transfer:           ${TRANSFER_USDC} USDC  ${DIM}(deposit buffer ${DEPOSIT_USDC} USDC)${RESET}`);

  // 1. Confirm Gateway supports both chains right now.
  step('1/5 Gateway /info — confirm chain support');
  const info = await gatewayInfo();
  for (const d of info.domains) note(`  domain ${d.domain}: ${d.chain} ${d.network}`);
  for (const c of [SOURCE, DEST]) {
    if (!info.domains.some((d) => d.domain === c.domain)) {
      throw new Error(`${c.name} (domain ${c.domain}) not in Gateway /info — support changed; re-check docs.`);
    }
  }
  ok(`${SOURCE.name} (${SOURCE.domain}) and ${DEST.name} (${DEST.domain}) both supported.`);

  // 2. Preflight balances + gas.
  step('2/5 Preflight — wallet balances & gas');
  const [srcUsdc, srcGas, dstGas, unified] = await Promise.all([
    srcPublic.readContract({ address: SOURCE.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    srcPublic.getBalance({ address: account.address }),
    dstPublic.getBalance({ address: account.address }),
    gatewayBalance(account.address, SOURCE.domain),
  ]);
  note(`  ${SOURCE.name}:  ${formatUnits(srcUsdc, 6)} USDC, ${formatUnits(srcGas, 18)} ${SOURCE.gasSymbol}`);
  note(`  ${DEST.name}:  ${formatUnits(dstGas, 18)} ${DEST.gasSymbol} (for the mint tx)`);
  note(`  Gateway unified balance on ${SOURCE.name}: ${unified} USDC`);

  if (srcGas === 0n) throw new Error(`No ${SOURCE.gasSymbol} on ${SOURCE.name} for approve+deposit. Faucet: ${SOURCE.gasFaucet}`);
  if (dstGas === 0n) throw new Error(`No ${DEST.gasSymbol} on ${DEST.name} for the mint tx. Faucet: ${DEST.gasFaucet}`);

  // 3. Top up the unified balance if needed (approve + deposit on the source chain).
  step('3/5 Fund unified balance (approve + deposit on source)');
  if (unified >= parseFloat(TRANSFER_USDC)) {
    ok(`Unified balance already covers the transfer (${unified} ≥ ${TRANSFER_USDC} USDC). Skipping deposit.`);
  } else {
    if (srcUsdc < depositAtomic) {
      throw new Error(`Need ${DEPOSIT_USDC} USDC on ${SOURCE.name}, have ${formatUnits(srcUsdc, 6)}. Faucet: https://faucet.circle.com`);
    }
    const allowance = await srcPublic.readContract({ address: SOURCE.usdc, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, GATEWAY_WALLET] });
    if (allowance < depositAtomic) {
      const approveTx = await srcWallet.writeContract({ address: SOURCE.usdc, abi: ERC20_ABI, functionName: 'approve', args: [GATEWAY_WALLET, depositAtomic] });
      await srcPublic.waitForTransactionReceipt({ hash: approveTx });
      ok(`Approved GatewayWallet for ${DEPOSIT_USDC} USDC  ${DIM}${approveTx}${RESET}`);
    } else {
      note('  Allowance already sufficient.');
    }
    const depositTx = await srcWallet.writeContract({ address: GATEWAY_WALLET, abi: GATEWAY_WALLET_ABI, functionName: 'deposit', args: [SOURCE.usdc, depositAtomic] });
    await srcPublic.waitForTransactionReceipt({ hash: depositTx });
    ok(`Deposited ${DEPOSIT_USDC} USDC into GatewayWallet  ${DIM}${depositTx}${RESET}`);

    // Poll until Gateway credits the unified balance (instant-ish on Fuji).
    note('  Waiting for Gateway to pick up the deposit…');
    const deadline = Date.now() + 120_000;
    let credited = 0;
    while (Date.now() < deadline) {
      credited = await gatewayBalance(account.address, SOURCE.domain);
      if (credited >= parseFloat(TRANSFER_USDC)) break;
      await sleep(3000);
    }
    if (credited < parseFloat(TRANSFER_USDC)) throw new Error(`Unified balance still ${credited} USDC after 120s — deposit not finalized yet.`);
    ok(`Unified balance credited: ${credited} USDC.`);
  }

  // 4. Build + sign the burn intent, get an attestation from the Gateway API.
  step('4/5 Sign burn intent → request attestation');
  const message = {
    maxBlockHeight: maxUint256,
    maxFee: 2_010000n, // generous ceiling; actual fee is far smaller on testnet
    spec: {
      version: 1,
      sourceDomain: SOURCE.domain,
      destinationDomain: DEST.domain,
      sourceContract: addressToBytes32(GATEWAY_WALLET),
      destinationContract: addressToBytes32(GATEWAY_MINTER),
      sourceToken: addressToBytes32(SOURCE.usdc),
      destinationToken: addressToBytes32(DEST.usdc),
      sourceDepositor: addressToBytes32(account.address),
      destinationRecipient: addressToBytes32(recipient),
      sourceSigner: addressToBytes32(account.address),
      destinationCaller: addressToBytes32(zeroAddress),
      value: transferAtomic,
      salt: ('0x' + randomBytes(32).toString('hex')) as Hex,
      hookData: '0x' as Hex,
    },
  };

  const signature = await account.signTypedData({
    domain: { name: 'GatewayWallet', version: '1' },
    types: {
      TransferSpec: [
        { name: 'version', type: 'uint32' },
        { name: 'sourceDomain', type: 'uint32' },
        { name: 'destinationDomain', type: 'uint32' },
        { name: 'sourceContract', type: 'bytes32' },
        { name: 'destinationContract', type: 'bytes32' },
        { name: 'sourceToken', type: 'bytes32' },
        { name: 'destinationToken', type: 'bytes32' },
        { name: 'sourceDepositor', type: 'bytes32' },
        { name: 'destinationRecipient', type: 'bytes32' },
        { name: 'sourceSigner', type: 'bytes32' },
        { name: 'destinationCaller', type: 'bytes32' },
        { name: 'value', type: 'uint256' },
        { name: 'salt', type: 'bytes32' },
        { name: 'hookData', type: 'bytes' },
      ],
      BurnIntent: [
        { name: 'maxBlockHeight', type: 'uint256' },
        { name: 'maxFee', type: 'uint256' },
        { name: 'spec', type: 'TransferSpec' },
      ],
    },
    primaryType: 'BurnIntent',
    message,
  });
  ok('Burn intent signed (EIP-712).');

  const transfer = await gatewayTransfer([{ burnIntent: message, signature }]);
  ok(`Attestation received from Gateway API.${transfer.transferId ? `  ${DIM}id ${transfer.transferId}${RESET}` : ''}`);

  // 5. Submit the attestation to the destination minter; confirm the recipient is paid.
  step(`5/5 Mint on ${DEST.name} → confirm settlement`);
  const before = await dstPublic.readContract({ address: DEST.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] });
  const mintTx = await dstWallet.writeContract({ address: GATEWAY_MINTER, abi: GATEWAY_MINTER_ABI, functionName: 'gatewayMint', args: [transfer.attestation, transfer.signature] });
  const receipt = await dstPublic.waitForTransactionReceipt({ hash: mintTx });
  if (receipt.status !== 'success') throw new Error(`gatewayMint reverted on ${DEST.name}  ${mintTx}`);
  ok(`gatewayMint mined in block ${receipt.blockNumber}  ${DIM}${mintTx}${RESET}`);

  // Load-balanced RPCs can briefly serve state from a lagging node, so poll the
  // recipient balance until it reflects the mint instead of reading once.
  let after = before;
  for (let i = 0; i < 10 && after <= before; i++) {
    await sleep(2000);
    after = await dstPublic.readContract({ address: DEST.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] });
  }
  const delta = after - before;

  if (delta <= 0n) throw new Error(`Recipient USDC did not increase on ${DEST.name} (before ${formatUnits(before, 6)}, after ${formatUnits(after, 6)}).`);

  console.log();
  console.log(`${GREEN}${BOLD}✓ Cross-chain settlement proven.${RESET}`);
  console.log(`  Recipient received ${BOLD}${formatUnits(delta, 6)} USDC${RESET} on ${DEST.name} from a Gateway balance funded on ${SOURCE.name}.`);
  console.log(`  ${DEST.name} balance: ${formatUnits(before, 6)} → ${formatUnits(after, 6)} USDC`);
}

main().catch((err) => {
  console.error(`\n${RED}✗ ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
