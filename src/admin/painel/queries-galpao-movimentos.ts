// Trilha de movimentação do GALPÃO (0128) — o "filme" do estoque da matriz.
// O trigger commerce.log_wholesale_stock_movement grava TODA mudança de qty/custo em
// commerce.wholesale_stock_movements; este módulo é (a) o RÓTULO que a transação pendura
// pro trigger ler (set_config LOCAL app.galpao_*), (b) os wrappers do PAINEL que rodam
// Definir/Entrada/Remover dentro de transação rotulada, (c) a BAIXA MANUAL com motivo
// (quebra/perda — RECUSA acima do saldo, diferente da venda que nunca trava) e (d) a
// leitura do filme pra tela. Dado SÓ da matriz (zero grant parceiro, provado na 0128).
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  addWholesaleStockEntry, deleteWholesaleStock, setWholesaleStock, type WholesaleStockRow,
} from './queries-galpao.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
import { postMatrizInventoryAdjustmentsByMovementRef } from './matriz-ledger-inventory.js';

export interface GalpaoMovContext {
  source: string; // quem mexeu: definir | entrada | compra | venda_atacado | cancelamento_* | varejo | baixa_manual | remocao
  nature?: string | null;
  reason?: string | null; // motivo livre (ex.: 'quebra: furou na desmontagem')
  ref?: string | null; // id do pedido/compra quando houver
}

/** Pendura o rótulo do movimento na TRANSAÇÃO ATUAL (set_config is_local=true — morre no
 *  COMMIT/ROLLBACK, nunca vaza pra outra transação do pool). O trigger da 0128 lê e grava.
 *  DEVE rodar dentro de transação aberta (fora dela é no-op inofensivo). */
export async function setGalpaoMovContext(client: PoolClient, ctx: GalpaoMovContext): Promise<void> {
  await client.query(
    `SELECT set_config('app.galpao_source', $1, true),
            set_config('app.galpao_nature', COALESCE($2, ''), true),
            set_config('app.galpao_reason', COALESCE($3, ''), true),
            set_config('app.galpao_ref',    COALESCE($4, ''), true)`,
    [ctx.source, ctx.nature ?? null, ctx.reason ?? null, ctx.ref ?? null],
  );
}

/** Roda `fn` numa transação curta já rotulada — o molde dos wrappers do painel. */
async function comRotulo<T>(
  dbPool: Pool,
  ctx: GalpaoMovContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await setGalpaoMovContext(client, ctx);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Definir (upsert da tela) com rótulo 'definir' no filme. Mesmo contrato do setWholesaleStock. */
export async function setWholesaleStockComRotulo(
  input: Parameters<typeof setWholesaleStock>[0] & {
    reason?: string;
    actor_label?: string;
  },
  dbPool: Pool = defaultPool,
): Promise<WholesaleStockRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const movementRef = randomUUID();
  const reason = input.reason?.trim() ?? '';
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const catalogMeasure = await resolveMeasureInCatalog(client, environment, input.measure);
    if (!catalogMeasure) throw new Error('measure_not_in_catalog');
    const current = await client.query<{ quantity_on_hand: number; unit_cost: string }>(
      `SELECT quantity_on_hand,unit_cost::text
         FROM commerce.wholesale_stock
        WHERE environment=$1 AND measure=$2
        FOR UPDATE`,
      [environment, catalogMeasure.measure],
    );
    const before = current.rows[0];
    const nextCostCents = Math.round(Number(input.unit_cost ?? 0) * 100);
    const currentCostCents = Math.round(Number(before?.unit_cost ?? 0) * 100);
    const valueChanged = !before
      || Number(before.quantity_on_hand) !== input.quantity_on_hand
      || currentCostCents !== nextCostCents;
    if (valueChanged && reason.length < 2) throw new Error('reason_required');

    await setGalpaoMovContext(client, {
      source: 'definir',
      nature: 'inventory_count',
      reason: valueChanged ? reason : (reason || 'atualização de estoque mínimo/observações'),
      ref: movementRef,
    });
    const result = await setWholesaleStock(input, client);
    await postMatrizInventoryAdjustmentsByMovementRef(
      client, environment, movementRef, input.actor_label ?? 'system:stock-adjustment',
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** "+ Entrada" da tela com rótulo 'entrada' (compra avulsa sem ficha de fornecedor). */
export async function addWholesaleStockEntryComRotulo(
  input: Parameters<typeof addWholesaleStockEntry>[0] & {
    entry_nature?: 'inventory_found' | 'owner_contribution' | 'opening_balance' | 'other';
    reason?: string; actor_label?: string; idempotency_key?: string;
  },
  dbPool: Pool = defaultPool,
): Promise<WholesaleStockRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const nature = input.entry_nature;
  const reason = input.reason?.trim() ?? '';
  if (!nature) throw new Error('stock_entry_nature_required');
  if (reason.length < 2) throw new Error('reason_required');
  const operation = { environment, domain: 'stock.entry',
    idempotencyKey: input.idempotency_key ?? '', fingerprint: operationFingerprint({
      measure: input.measure.trim(), quantity_in: input.quantity_in,
      brand: input.brand?.trim() || null, unit_cost: input.unit_cost,
      entry_nature: nature, reason,
    }) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<WholesaleStockRow>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    await setGalpaoMovContext(client, {
      source: 'entrada', nature, reason, ref: operation.idempotencyKey,
    });
    const result = integrityResult(await addWholesaleStockEntry(input, client));
    const entity = await client.query<{ id: string }>(
      `SELECT id FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`,
      [environment, result.measure],
    );
    const entityId = entity.rows[0]?.id;
    if (!entityId) throw new Error('stock_measure_missing');
    await recordIntegrityEvent(client, { environment, domain: 'stock',
      entityTable: 'commerce.wholesale_stock', entityId, eventType: 'manual_entry',
      actorLabel: input.actor_label, idempotencyKey: operation.idempotencyKey,
      after: { measure: result.measure, brand: result.brand ?? input.brand ?? null,
        quantity_in: input.quantity_in,
        unit_cost: input.unit_cost, nature, reason } });
    await completeIntegrityOperation(client, operation, 'commerce.wholesale_stock', entityId, result);
    await postMatrizInventoryAdjustmentsByMovementRef(
      client, environment, operation.idempotencyKey, input.actor_label,
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Remover medida (tela) com rótulo 'remocao'. */
export async function deleteWholesaleStockComRotulo(
  measure: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<void> {
  const movementRef = randomUUID();
  return comRotulo(dbPool, { source: 'remocao', nature: 'inventory_writeoff',
    reason: 'medida removida manualmente', ref: movementRef }, async (client) => {
    await deleteWholesaleStock(measure, environment, client);
    await postMatrizInventoryAdjustmentsByMovementRef(
      client, environment, movementRef, 'system:stock-removal',
    );
  });
}

/** BAIXA MANUAL com motivo (quebra/perda/uso interno) — o ajuste honesto que faltava:
 *  antes, pneu quebrado virava "Definir" silencioso. RECUSA baixar mais do que tem
 *  (baixa_maior_que_estoque) — aqui NÃO é venda, não há dinheiro a proteger, então a
 *  régua é a verdade do galpão. NÃO mexe no custo médio (sai quantidade; o prejuízo
 *  fica legível no filme: qty × custo da época). Motivo é OBRIGATÓRIO. */
export async function applyGalpaoBaixaManual(
  input: { measure: string; quantity: number; reason: string;
    nature?: 'breakage' | 'loss' | 'internal_use' | 'other';
    actor_label?: string; idempotency_key?: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<WholesaleStockRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const measure = input.measure.trim();
  const reason = (input.reason ?? '').trim();
  if (!measure) throw new Error('measure_required');
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error('quantity_invalid');
  if (reason.length < 2) throw new Error('reason_required');
  if (!input.nature) throw new Error('stock_decrement_nature_required');
  const operation = { environment, domain: 'stock.manual_decrement',
    idempotencyKey: input.idempotency_key ?? '', fingerprint: operationFingerprint({
      measure, quantity: input.quantity, nature: input.nature, reason,
    }) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<WholesaleStockRow>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    await setGalpaoMovContext(client, { source: 'baixa_manual',
      nature: input.nature, reason, ref: operation.idempotencyKey });
    const r = await client.query<WholesaleStockRow & { id: string }>(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = quantity_on_hand - $3
        WHERE environment = $1 AND measure = $2 AND quantity_on_hand >= $3
        RETURNING id, measure, quantity_on_hand, unit_cost, min_quantity, notes, updated_at,
                  tire_width_mm, tire_aspect_ratio, tire_rim_diameter`,
      [environment, measure, input.quantity],
    );
    if (r.rows[0]) {
      const { id, ...row } = r.rows[0];
      const result = integrityResult(row);
      await recordIntegrityEvent(client, { environment, domain: 'stock',
        entityTable: 'commerce.wholesale_stock', entityId: id,
        eventType: 'manual_decrement', actorLabel: input.actor_label,
        idempotencyKey: operation.idempotencyKey,
        after: { measure, quantity: input.quantity, nature: input.nature, reason } });
      await completeIntegrityOperation(client, operation, 'commerce.wholesale_stock', id, result);
      await postMatrizInventoryAdjustmentsByMovementRef(
        client, environment, operation.idempotencyKey, input.actor_label,
      );
      await client.query('COMMIT');
      return result;
    }
    // 0 linhas: medida não existe OU saldo insuficiente — dizer QUAL (erro honesto)
    const cur = await client.query<{ quantity_on_hand: number }>(
      `SELECT quantity_on_hand FROM commerce.wholesale_stock WHERE environment = $1 AND measure = $2`,
      [environment, measure],
    );
    if (!cur.rows[0]) throw new Error('measure_not_found');
    throw new Error('baixa_maior_que_estoque:' + cur.rows[0].quantity_on_hand);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface GalpaoMovementRow {
  measure: string;
  op: 'insert' | 'update' | 'delete';
  qty_before: number;
  qty_after: number;
  qty_delta: number;
  cost_before: string | null;
  cost_after: string | null;
  source: string;
  reason: string | null;
  ref: string | null;
  created_at: string;
}

/** O filme pra tela: últimos movimentos (todos ou de UMA medida), mais novo primeiro. */
export async function listGalpaoMovements(
  opts: { measure?: string | null; limit?: number; environment?: 'prod' | 'test' } = {},
  dbPool: Pool = defaultPool,
): Promise<GalpaoMovementRow[]> {
  const environment = opts.environment ?? env.FAREJADOR_ENV;
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const measure = opts.measure?.trim() || null;
  const r = await dbPool.query<GalpaoMovementRow>(
    `SELECT measure, op, qty_before, qty_after, qty_delta, cost_before, cost_after,
            source, reason, ref, created_at
       FROM commerce.wholesale_stock_movements
      WHERE environment = $1 AND ($2::text IS NULL OR measure = $2)
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [environment, measure, limit],
  );
  return r.rows;
}
