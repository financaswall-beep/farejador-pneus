import type { Pool, PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { cancelOpenBotOrder } from '../atendente-v2/cancel-open-order.js';

const PARTNER_JOIN = `LEFT JOIN commerce.partner_orders p
  ON p.environment=o.environment AND p.id=o.partner_order_id`;

async function clearFailure(client: PoolClient, environment: string, orderId: string) {
  await client.query('DELETE FROM ops.bot_reservation_expiry_failures WHERE environment=$1 AND order_id=$2',
    [environment, orderId]);
}

async function expireOne(db: Pool, environment: 'prod' | 'test', orderId: string, cutoff: string, now: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Réplicas não repetem a mesma tentativa nem incrementam juntas o contador.
    const lock = await client.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired`,
      [`bot-expiry:${environment}:${orderId}`]);
    if (!lock.rows[0]?.acquired) { await client.query('ROLLBACK'); return 0; }
    const cooldown = await client.query(`SELECT 1 FROM ops.bot_reservation_expiry_failures
      WHERE environment=$1 AND order_id=$2 AND retry_after>$3::timestamptz`, [environment, orderId, now]);
    if (cooldown.rowCount) { await client.query('COMMIT'); return 0; }
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query('SAVEPOINT expire_reservation');
    try {
      await cancelOpenBotOrder(client, environment, orderId, 'system:bot-reservation-expiry',
        `Reserva do bot expirada após ${env.BOT_PICKUP_RESERVATION_HOURS} horas sem retirada`, cutoff);
      await clearFailure(client, environment, orderId);
      await client.query('COMMIT');
      return 1;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT expire_reservation');
      // Uma chegada/retirada concorrente é resolução legítima, não falha persistente.
      const live = await client.query(`SELECT commerce.bot_order_cancellation_allowed(o,p,$3::timestamptz) allowed
        FROM commerce.orders o ${PARTNER_JOIN} WHERE o.environment=$1 AND o.id=$2`,
      [environment, orderId, cutoff]);
      if (!live.rows[0]?.allowed) {
        await clearFailure(client, environment, orderId);
      } else {
        const code = (error as { code?: string })?.code;
        const errorCode = error instanceof Error && error.message === 'order_status_changed'
          ? 'order_status_changed' : code && /^[0-9A-Z]{5}$/.test(code) ? code : 'expiry_failed';
        await client.query(`INSERT INTO ops.bot_reservation_expiry_failures
          (environment,order_id,attempts,last_failed_at,retry_after,error_code)
          VALUES ($1,$2,1,$3::timestamptz,$3::timestamptz+interval '1 minute',$4)
          ON CONFLICT(environment,order_id) DO UPDATE SET
            attempts=ops.bot_reservation_expiry_failures.attempts+1,
            last_failed_at=EXCLUDED.last_failed_at,error_code=EXCLUDED.error_code,
            retry_after=EXCLUDED.last_failed_at+LEAST(3600,60*power(2,LEAST(6,ops.bot_reservation_expiry_failures.attempts)))*interval '1 second'`,
        [environment, orderId, now, errorCode]);
        logger.warn({ order_id: orderId, error_code: errorCode }, 'bot reservation expiry will retry');
      }
      await client.query('COMMIT');
      return 0;
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

// A data de corte fica congelada no ciclo. O cursor preserva microssegundos e
// avança mesmo após falha, sem recolocar os mesmos 100 pedidos à frente da fila.
export async function expireBotReservations(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  db: Pool = pool,
  now = new Date(),
): Promise<number> {
  if (!env.BOT_PICKUP_RESERVATION_HOURS) return 0;
  const at = now.toISOString();
  const cutoff = new Date(now.getTime()-env.BOT_PICKUP_RESERVATION_HOURS*3_600_000).toISOString();
  let cursor: { id: string; created_at: string } | null = null;
  let expired = 0;
  // Limpa apenas o estado de erro de pedidos que deixaram de ser vencíveis.
  await db.query(`DELETE FROM ops.bot_reservation_expiry_failures f USING commerce.orders o
    LEFT JOIN commerce.partner_orders p ON p.environment=o.environment AND p.id=o.partner_order_id
    WHERE f.environment=$1 AND o.environment=f.environment AND o.id=f.order_id
      AND NOT commerce.bot_order_cancellation_allowed(o,p,$2::timestamptz)`, [environment, cutoff]);
  while (true) {
    const due: { rows: Array<{ id: string; created_at: string }> } = await db.query(`
      SELECT o.id,o.created_at::text FROM commerce.orders o ${PARTNER_JOIN}
      LEFT JOIN ops.bot_reservation_expiry_failures f ON f.environment=o.environment AND f.order_id=o.id
      WHERE o.environment=$1 AND commerce.bot_order_cancellation_allowed(o,p,$2::timestamptz)
        AND (f.retry_after IS NULL OR f.retry_after<=$3::timestamptz)
        AND ($4::timestamptz IS NULL OR (o.created_at,o.id)>($4::timestamptz,$5::uuid))
      ORDER BY o.created_at,o.id LIMIT 100`, [environment, cutoff, at, cursor?.created_at ?? null, cursor?.id ?? null]);
    if (!due.rows.length) break;
    for (const row of due.rows) expired += await expireOne(db, environment, row.id, cutoff, at);
    cursor = due.rows[due.rows.length-1]!;
  }
  return expired;
}

export async function botReservationWarnings(environment: 'prod' | 'test', db: Pool) {
  if (!env.BOT_PICKUP_RESERVATION_HOURS) return 0;
  const result = await db.query<{ n: number }>(`SELECT count(*)::int n
    FROM commerce.orders o JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment
    ${PARTNER_JOIN} WHERE o.environment=$1 AND u.slug='main'
      AND commerce.bot_order_cancellation_allowed(o,p,now()-GREATEST($2::int-12,0)*interval '1 hour')`,
  [environment, env.BOT_PICKUP_RESERVATION_HOURS]);
  return result.rows[0]?.n ?? 0;
}

export async function botReservationExpiryFailures(environment: 'prod' | 'test', db: Pool) {
  const empty = { count: 0, matrix_count: 0, orders: [] as Array<{ order_number: string; unit_name: string }> };
  if (!env.BOT_PICKUP_RESERVATION_HOURS) return empty;
  const result = await db.query<typeof empty>(`WITH pending AS (
    SELECT o.order_number,u.name unit_name,u.slug,f.last_failed_at
    FROM ops.bot_reservation_expiry_failures f
    JOIN commerce.orders o ON o.environment=f.environment AND o.id=f.order_id
    JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id ${PARTNER_JOIN}
    WHERE f.environment=$1 AND f.attempts>=3
      AND commerce.bot_order_cancellation_allowed(o,p,now()-$2::int*interval '1 hour')
  ) SELECT count(*)::int count,count(*) FILTER(WHERE slug='main')::int matrix_count,
    COALESCE((SELECT json_agg(json_build_object('order_number',order_number,'unit_name',unit_name))
      FROM (SELECT * FROM pending ORDER BY last_failed_at,order_number LIMIT 10) sample),'[]'::json) orders
    FROM pending`, [environment, env.BOT_PICKUP_RESERVATION_HOURS]);
  return result.rows[0] ?? empty;
}

export function startBotReservationExpiry(): () => void {
  let running = false, stopped = false;
  const check = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const expired = await expireBotReservations();
      if (expired) logger.info({ expired }, 'bot pickup reservations expired');
    } catch (error) {
      logger.error({ err: error }, 'bot reservation expiry deferred');
    } finally { running = false; }
  };
  const timer = setInterval(() => void check(), 60_000);
  void check();
  return () => { stopped = true; clearInterval(timer); };
}
