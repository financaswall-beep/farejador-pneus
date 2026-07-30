import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startPostgres, stopPostgres, type IntegrationDb,
} from './helpers/postgres';
import { createPartnerFixture } from './helpers/partner-fixtures';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
  process.env.DATABASE_URL = db.connectionString;
  process.env.FAREJADOR_ENV = 'test';
  process.env.NODE_ENV = 'test';
  process.env.CHATWOOT_HMAC_SECRET = 'test-secret';
  process.env.ADMIN_AUTH_TOKEN = 'admin-test-token-1234567890';
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

describe('continuidade mensal do parceiro', () => {
  it('congela, fecha uma vez e carrega o estorno para o mes seguinte', async () => {
    const partner = await import('../../src/parceiro/queries.js');
    const fixture = await createPartnerFixture(db.pool, {
      role: 'funcionario',
      initialStockQty: 5,
    });
    await db.pool.query(
      `INSERT INTO network.partner_token_commission
        (token_id,environment,partner_unit_id,kind,value,active,updated_by)
       VALUES ($1,'test',$2,'percent',10,true,'integration-test')`,
      [fixture.tokenId, fixture.partnerUnitId],
    );

    const sale = await partner.registerPartnerSale(fixture.ctx, {
      customer_name: 'Cliente da virada',
      items: [{
        partner_stock_id: fixture.stockId,
        quantity: 1,
        unit_price: 200,
      }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `monthly-continuity-${randomUUID()}`,
    });

    const entry = await db.pool.query<{
      id: string;
      competence_month: string;
      commission_amount: string;
      commission_value: string;
    }>(
      `SELECT id,competence_month::text,commission_amount::text,
              commission_value::text
         FROM finance.partner_staff_commission_entries
        WHERE environment='test' AND partner_order_id=$1`,
      [sale.order_id],
    );
    expect(entry.rows[0]).toMatchObject({
      commission_amount: '20.00',
      commission_value: '10.00',
    });

    await expect(db.pool.query(
      `INSERT INTO finance.partner_staff_commission_entries
        (environment,partner_unit_id,unit_id,token_id,partner_order_id,
         competence_month,gross_amount,commission_kind,commission_value,
         commission_amount,realized_at)
       VALUES
        ('prod',$1,$2,$3,$4,date_trunc('month',now())::date,
         200,'percent',10,20,now())`,
      [fixture.partnerUnitId, fixture.unitId, fixture.tokenId, sale.order_id],
    )).rejects.toThrow(/env_match/);

    // A mudanca vale apenas para vendas futuras; a linha acima continua em 10%.
    await db.pool.query(
      `UPDATE network.partner_token_commission
          SET value=15,updated_at=now()
        WHERE token_id=$1`,
      [fixture.tokenId],
    );

    const [year, month] = entry.rows[0]!.competence_month
      .split('-')
      .slice(0, 2)
      .map(Number);
    const nextMonth = new Date(Date.UTC(year!, month!, 1, 3)).toISOString();
    const first = await db.pool.query<{ result: {
      periods_closed: number;
      payables_created: number;
    } }>(
      `SELECT finance.run_partner_staff_commission_rollover(
        'test'::env_t,$1::timestamptz
      ) AS result`,
      [nextMonth],
    );
    const retry = await db.pool.query<{ result: {
      periods_closed: number;
      payables_created: number;
    } }>(
      `SELECT finance.run_partner_staff_commission_rollover(
        'test'::env_t,$1::timestamptz
      ) AS result`,
      [nextMonth],
    );
    expect(first.rows[0]!.result).toMatchObject({
      periods_closed: 1,
      payables_created: 1,
    });
    expect(retry.rows[0]!.result).toMatchObject({
      periods_closed: 0,
      payables_created: 0,
    });

    const payable = await db.pool.query<{
      id: string;
      amount: string;
      competence_month: string;
    }>(
      `SELECT pp.id,pp.amount::text,pp.competence_month::text
         FROM finance.partner_payables pp
         JOIN finance.partner_staff_commission_periods period
           ON period.payable_id=pp.id
        WHERE period.environment='test' AND period.token_id=$1`,
      [fixture.tokenId],
    );
    expect(payable.rows).toHaveLength(1);
    expect(payable.rows[0]).toMatchObject({
      amount: '20.00',
      competence_month: entry.rows[0]!.competence_month,
    });

    await partner.cancelPartnerSale(
      fixture.ctx,
      sale.order_id,
      'cancelamento depois do fechamento',
    );
    const adjustment = await db.pool.query<{ amount: string }>(
      `SELECT amount::text
         FROM finance.partner_staff_commission_adjustments
        WHERE environment='test' AND commission_entry_id=$1`,
      [entry.rows[0]!.id],
    );
    expect(adjustment.rows[0]?.amount).toBe('-20.00');

    await expect(db.pool.query(
      `UPDATE finance.partner_payables
          SET status='cancelled',deleted_at=now()
        WHERE id=$1`,
      [payable.rows[0]!.id],
    )).rejects.toThrow(/partner_staff_commission_payable_immutable/);

    await expect(db.pool.query(
      `UPDATE finance.partner_payables
          SET status='paid',paid_at=now()
        WHERE id=$1`,
      [payable.rows[0]!.id],
    )).resolves.toBeTruthy();
  });

  it('recupera mensalidades que ficaram para tras sem duplicar', async () => {
    const fixture = await createPartnerFixture(db.pool);
    await db.pool.query(
      `UPDATE network.partners
          SET commercial_model='monthly',monthly_fee=150,status='active'
        WHERE environment='test' AND id=$1`,
      [fixture.partnerId],
    );
    await db.pool.query(
      `WITH past AS (
         SELECT (
           date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')
             - interval '2 months'
         ) AT TIME ZONE 'America/Sao_Paulo' AS value
       )
       UPDATE network.partners SET created_at=past.value
         FROM past
        WHERE environment='test' AND id=$1`,
      [fixture.partnerId],
    );
    await db.pool.query(
      `DELETE FROM network.partner_commercial_terms_history
        WHERE environment='test' AND partner_id=$1 AND valid_until IS NOT NULL`,
      [fixture.partnerId],
    );
    await db.pool.query(
      `UPDATE network.partner_commercial_terms_history
          SET valid_from=(
            date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')
              - interval '2 months'
          ) AT TIME ZONE 'America/Sao_Paulo'
        WHERE environment='test' AND partner_id=$1 AND valid_until IS NULL`,
      [fixture.partnerId],
    );

    const { generateCurrentMatrizPartnerMonthlyFees } = await import(
      '../../src/admin/painel/queries-mensalidades.js'
    );
    const client = await db.pool.connect();
    let created = 0;
    let retry = 0;
    try {
      created = await generateCurrentMatrizPartnerMonthlyFees(client, 'test');
      retry = await generateCurrentMatrizPartnerMonthlyFees(client, 'test');
    } finally {
      client.release();
    }
    expect(created).toBe(3);
    expect(retry).toBe(0);

    const fees = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM finance.matriz_partner_monthly_fees
        WHERE environment='test' AND partner_id=$1`,
      [fixture.partnerId],
    );
    expect(fees.rows[0]?.n).toBe(3);
  });
});
