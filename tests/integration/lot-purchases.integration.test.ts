import { afterAll, beforeAll, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { proveLotPurchases } from './helpers/lot-purchase-proof.js';
let db: IntegrationDb;
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token',
    WHOLESALE_FINANCE: 'true', MATRIZ_CENTRAL_LEDGER: 'true' });
  db = await startPostgres();
}, 180_000);
afterAll(async () => { if (db) await stopPostgres(db); });
it('integra lote, recebimento, contas, histórico, cancelamento e reenvio sem afetar o catálogo', async () => {
  await proveLotPurchases(db.pool);
}, 60_000);
