// Obra 300 (2026-07-05): fatia do banco da MATRIZ — registrar pedido manual/walk-in + cancelar + raio de entrega.
// VERBATIM das linhas 514-711 do queries.ts pré-obra (commit 2628748).
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { applyWholesaleStockDecrement, applyWholesaleStockReturn } from './wholesale-stock.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyMatrizGalpaoReturn, applyMatrizRetailCostSnapshot } from '../../atendente-v2/wholesale-stock-read.js';
import { hashPassword } from '../../parceiro/password.js';
import type { RegisterManualOrderInput, CancelManualOrderInput } from './queries-pedidos.js';
import { hasMatrizSellerColumn } from './payroll-schema.js';

async function resolveContactId(
  dbPool: Pick<Pool, 'query'>,
  environment: 'prod' | 'test',
  conversationId: string,
  contactId?: string,
): Promise<string> {
  if (contactId) return contactId;

  const result = await dbPool.query<{ contact_id: string | null }>(
    `SELECT contact_id
     FROM core.conversations
     WHERE environment = $1 AND id = $2`,
    [environment, conversationId],
  );

  const resolved = result.rows[0]?.contact_id;
  if (!resolved) {
    throw new Error('conversation_contact_not_found');
  }

  return resolved;
}

/**
 * Define o raio de ENTREGA (km) de um parceiro pela MATRIZ (proximidade-primeiro
 * Fase 2 — Wallace preenche o raio dos parceiros de uma vez). Grava
 * network.partner_units.delivery_radius_km.
 *
 * Respeita a autonomia do parceiro: a matriz só PREENCHE o raio de quem JÁ faz
 * entrega (service_mode delivery/both) — não força entrega em quem escolheu só
 * retirada. LIMPAR (null) é sempre permitido. NUMERIC(6,2) → o route valida ≤9999,99.
 */
export async function setPartnerUnitDeliveryRadius(
  environment: 'prod' | 'test',
  partnerUnitId: string,
  deliveryRadiusKm: number | null,
  dbPool: Pool = defaultPool,
): Promise<{ updated: boolean; reason?: 'not_found' | 'pickup_only' }> {
  const unit = await dbPool.query<{ service_mode: string }>(
    `SELECT service_mode FROM network.partner_units
      WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
    [partnerUnitId, environment],
  );
  if (unit.rowCount !== 1) return { updated: false, reason: 'not_found' };
  const mode = unit.rows[0]!.service_mode;
  if (deliveryRadiusKm !== null && mode !== 'delivery' && mode !== 'both') {
    return { updated: false, reason: 'pickup_only' };
  }
  const res = await dbPool.query(
    `UPDATE network.partner_units
        SET delivery_radius_km = $3
      WHERE id = $1 AND environment = $2`,
    [partnerUnitId, environment, deliveryRadiusKm],
  );
  return { updated: (res.rowCount ?? 0) > 0 };
}

export async function registerManualOrder(
  input: RegisterManualOrderInput,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  let orderId: string;
  try {
    await client.query('BEGIN');
    const contactId = await resolveContactId(client as unknown as Pool, environment, input.conversation_id, input.contact_id);
    const result = await client.query<{ order_id: string }>(
      `SELECT commerce.register_manual_order(
         $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12
       ) AS order_id`,
      [environment, contactId, input.conversation_id, input.draft_id ?? null, input.unit_id ?? null,
       JSON.stringify(input.items), input.payment_method, input.fulfillment_mode,
       input.delivery_address ?? null, input.actor_label, input.idempotency_key, input.source_tag ?? null],
    );
    orderId = result.rows[0]!.order_id;
    if (input.seller_collaborator_id && await hasMatrizSellerColumn(client, 'orders')) {
      const seller = await client.query(
        `UPDATE commerce.orders o SET seller_collaborator_id=COALESCE(o.seller_collaborator_id,mc.id)
          FROM network.matriz_collaborators mc
         WHERE o.id=$1 AND o.environment=$2 AND mc.id=$3
           AND mc.environment=o.environment AND mc.revoked_at IS NULL RETURNING o.id`,
        [orderId, environment, input.seller_collaborator_id],
      );
      if (!seller.rows[0]) throw new Error('seller_collaborator_not_found');
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }

  // Venda MANUAL que cai na MATRIZ (unit vazia → 'main' dentro da função SQL) também congela
  // o custo do galpão nos itens (0117). NÃO baixa estoque aqui (comportamento de hoje: só
  // walk-in e bot baixam) — este é só o retrato do custo pro lucro do varejo sair certo.
  if (env.WHOLESALE_MATRIZ_RETAIL_COST) {
    const m = await dbPool.query<{ id: string }>(
      `SELECT id FROM core.units WHERE environment = $1 AND slug = 'main' LIMIT 1`,
      [environment],
    );
    const matrizId = m.rows[0]?.id ?? null;
    if (matrizId && (!input.unit_id || input.unit_id === matrizId)) {
      await applyMatrizRetailCostSnapshot(
        dbPool as unknown as PoolClient,
        environment,
        orderId,
        input.items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
        true,
      );
    }
  }

  return { order_id: orderId };
}

export { registerWalkinOrder } from './walkin-order.js';

export async function cancelManualOrder(
  input: CancelManualOrderInput,
  dbPool: Pool = defaultPool,
): Promise<{ cancelled: true }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  // Cancelamento + devolução do galpão ATÔMICOS: o pedido do VAREJO da matriz que baixou
  // o galpão o recompõe ao cancelar (espelho da baixa, guiado pela trilha). Se a devolução
  // falha, o cancelamento faz rollback junto (mais forte que a baixa, best-effort na venda).
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT commerce.cancel_manual_order($1, $2, $3)', [
      input.order_id,
      input.actor_label,
      input.reason,
    ]);
    await applyMatrizGalpaoReturn(client, environment, input.order_id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { cancelled: true };
}

// ─── Onboarding de parceiro (Etapa 1) ────────────────────────────────────────
