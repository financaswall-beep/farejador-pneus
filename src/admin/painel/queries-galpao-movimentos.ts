// Trilha de movimentação do GALPÃO (0128) — o "filme" do estoque da matriz.
// O trigger commerce.log_wholesale_stock_movement grava TODA mudança de qty/custo em
// commerce.wholesale_stock_movements; este módulo é (a) o RÓTULO que a transação pendura
// pro trigger ler (set_config LOCAL app.galpao_*), (b) os wrappers do PAINEL que rodam
// Definir/Entrada/Remover dentro de transação rotulada, (c) a BAIXA MANUAL com motivo
// (quebra/perda — RECUSA acima do saldo, diferente da venda que nunca trava) e (d) a
// leitura do filme pra tela. Dado SÓ da matriz (zero grant parceiro, provado na 0128).
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  addWholesaleStockEntry, deleteWholesaleStock, setWholesaleStock, type WholesaleStockRow,
} from './queries-galpao.js';

export interface GalpaoMovContext {
  source: string; // quem mexeu: definir | entrada | compra | venda_atacado | cancelamento_* | varejo | baixa_manual | remocao
  reason?: string | null; // motivo livre (ex.: 'quebra: furou na desmontagem')
  ref?: string | null; // id do pedido/compra quando houver
}

/** Pendura o rótulo do movimento na TRANSAÇÃO ATUAL (set_config is_local=true — morre no
 *  COMMIT/ROLLBACK, nunca vaza pra outra transação do pool). O trigger da 0128 lê e grava.
 *  DEVE rodar dentro de transação aberta (fora dela é no-op inofensivo). */
export async function setGalpaoMovContext(client: PoolClient, ctx: GalpaoMovContext): Promise<void> {
  await client.query(
    `SELECT set_config('app.galpao_source', $1, true),
            set_config('app.galpao_reason', COALESCE($2, ''), true),
            set_config('app.galpao_ref',    COALESCE($3, ''), true)`,
    [ctx.source, ctx.reason ?? null, ctx.ref ?? null],
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
  input: Parameters<typeof setWholesaleStock>[0],
  dbPool: Pool = defaultPool,
): Promise<WholesaleStockRow> {
  return comRotulo(dbPool, { source: 'definir' }, (client) => setWholesaleStock(input, client));
}

/** "+ Entrada" da tela com rótulo 'entrada' (compra avulsa sem ficha de fornecedor). */
export async function addWholesaleStockEntryComRotulo(
  input: Parameters<typeof addWholesaleStockEntry>[0],
  dbPool: Pool = defaultPool,
): Promise<WholesaleStockRow> {
  return comRotulo(dbPool, { source: 'entrada' }, (client) => addWholesaleStockEntry(input, client));
}

/** Remover medida (tela) com rótulo 'remocao'. */
export async function deleteWholesaleStockComRotulo(
  measure: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<void> {
  return comRotulo(dbPool, { source: 'remocao' }, (client) => deleteWholesaleStock(measure, environment, client));
}

/** BAIXA MANUAL com motivo (quebra/perda/uso interno) — o ajuste honesto que faltava:
 *  antes, pneu quebrado virava "Definir" silencioso. RECUSA baixar mais do que tem
 *  (baixa_maior_que_estoque) — aqui NÃO é venda, não há dinheiro a proteger, então a
 *  régua é a verdade do galpão. NÃO mexe no custo médio (sai quantidade; o prejuízo
 *  fica legível no filme: qty × custo da época). Motivo é OBRIGATÓRIO. */
export async function applyGalpaoBaixaManual(
  input: { measure: string; quantity: number; reason: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<WholesaleStockRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const measure = input.measure.trim();
  const reason = (input.reason ?? '').trim();
  if (!measure) throw new Error('measure_required');
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error('quantity_invalid');
  if (reason.length < 2) throw new Error('reason_required');

  return comRotulo(dbPool, { source: 'baixa_manual', reason }, async (client) => {
    const r = await client.query<WholesaleStockRow>(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = quantity_on_hand - $3
        WHERE environment = $1 AND measure = $2 AND quantity_on_hand >= $3
        RETURNING measure, quantity_on_hand, unit_cost, min_quantity, notes, updated_at,
                  tire_width_mm, tire_aspect_ratio, tire_rim_diameter`,
      [environment, measure, input.quantity],
    );
    if (r.rows[0]) return r.rows[0];
    // 0 linhas: medida não existe OU saldo insuficiente — dizer QUAL (erro honesto)
    const cur = await client.query<{ quantity_on_hand: number }>(
      `SELECT quantity_on_hand FROM commerce.wholesale_stock WHERE environment = $1 AND measure = $2`,
      [environment, measure],
    );
    if (!cur.rows[0]) throw new Error('measure_not_found');
    throw new Error('baixa_maior_que_estoque:' + cur.rows[0].quantity_on_hand);
  });
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
