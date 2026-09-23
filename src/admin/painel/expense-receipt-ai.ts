import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getExpenseReceipt, getExpenseReceiptImage } from './expense-receipts.js';
import { readReceiptWithAI, EXPENSE_RECEIPT_EXTRACTOR_VERSION, EXPENSE_RECEIPT_PROMPT_VERSION, type ReceiptReading } from './receipt-ai.js';

/** A leitura não cria despesa. Só grava sugestões imutáveis em analytics. */
export async function readExpenseReceipt(id: string, retry = false, environment = env.FAREJADOR_ENV,
  db: Pool = pool, reader = readReceiptWithAI) {
  if (!env.MATRIZ_RECEIPT_AI) throw Error('receipt_ai_disabled');
  const token = randomUUID();
  const claimed = await db.query(`UPDATE commerce.matriz_expense_receipts r
    SET reading_token=$3,reading_started_at=now()
    WHERE environment=$1 AND id=$2 AND expense_id IS NULL
      AND (reading_token IS NULL OR reading_started_at<=now()-interval '5 minutes')
      AND ($4::boolean OR NOT EXISTS (SELECT 1 FROM analytics.expense_receipt_readings a
        WHERE a.environment=r.environment AND a.receipt_id=r.id)) RETURNING id`, [environment, id, token, retry]);
  if (!claimed.rows.length) return getExpenseReceipt(id, environment, db);
  let result: ReceiptReading | null = null;
  try {
    const image = await getExpenseReceiptImage(id, false, environment, db);
    if (!image) throw Error('receipt_image_missing');
    result = await reader(image.bytes, image.mime, 'expense');
  } catch { /* A imagem permanece disponível e o usuário pode preencher manualmente ou tentar de novo. */ }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const lease = await client.query(`SELECT id FROM commerce.matriz_expense_receipts
      WHERE environment=$1 AND id=$2 AND reading_token=$3 AND expense_id IS NULL FOR UPDATE`, [environment, id, token]);
    if (lease.rows.length) {
      const parsed = result?.kind === 'parsed' ? result : null;
      await client.query(`INSERT INTO analytics.expense_receipt_readings
        (environment,receipt_id,status,extractor_version,prompt_version,model,confidence_level,
         confidence,amount,category,merchant,document_date,summary,previous_reading_id)
        VALUES ($1::env_t,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13,
          (SELECT id FROM analytics.expense_receipt_readings WHERE environment=$1::env_t AND receipt_id=$2::uuid ORDER BY created_at DESC,id DESC LIMIT 1))`,
      [environment, id, result?.kind ?? 'failed', result?.extractor_version ?? EXPENSE_RECEIPT_EXTRACTOR_VERSION,
        result?.prompt_version ?? EXPENSE_RECEIPT_PROMPT_VERSION, result?.model ?? env.OPENAI_MODEL,
        parsed?.confidence == null ? 'unknown' : parsed.confidence >= 0.7 ? 'high' : 'low',
        parsed?.confidence ?? null, parsed?.amount ?? null, parsed?.category ?? null, parsed?.merchant ?? null,
        parsed?.document_date ?? null, result?.summary ?? 'Não foi possível ler agora. Preencha os campos ou tente novamente.']);
      await client.query(`UPDATE commerce.matriz_expense_receipts SET reading_token=NULL,reading_started_at=NULL
        WHERE environment=$1 AND id=$2 AND reading_token=$3`, [environment, id, token]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  return getExpenseReceipt(id, environment, db);
}
