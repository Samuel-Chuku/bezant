import 'dotenv/config';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { listGatewayDestinations, routePayoutViaGateway, getRelayerAccount, type CircleClient } from '../src/lib/gateway.js';

// Smoke for the Gateway payout LIB (src/lib/gateway.ts) — exercises the real
// routePayoutViaGateway, not a copy. Stands in the operator wallet for a
// dev-controlled seller: Arc → Base Sepolia. Proves the refactor still settles.
//
// Run:  npm run smoke:gateway-payout
const DEST = process.env.SMOKE_GW_DEST ?? 'baseSepolia';
const AMOUNT = process.env.SMOKE_GW_AMOUNT ?? '1';

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
}) as unknown as CircleClient;

(async () => {
  console.log('── Gateway destinations (from /info ∩ registry) ──');
  for (const d of await listGatewayDestinations()) {
    console.log(`  ${d.supported ? '✓' : '✗'} ${d.key} (${d.name}, domain ${d.domain})`);
  }

  const depositorWalletId = process.env.CIRCLE_OPERATOR_WALLET_ID!;
  const depositorAddress = (process.env.CIRCLE_OPERATOR_ADDRESS ?? '0x069CC52417A89554e5ac9dfc48c7690C7A7768B1') as `0x${string}`;
  const recipient = getRelayerAccount().address; // a visible test recipient on the destination

  console.log(`\n── Routing ${AMOUNT} USDC: Arc → ${DEST} → ${recipient} ──`);
  const result = await routePayoutViaGateway({
    circle, depositorWalletId, depositorAddress, destinationKey: DEST, recipient, amountUsdc: AMOUNT,
  });
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n✓ Lib settled ${result.deliveredUsdc} USDC on ${result.destination.name} (${result.recipientBefore} → ${result.recipientAfter}).`);
})().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
