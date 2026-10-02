import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
let db: IntegrationDb;
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
    CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin',MATRIZ_CENTRAL_LEDGER:'true' });
  db=await startPostgres({throughMigration:'0252_marketing_integration_hardening.sql'});
  process.env.DATABASE_URL=db.connectionString;vi.resetModules();
},240_000);
afterAll(async()=> {
  const {pool}=await import('../../src/persistence/db.js');await pool.end();if(db)await stopPostgres(db);
});
it('aplica 0253 sobre a 0252 sem alterar lançamentos e aceita o SQL do servidor antigo',async()=> {
  const run=(await db.pool.query(`INSERT INTO marketing.meta_sync_runs
    (environment,trigger_type,window_since,window_until,status,finished_at)
    VALUES('test','manual','2026-07-15','2026-07-15','succeeded',now()) RETURNING id`)).rows[0];
  await db.pool.query(`INSERT INTO marketing.meta_identity_accounts(environment,ad_account_id,sync_run_id)
    VALUES('test','act_1000',$1)`,[run.id]);
  await db.pool.query(`INSERT INTO marketing.meta_ad_identities
    (environment,ad_account_id,ad_id,campaign_id,facebook_page_id,scope,automatic_scope,identity_fingerprint)
    VALUES('test','act_1000','111','10','1434857906367394','matrix','matrix','initial')`);
  await db.pool.query(`INSERT INTO marketing.meta_insights_daily
    (environment,ad_account_id,api_version,account_currency,entity_level,entity_id,campaign_id,metric_date,spend)
    VALUES('test','act_1000','v26.0','BRL','ad','111','10','2026-07-15',13.50)`);
  const insight=(await db.pool.query(`INSERT INTO marketing.meta_insights_daily
    (environment,ad_account_id,api_version,account_currency,entity_level,entity_id,campaign_id,metric_date,spend)
    VALUES('test','act_1000','v26.0','BRL','campaign','10','10','2026-07-15',13.50) RETURNING id`)).rows[0];
  const {postMatrizLedgerTransaction}=await import('../../src/admin/painel/matriz-ledger-posting.js');
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');await postMatrizLedgerTransaction(client,{
      environment:'test',sourceType:'marketing.meta_spend.adjustment',sourceId:insight.id+':initial',
      kind:'marketing_spend_accrual',amount:13.50,occurredAt:'2026-07-15T12:00:00-03:00',
      description:'Histórico preservado',createdBy:'owner:migration',metadata:{insight_id:insight.id},
      lines:[{account_code:'marketing_expense',account_class:'expense',side:'debit',amount:13.50},
        {account_code:'marketing_payable',account_class:'liability',side:'credit',amount:13.50}],
    });await client.query('COMMIT');
  }finally{client.release();}
  const snapshot=async()=> (await db.pool.query(`SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY t.id)) hash
    FROM finance.matriz_ledger_transactions t WHERE environment='test'`)).rows[0].hash;
  const before=await snapshot();
  await db.pool.query(readFileSync('db/migrations/0253_meta_pending_spend_periods.sql','utf8'));
  expect(await snapshot()).toBe(before);
  expect((await db.pool.query(`SELECT finance_since::text FROM marketing.meta_identity_accounts WHERE ad_account_id='act_1000'`)).rows[0].finance_since).toBe('2026-07-15');
  expect(Number((await db.pool.query(`SELECT expected_spend FROM marketing.meta_spend_expected WHERE id=$1`,[insight.id])).rows[0].expected_spend)).toBe(13.50);
  await db.pool.query(`INSERT INTO marketing.meta_identity_accounts(environment,ad_account_id,sync_run_id)
    VALUES('test','act_1001',$1)`,[run.id]);
  expect((await db.pool.query(`SELECT finance_since::text FROM marketing.meta_identity_accounts WHERE ad_account_id='act_1001'`)).rows[0].finance_since).toBe('-infinity');
  const {metaFinanceSince}=await import('../../src/marketing/meta-pending-spend.js');
  expect(await metaFinanceSince(db.pool,'test','act_1001','2026-10-02')).toBe('2026-07-15');
  expect((await db.pool.query(`SELECT count(*)::int n FROM marketing.meta_ad_identity_decisions`)).rows[0].n).toBe(0);
});
