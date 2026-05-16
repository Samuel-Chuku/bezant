import 'dotenv/config';
import Fastify from 'fastify';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import pkg from '../package.json' with { type: 'json' };

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

const CIRCLE_API_KEY = requireEnv('CIRCLE_API_KEY');
const CIRCLE_ENTITY_SECRET = requireEnv('CIRCLE_ENTITY_SECRET');
const CIRCLE_OPERATOR_WALLET_ID = requireEnv('CIRCLE_OPERATOR_WALLET_ID');

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: CIRCLE_API_KEY,
  entitySecret: CIRCLE_ENTITY_SECRET,
});

const app = Fastify({
  logger: {
    redact: {
      paths: [
        'req.headers.authorization',
        'err.config.headers.Authorization',
        'err.config.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
  },
});

app.get('/health', async () => {
  return {
    status: 'ok',
    service: 'arc-trade-backend',
    operatorAddress: process.env.CIRCLE_OPERATOR_ADDRESS ?? null,
  };
});

app.get('/version', async () => {
  return {
    service: pkg.name,
    version: pkg.version,
  };
});

app.get('/wallet/balance', async () => {
  const res = await circle.getWalletTokenBalance({ id: CIRCLE_OPERATOR_WALLET_ID });
  return res.data;
});


const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
