import 'dotenv/config';
import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/health', async () => {
  return {
    status: 'ok',
    service: 'arc-trade-backend',
    operatorAddress: process.env.CIRCLE_OPERATOR_ADDRESS ?? null,
  };
});

const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
