/**
 * PORTAL DO ENTREGADOR — queries ESCOPADAS (0125). Fatia C da Logística (0121).
 *
 * REGRA DE OURO desta camada (revisão de segurança 07-04): não existe RLS embaixo
 * — tudo roda no pool OWNER. O muro entre entregadores é 100% o WHERE. Então:
 *   · a posse da rota (courier_collaborator_id da sessão) entra no WHERE/EXISTS de
 *     TODA escrita — nunca num if de aplicação;
 *   · a query do card é NOVA e FINANCEIRAMENTE CEGA (zero custo/lucro/despesa/frete
 *     — nem seleciona matriz_unit_cost nem toca matriz_expenses);
 *   · o login resolve pessoa+colaborador numa query só e SÓ ENTÃO decide
 *     verify×fakeVerify (silhueta de tempo idêntica nos 5 fracassos);
 *   · a validação de sessão junta o colaborador ATIVO job='entregador' no mesmo
 *     predicado (revogar o colaborador mata a sessão na hora);
 *   · NÃO-ENTREGUE só REPORTA (failed + motivo) — o portal NUNCA chama
 *     cancel_manual_order nem devolve galpão (isso é do dono, no painel).
 */
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { hashPassword, verifyPassword, fakeVerify, hashSessionToken } from '../../parceiro/password.js';
import { MAIN_DELIVERY_GUARD, closeMatrizTrip, addMatrizTripReceipt,
  type MatrizReceiptUploadResult } from '../painel/queries.js';

void hashPassword; // reservado (troca de senha do próprio entregador — fatia futura)

const STAFF_SESSION_PREFIX = 'es_';
const STAFF_SESSION_TTL_DAYS = 7; // celular de moto-boy: reautenticar é barato, janela curta

export interface EntregadorAuth {
  personId: string;
  collaboratorId: string;
  displayName: string;
}

export interface EntregadorLoginResult {
  session_token: string;
  expires_at: string;
  display_name: string;
}

function newStaffSessionToken(): { token: string; hash: string } {
  const token = STAFF_SESSION_PREFIX + randomBytes(32).toString('hex');
  return { token, hash: hashSessionToken(token) };
}

/** Um bearer do portal tem o prefixo es_? (o middleware rejeita o resto SEM fallback.) */
export function isStaffSessionToken(bearer: string): boolean {
  return bearer.startsWith(STAFF_SESSION_PREFIX);
}

/**
 * LOGIN do entregador. Resolve pessoa + colaborador numa query só, DEPOIS decide
 * verify×fakeVerify — os 5 fracassos (usuário inexistente, senha errada, sem
 * colaborador, job≠entregador, revogado) têm a MESMA silhueta de tempo e devolvem
 * null (a rota traduz pra um 401 único). Sucesso → cria a sessão es_ e devolve o token.
 */
export async function authenticateEntregador(
  environment: 'prod' | 'test',
  username: string,
  password: string,
  dbPool: Pool = defaultPool,
): Promise<EntregadorLoginResult | null> {
  const res = await dbPool.query<{
    person_id: string; password_hash: string | null;
    collaborator_id: string | null; display_name: string | null; job: string | null;
  }>(
    `SELECT pp.id AS person_id, pp.password_hash,
            mc.id AS collaborator_id, mc.display_name, mc.job
       FROM network.partner_people pp
       LEFT JOIN network.matriz_collaborators mc
         ON mc.person_id = pp.id AND mc.environment = pp.environment AND mc.revoked_at IS NULL
      WHERE pp.environment = $1 AND lower(pp.username) = lower($2)
        AND pp.revoked_at IS NULL AND pp.password_hash IS NOT NULL
      LIMIT 1`,
    [environment, username],
  );
  const row = res.rows[0];
  if (!row) {
    await fakeVerify(password); // pessoa inexistente queima o mesmo tempo (anti-enumeração)
    return null;
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;
  // Senha certa mas não é entregador ativo → MESMO null (verify já rodou: timing igual).
  if (!row.collaborator_id || row.job !== 'entregador') return null;

  const { token, hash } = newStaffSessionToken();
  const expiresAt = new Date(Date.now() + STAFF_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await dbPool.query(
    `INSERT INTO network.matriz_staff_sessions (environment, person_id, session_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [environment, row.person_id, hash, expiresAt],
  );
  return { session_token: token, expires_at: expiresAt, display_name: row.display_name ?? 'entregador' };
}

/**
 * Valida a sessão do portal NUMA QUERY SÓ, com o colaborador ativo job='entregador'
 * no mesmo predicado. Revogar o colaborador (ou a sessão) → esta query não acha
 * nada → 401 na hora, sem ter lido dado antes. Toca last_used_at (não bloqueante).
 */
export async function validateEntregadorSession(
  environment: 'prod' | 'test',
  sessionToken: string,
  dbPool: Pool = defaultPool,
): Promise<EntregadorAuth | null> {
  const res = await dbPool.query<{ person_id: string; collaborator_id: string; display_name: string }>(
    `UPDATE network.matriz_staff_sessions s
        SET last_used_at = now()
       FROM network.matriz_collaborators mc
      WHERE s.session_hash = $1 AND s.environment = $2
        AND s.revoked_at IS NULL AND s.expires_at > now()
        AND mc.person_id = s.person_id AND mc.environment = s.environment
        AND mc.revoked_at IS NULL AND mc.job = 'entregador'
      RETURNING s.person_id, mc.id AS collaborator_id, mc.display_name`,
    [hashSessionToken(sessionToken), environment],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { personId: row.person_id, collaboratorId: row.collaborator_id, displayName: row.display_name };
}

/** Logout: revoga a sessão (idempotente). */
export async function revokeEntregadorSession(
  environment: 'prod' | 'test',
  sessionToken: string,
  dbPool: Pool = defaultPool,
): Promise<void> {
  await dbPool.query(
    `UPDATE network.matriz_staff_sessions SET revoked_at = now()
      WHERE session_hash = $1 AND environment = $2 AND revoked_at IS NULL`,
    [hashSessionToken(sessionToken), environment],
  );
}

// ─── A ROTA DELE (card financeiramente CEGO) ──────────────────────────────────

export interface EntregadorDeliveryCard {
  order_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  cobrar: string;              // total_amount cru (COD — o que ele recebe na porta). Um número só.
  delivery_status: 'pending' | 'dispatched' | 'delivered' | 'failed';
  scheduled_date: string;      // YYYY-MM-DD (D+1 padrão ou remarcada)
  scheduled_raw: string | null;
  items: Array<{ quantity: number; label: string }>;
}

export interface EntregadorRota {
  rota_aberta: {
    trip_id: string;
    trip_number: string; // 0129: ROTA-XXXX — o entregador fala o mesmo número que o dono audita
    km_start: string | null;
    started_at: string;
    entregas: EntregadorDeliveryCard[];
  } | null;
  fila: EntregadorDeliveryCard[]; // entregas do dia ainda fora de rota (D+1, ordenadas)
}

// SELECT do card — só campo operacional. NADA de custo/lucro/despesa/frete.
const CARD_SELECT = `
  SELECT o.id AS order_id, c.name AS customer_name, c.phone_e164 AS customer_phone,
         o.delivery_address, o.total_amount::text AS cobrar, o.delivery_status,
         o.scheduled_delivery_date::text AS scheduled_raw,
         COALESCE(o.scheduled_delivery_date, ((o.created_at AT TIME ZONE 'America/Sao_Paulo')::date + 1))::text AS scheduled_date,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'quantity', oi.quantity,
                     'label', COALESCE(pr.product_name, 'item')) ORDER BY oi.created_at)
                     FROM commerce.order_items oi
                     LEFT JOIN commerce.products pr ON pr.id = oi.product_id
                    WHERE oi.order_id = o.id AND oi.environment = o.environment), '[]'::jsonb) AS items
    FROM commerce.orders o
    LEFT JOIN core.contacts c ON c.id = o.contact_id
   WHERE o.environment = $1 AND ${MAIN_DELIVERY_GUARD}`;

/** A rota aberta do entregador (com as entregas dela) + a fila do dia fora de rota. */
export async function getEntregadorRota(
  auth: EntregadorAuth,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<EntregadorRota> {
  const trip = await dbPool.query<{ id: string; trip_number: string; km_start: string | null; started_at: string }>(
    `SELECT id, trip_number, km_start::text, started_at
       FROM commerce.matriz_delivery_trips
      WHERE environment = $1 AND courier_collaborator_id = $2 AND status = 'open' AND deleted_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [environment, auth.collaboratorId],
  );
  const openTrip = trip.rows[0] ?? null;

  const [rotaEntregas, fila] = await Promise.all([
    openTrip
      ? dbPool.query<EntregadorDeliveryCard>(
          `${CARD_SELECT} AND o.trip_id = $2 AND o.status <> 'cancelled'
             AND o.delivery_status IN ('dispatched','delivered')
           ORDER BY o.delivery_status ASC, o.created_at ASC`,
          [environment, openTrip.id])
      : Promise.resolve({ rows: [] as EntregadorDeliveryCard[] }),
    dbPool.query<EntregadorDeliveryCard>(
      `${CARD_SELECT} AND o.trip_id IS NULL AND o.status <> 'cancelled'
         AND o.delivery_status = 'pending'
       ORDER BY scheduled_date ASC, o.created_at ASC LIMIT 50`,
      [environment]),
  ]);

  return {
    rota_aberta: openTrip
      ? { trip_id: openTrip.id, trip_number: openTrip.trip_number, km_start: openTrip.km_start, started_at: openTrip.started_at, entregas: rotaEntregas.rows }
      : null,
    fila: fila.rows,
  };
}

// ─── ESCRITAS (posse do entregador SEMPRE no WHERE) ───────────────────────────

/** ABRE a rota DELE: cria a trip com courier_collaborator_id + courier_name=nome
 *  dele, pendura as entregas escolhidas. Só entrega da main, pending, fora de rota.
 *  Rota não abre vazia (trip_needs_delivery). Já tem rota aberta → o índice único
 *  parcial estoura 23505 → trip_already_open (corrida de 2 cliques morre aqui). */
export async function openEntregadorTrip(
  auth: EntregadorAuth,
  input: { km_start?: number | null; order_ids: string[] },
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ trip_id: string; deliveries_count: number }> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    let tripId: string;
    try {
      const trip = await client.query<{ id: string }>(
        `INSERT INTO commerce.matriz_delivery_trips
           (environment, courier_name, courier_collaborator_id, km_start, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [environment, auth.displayName, auth.collaboratorId, input.km_start ?? null, `entregador:${auth.collaboratorId}`],
      );
      tripId = trip.rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') throw new Error('trip_already_open');
      throw err;
    }
    const upd = await client.query(
      `UPDATE commerce.orders o
          SET trip_id = $3, delivery_status = 'dispatched',
              dispatched_at = COALESCE(o.dispatched_at, now()),
              delivery_courier = $4, updated_at = now()
        WHERE o.id = ANY($2::uuid[]) AND o.environment = $1
          AND o.status <> 'cancelled' AND o.delivery_status = 'pending' AND o.trip_id IS NULL
          AND ${MAIN_DELIVERY_GUARD}
        RETURNING o.id`,
      [environment, input.order_ids, tripId, auth.displayName],
    );
    const count = upd.rowCount ?? 0;
    if (count === 0) throw new Error('trip_needs_delivery'); // rollback desfaz a trip
    await client.query('COMMIT');
    return { trip_id: tripId, deliveries_count: count };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** SAIU / ENTREGUE. Posse no WHERE: o pedido tem de estar numa trip ABERTA DELE.
 *  Entregue grava o NOME dele em delivery_courier/closed_by (trilha de quem fez). */
export async function setEntregadorDeliveryStatus(
  auth: EntregadorAuth,
  input: { order_id: string; status: 'dispatched' | 'delivered'; payment_method?: string | null },
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; delivery_status: string }> {
  const r = await dbPool.query<{ order_id: string; delivery_status: string }>(
    `UPDATE commerce.orders o
        SET delivery_status = $3,
            delivery_courier = $6,
            dispatched_at = CASE WHEN $3 = 'dispatched' THEN COALESCE(o.dispatched_at, now()) ELSE o.dispatched_at END,
            delivered_at  = CASE WHEN $3 = 'delivered'  THEN now() ELSE o.delivered_at END,
            status        = CASE WHEN $3 = 'delivered'  THEN 'delivered' ELSE o.status END,
            payment_method = CASE WHEN $3 = 'delivered' THEN COALESCE(NULLIF($5, ''), o.payment_method) ELSE o.payment_method END,
            closed_at     = CASE WHEN $3 = 'delivered'  THEN COALESCE(o.closed_at, now()) ELSE o.closed_at END,
            closed_by     = CASE WHEN $3 = 'delivered'  THEN COALESCE(o.closed_by, $6) ELSE o.closed_by END,
            updated_at    = now()
      WHERE o.id = $2 AND o.environment = $1
        AND o.status <> 'cancelled' AND o.delivery_status <> 'delivered'
        AND ${MAIN_DELIVERY_GUARD}
        AND o.trip_id IN (SELECT t.id FROM commerce.matriz_delivery_trips t
                           WHERE t.environment = $1 AND t.courier_collaborator_id = $4 AND t.status = 'open')
      RETURNING o.id AS order_id, o.delivery_status`,
    [environment, input.order_id, input.status, auth.collaboratorId, input.payment_method ?? null, auth.displayName],
  );
  if (!r.rows[0]) throw new Error('delivery_not_found');
  return r.rows[0];
}

/** NÃO ENTREGUE — só REPORTA (failed + motivo). O portal NÃO cancela nem devolve
 *  galpão: o dono confirma no painel (cancel_manual_order não tem freio de
 *  permissão — regra do seguranca). Posse no WHERE: trip aberta DELE. */
export async function reportEntregadorFail(
  auth: EntregadorAuth,
  input: { order_id: string; reason: string },
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; delivery_status: 'failed' }> {
  const r = await dbPool.query<{ order_id: string }>(
    `UPDATE commerce.orders o
        SET delivery_status = 'failed', delivery_failure_reason = $3, updated_at = now()
      WHERE o.id = $2 AND o.environment = $1
        AND o.status <> 'cancelled' AND o.delivery_status NOT IN ('delivered','failed')
        AND ${MAIN_DELIVERY_GUARD}
        AND o.trip_id IN (SELECT t.id FROM commerce.matriz_delivery_trips t
                           WHERE t.environment = $1 AND t.courier_collaborator_id = $4 AND t.status = 'open')
      RETURNING o.id AS order_id`,
    [environment, input.order_id, input.reason, auth.collaboratorId],
  );
  if (!r.rows[0]) throw new Error('delivery_not_found');
  return { order_id: r.rows[0].order_id, delivery_status: 'failed' };
}

/** Resolve a trip ABERTA do entregador (posse). null = ele não tem rota aberta. */
async function resolveOpenTripId(
  auth: EntregadorAuth, environment: 'prod' | 'test', dbPool: Pool,
): Promise<string | null> {
  const r = await dbPool.query<{ id: string }>(
    `SELECT id FROM commerce.matriz_delivery_trips
      WHERE environment = $1 AND courier_collaborator_id = $2 AND status = 'open' AND deleted_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [environment, auth.collaboratorId],
  );
  return r.rows[0]?.id ?? null;
}

/** FECHA a rota DELE (km final, gasolina, obs). Ele não passa trip_id — é "minha
 *  rota aberta"; A não alcança a rota do B. Reusa a régua anti-dupla do painel. */
export async function closeEntregadorTrip(
  auth: EntregadorAuth,
  input: { km_end?: number | null; fuel_spent?: number | null; notes?: string | null },
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ trip_id: string; fuel_expense_id: string | null }> {
  const tripId = await resolveOpenTripId(auth, environment, dbPool);
  if (!tripId) throw new Error('trip_not_found');
  return closeMatrizTrip({ trip_id: tripId, ...input, environment }, dbPool);
}

/** Anexa comprovante à rota ABERTA DELE (não passa trip_id — "minha rota"). */
export async function addEntregadorReceipt(
  auth: EntregadorAuth,
  input: { bytes: Buffer; mime: string },
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizReceiptUploadResult> {
  const tripId = await resolveOpenTripId(auth, environment, dbPool);
  if (!tripId) throw new Error('trip_not_found');
  return addMatrizTripReceipt({ trip_id: tripId, bytes: input.bytes, mime: input.mime,
    environment, actor_label: `entregador:${auth.collaboratorId}`,
    upload_source: 'courier' }, dbPool);
}

/** Imagem do comprovante COM posse: a query junta a trip e exige que ela seja DELE.
 *  A pede o receiptId da rota do B → 0 linhas → 404. */
export async function getEntregadorReceiptImage(
  auth: EntregadorAuth,
  receiptId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const r = await dbPool.query<{ bytes: Buffer; mime: string }>(
    `SELECT b.bytes, m.mime
       FROM commerce.matriz_trip_receipt_blobs b
       JOIN commerce.matriz_trip_receipts m ON m.id = b.receipt_id
       JOIN commerce.matriz_delivery_trips t ON t.id = m.trip_id
      WHERE b.receipt_id = $1 AND b.environment = $2
        AND t.environment = $2 AND t.courier_collaborator_id = $3`,
    [receiptId, environment, auth.collaboratorId],
  );
  return r.rows[0] ?? null;
}
