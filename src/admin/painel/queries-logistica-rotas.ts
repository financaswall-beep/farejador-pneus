// Obra 300 (2026-07-05): fatia do banco da MATRIZ — logística ações: abrir/pendurar/remarcar/recolocar/fechar rota.
// VERBATIM das linhas 2667-2878 do queries.ts pré-obra (commit 2628748).
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { applyWholesaleStockDecrement, applyWholesaleStockReturn } from './wholesale-stock.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyMatrizGalpaoDecrement, applyMatrizGalpaoReturn, applyMatrizRetailCostSnapshot } from '../../atendente-v2/wholesale-stock-read.js';
import { hashPassword } from '../../parceiro/password.js';
import { MAIN_DELIVERY_GUARD } from './queries-logistica.js';

export async function openMatrizTrip(
  input: {
    courier_name: string;
    km_start?: number | null;
    order_ids?: string[];
    created_by?: string | null;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ trip_id: string; deliveries_count: number }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const courier = input.courier_name.trim();
  if (!courier) throw new Error('courier_required');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const trip = await client.query<{ id: string }>(
      `INSERT INTO commerce.matriz_delivery_trips (environment, courier_name, km_start, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [environment, courier, input.km_start ?? null, input.created_by ?? 'matriz-painel'],
    );
    const tripId = trip.rows[0]!.id;
    let count = 0;
    if (input.order_ids && input.order_ids.length > 0) {
      const upd = await client.query(
        `UPDATE commerce.orders o
            SET trip_id = $3, delivery_status = 'dispatched',
                dispatched_at = COALESCE(o.dispatched_at, now()),
                delivery_courier = $4, updated_at = now()
          WHERE o.id = ANY($2::uuid[]) AND o.environment = $1
            AND o.status <> 'cancelled' AND o.delivery_status IN ('pending','dispatched')
            AND o.trip_id IS NULL
            AND ${MAIN_DELIVERY_GUARD}
          RETURNING o.id`,
        [environment, input.order_ids, tripId, courier],
      );
      count = upd.rowCount ?? 0;
      // Pedido que não entrou (cancelado no meio, já em outra rota, de parceiro):
      // a rota abre com os que valem; a tela mostra quantos entraram.
    }
    // Decisão do dono 07-03c: rota NÃO abre vazia. Sem entrega que de fato entrou
    // (order_ids vazio, ou todos inválidos/de parceiro/já em rota → count 0), o
    // ROLLBACK do catch desfaz o INSERT da trip (nada nasce). O resto se pendura
    // depois com attachOrderToMatrizTrip.
    if (count === 0) throw new Error('trip_needs_delivery');
    await client.query('COMMIT');
    return { trip_id: tripId, deliveries_count: count };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** PENDURA uma entrega numa rota JÁ ABERTA (o "pendurar depois" — decisão do dono
 *  07-03c). Mesmo efeito do vínculo na abertura: amarra trip_id, marca 'dispatched'
 *  e herda o entregador da rota (só se o pedido ainda não tinha um). Só pega entrega
 *  da MAIN, em aberto e FORA de rota (guard + trip_id IS NULL), e só entra em rota
 *  ABERTA. Atômico: o EXISTS da rota aberta é avaliado no próprio UPDATE, então rota
 *  que fecha no meio do caminho não recebe pedido órfão. */
export async function attachOrderToMatrizTrip(
  input: { order_id: string; trip_id: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; trip_id: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query<{ order_id: string }>(
    `UPDATE commerce.orders o
        SET trip_id = $3, delivery_status = 'dispatched',
            dispatched_at = COALESCE(o.dispatched_at, now()),
            delivery_courier = COALESCE(o.delivery_courier,
              (SELECT courier_name FROM commerce.matriz_delivery_trips WHERE id = $3 AND environment = $1)),
            updated_at = now()
      WHERE o.id = $2 AND o.environment = $1
        AND o.status <> 'cancelled' AND o.delivery_status IN ('pending','dispatched')
        AND o.trip_id IS NULL
        AND ${MAIN_DELIVERY_GUARD}
        AND EXISTS (SELECT 1 FROM commerce.matriz_delivery_trips t
                     WHERE t.id = $3 AND t.environment = $1 AND t.status = 'open')
      RETURNING o.id AS order_id`,
    [environment, input.order_id, input.trip_id],
  );
  if (r.rows[0]) return { order_id: r.rows[0].order_id, trip_id: input.trip_id };
  // 0 linhas: diagnostica pra dar mensagem útil (pós-fato, não afeta a atomicidade
  // do UPDATE acima). Rota fechada/inexistente → trip_not_open; senão o pedido já
  // saiu do páreo (cancelado, entregue, já em outra rota, ou de parceiro).
  const trip = await dbPool.query<{ status: string }>(
    `SELECT status FROM commerce.matriz_delivery_trips WHERE id = $1 AND environment = $2`,
    [input.trip_id, environment],
  );
  if (!trip.rows[0] || trip.rows[0].status !== 'open') throw new Error('trip_not_open');
  throw new Error('delivery_not_found');
}

/** REMARCA a data prevista de entrega (agendamento — 07-03e). Só entrega da MAIN
 *  ainda EM ABERTO (pending/dispatched — entregue/cancelada não remarca). Grava a
 *  data crua em scheduled_delivery_date; a leitura passa a usá-la no lugar do padrão
 *  D+1. O guard barra pedido de parceiro. */
export async function rescheduleMatrizDelivery(
  input: { order_id: string; scheduled_date: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; scheduled_date: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query<{ order_id: string; scheduled_date: string }>(
    `UPDATE commerce.orders o
        SET scheduled_delivery_date = $3::date, updated_at = now()
      WHERE o.id = $2 AND o.environment = $1
        AND o.status <> 'cancelled' AND o.delivery_status IN ('pending','dispatched')
        AND ${MAIN_DELIVERY_GUARD}
      RETURNING o.id AS order_id, o.scheduled_delivery_date::text AS scheduled_date`,
    [environment, input.order_id, input.scheduled_date],
  );
  if (!r.rows[0]) throw new Error('delivery_not_found');
  return r.rows[0];
}

/** RECOLOCA na fila uma entrega REPORTADA não-entregue (0125): o dono discorda do
 *  reporte do entregador (cliente remarcou, era engano etc.) → volta a 'pending',
 *  solta da rota e limpa o motivo. Só mexe em failed AINDA não cancelado — o
 *  cancelado (confirmado) é terminal e não passa aqui. */
export async function requeueMatrizDelivery(
  input: { order_id: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query<{ order_id: string }>(
    `UPDATE commerce.orders o
        SET delivery_status = 'pending', delivery_failure_reason = NULL,
            trip_id = NULL, updated_at = now()
      WHERE o.id = $2 AND o.environment = $1
        AND o.status <> 'cancelled' AND o.delivery_status = 'failed'
        AND ${MAIN_DELIVERY_GUARD}
      RETURNING o.id AS order_id`,
    [environment, input.order_id],
  );
  if (!r.rows[0]) throw new Error('delivery_not_found');
  return r.rows[0];
}

/** FECHA a rota: km final + gasolina + observação. Se informou gasolina E nenhum
 *  comprovante desta rota já virou despesa (IA), lança a despesa 'combustivel'
 *  (0120) na MESMA transação — anti-dupla-contagem por desenho. Respeita a flag
 *  MATRIZ_EXPENSES (off = diário grava, lançamento não nasce). */
export async function closeMatrizTrip(
  input: {
    trip_id: string;
    km_end?: number | null;
    fuel_spent?: number | null;
    notes?: string | null;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ trip_id: string; fuel_expense_id: string | null }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const trip = await client.query<{ id: string; trip_number: string; courier_name: string; km_start: string | null; started_at: string }>(
      `SELECT id, trip_number, courier_name, km_start::text, started_at
         FROM commerce.matriz_delivery_trips
        WHERE id = $2 AND environment = $1 AND status = 'open' AND deleted_at IS NULL
        FOR UPDATE`,
      [environment, input.trip_id],
    );
    if (!trip.rows[0]) throw new Error('trip_not_found');
    const t = trip.rows[0];

    const fuel = input.fuel_spent != null && Number(input.fuel_spent) > 0 ? Number(input.fuel_spent) : null;
    let fuelExpenseId: string | null = null;
    if (fuel !== null && env.MATRIZ_EXPENSES) {
      const parsed = await client.query(
        `SELECT 1 FROM commerce.matriz_trip_receipts
          WHERE trip_id = $1 AND ai_expense_id IS NOT NULL LIMIT 1`,
        [input.trip_id],
      );
      if (!parsed.rows[0]) {
        const kmLabel = input.km_end != null && t.km_start != null
          ? ` (km ${Number(t.km_start)}–${Number(input.km_end)})` : '';
        const exp = await client.query<{ id: string }>(
          `INSERT INTO commerce.matriz_expenses
             (environment, category, description, amount, payment_status, paid_at, created_by)
           VALUES ($1, 'combustivel', $2, $3, 'paid', now(), 'logistica-fechamento')
           RETURNING id`,
          [environment,
           `${t.trip_number} · ${new Date(t.started_at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} — ${t.courier_name}${kmLabel}`,
           fuel],
        );
        fuelExpenseId = exp.rows[0]!.id;
      }
    }

    await client.query(
      `UPDATE commerce.matriz_delivery_trips
          SET status = 'closed', ended_at = now(),
              km_end = COALESCE($3, km_end),
              fuel_spent = COALESCE($4, fuel_spent),
              notes = COALESCE(NULLIF($5, ''), notes),
              fuel_expense_id = COALESCE($6, fuel_expense_id)
        WHERE id = $2 AND environment = $1`,
      [environment, input.trip_id, input.km_end ?? null, fuel, input.notes ?? null, fuelExpenseId],
    );
    await client.query('COMMIT');
    return { trip_id: input.trip_id, fuel_expense_id: fuelExpenseId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Anexa um comprovante (bytes JÁ re-encodados pelo funil blindado) à rota. */
