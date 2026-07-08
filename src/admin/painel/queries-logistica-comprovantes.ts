// Obra 300 (2026-07-05): fatia do banco da MATRIZ — comprovantes da rota + leitura por IA (0121/0122).
// VERBATIM das linhas 2879-3042 do queries.ts pré-obra (commit 2628748).
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
import type { MatrizExpenseCategory } from './queries-fiado-despesas.js';

export async function addMatrizTripReceipt(
  input: {
    trip_id: string;
    bytes: Buffer;
    mime: string;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ receipt_id: string; ai_status: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const aiStatus = env.MATRIZ_RECEIPT_AI ? 'pending' : 'skipped';
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const trip = await client.query(
      `SELECT 1 FROM commerce.matriz_delivery_trips
        WHERE id = $2 AND environment = $1 AND deleted_at IS NULL`,
      [environment, input.trip_id],
    );
    if (!trip.rows[0]) throw new Error('trip_not_found');
    // Teto de comprovantes por rota (banca 07-03, anti-abuso de storage — blob é BYTEA).
    const count = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM commerce.matriz_trip_receipts WHERE trip_id = $1`,
      [input.trip_id],
    );
    if (Number(count.rows[0]!.n) >= 50) throw new Error('receipt_limit');
    const receipt = await client.query<{ id: string }>(
      `INSERT INTO commerce.matriz_trip_receipts (environment, trip_id, mime, size_bytes, ai_status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [environment, input.trip_id, input.mime, input.bytes.length, aiStatus],
    );
    const receiptId = receipt.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.matriz_trip_receipt_blobs (receipt_id, environment, bytes)
       VALUES ($1, $2, $3)`,
      [receiptId, environment, input.bytes],
    );
    await client.query('COMMIT');
    return { receipt_id: receiptId, ai_status: aiStatus };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Bytes do comprovante pro GET de imagem do painel. */
export async function getMatrizTripReceiptImage(
  receiptId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const r = await dbPool.query<{ bytes: Buffer; mime: string }>(
    `SELECT b.bytes, m.mime
       FROM commerce.matriz_trip_receipt_blobs b
       JOIN commerce.matriz_trip_receipts m ON m.id = b.receipt_id
      WHERE b.receipt_id = $1 AND b.environment = $2`,
    [receiptId, environment],
  );
  return r.rows[0] ?? null;
}

/** Grava o veredito da IA sobre um comprovante. parsed → LANÇA a despesa (0120)
 *  na mesma transação, amarrada ao comprovante (idempotente: comprovante que já
 *  virou despesa não lança de novo). unreadable → só marca (lançar na mão).
 *  ANTI-DUPLA nas DUAS ordens (banca 07-03): se a rota JÁ lançou a despesa no
 *  FECHAMENTO (fuel_expense_id), o comprovante COLA nela como lastro — não cria
 *  segunda despesa da mesma gasolina. O FOR UPDATE na trip serializa com
 *  closeMatrizTrip (fecha a race leitura×fechamento nas duas direções). */
export async function recordReceiptAiResult(
  input: {
    receipt_id: string;
    result:
      | { kind: 'parsed'; category: MatrizExpenseCategory; amount: number; summary: string }
      | { kind: 'unreadable'; summary: string };
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ receipt_id: string; ai_status: string; ai_expense_id: string | null; linked_existing?: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const receipt = await client.query<{ id: string; trip_id: string; ai_expense_id: string | null }>(
      `SELECT r.id, r.trip_id, r.ai_expense_id
         FROM commerce.matriz_trip_receipts r
        WHERE r.id = $2 AND r.environment = $1
        FOR UPDATE`,
      [environment, input.receipt_id],
    );
    if (!receipt.rows[0]) throw new Error('receipt_not_found');
    if (receipt.rows[0].ai_expense_id) {
      // Já lançado (retry/dupla chamada) — não duplica despesa.
      await client.query('COMMIT');
      return { receipt_id: input.receipt_id, ai_status: 'parsed', ai_expense_id: receipt.rows[0].ai_expense_id };
    }

    if (input.result.kind === 'unreadable') {
      await client.query(
        `UPDATE commerce.matriz_trip_receipts
            SET ai_status = 'unreadable', ai_summary = $3
          WHERE id = $2 AND environment = $1`,
        [environment, input.receipt_id, input.result.summary],
      );
      await client.query('COMMIT');
      return { receipt_id: input.receipt_id, ai_status: 'unreadable', ai_expense_id: null };
    }

    // FOR UPDATE: serializa com closeMatrizTrip (que também trava a trip) —
    // e é aqui que a ordem "fechou lançando manual → leu o comprovante DEPOIS"
    // deixa de duplicar (achado P1 da banca 07-03).
    const trip = await client.query<{ trip_number: string; courier_name: string; started_at: string; fuel_expense_id: string | null }>(
      `SELECT trip_number, courier_name, started_at, fuel_expense_id
         FROM commerce.matriz_delivery_trips WHERE id = $1
         FOR UPDATE`,
      [receipt.rows[0].trip_id],
    );
    const existingFuelExpense = trip.rows[0]?.fuel_expense_id ?? null;
    if (existingFuelExpense) {
      await client.query(
        `UPDATE commerce.matriz_trip_receipts
            SET ai_status = 'parsed', ai_summary = $3, ai_expense_id = $4
          WHERE id = $2 AND environment = $1`,
        [environment, input.receipt_id, `${input.result.summary} · lastro da despesa do fechamento`, existingFuelExpense],
      );
      await client.query('COMMIT');
      return { receipt_id: input.receipt_id, ai_status: 'parsed', ai_expense_id: existingFuelExpense, linked_existing: true };
    }

    const rotaLabel = trip.rows[0]
      ? `${trip.rows[0].trip_number} · ${new Date(trip.rows[0].started_at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} — ${trip.rows[0].courier_name}`
      : 'Rota';
    const exp = await client.query<{ id: string }>(
      `INSERT INTO commerce.matriz_expenses
         (environment, category, description, amount, payment_status, paid_at, created_by)
       VALUES ($1, $2, $3, $4, 'paid', now(), 'ia-comprovante')
       RETURNING id`,
      [environment, input.result.category, `${rotaLabel} · ${input.result.summary}`, input.result.amount],
    );
    await client.query(
      `UPDATE commerce.matriz_trip_receipts
          SET ai_status = 'parsed', ai_summary = $3, ai_expense_id = $4
        WHERE id = $2 AND environment = $1`,
      [environment, input.receipt_id, input.result.summary, exp.rows[0]!.id],
    );
    await client.query('COMMIT');
    return { receipt_id: input.receipt_id, ai_status: 'parsed', ai_expense_id: exp.rows[0]!.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Colaboradores da MATRIZ (0124 — fatia 1: CADASTRO; decisão do dono 07-04) ───
// A identidade reusa a porta única (network.partner_people: username único na
// rede + senha scrypt). O vínculo/papel do staff da matriz vive em
// network.matriz_collaborators — SEPARADO dos parceiros (zero grant, provado na
// 0124). Nesta fatia a pessoa criada NÃO loga em lugar nenhum: sem vínculo de
// loja, authenticatePersonGlobal devolve null (people.ts). As telas por função
// (rota do entregador / frente de caixa do vendedor) entram nas próximas fatias.

