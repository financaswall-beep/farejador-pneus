import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  beginReceiptAiAttempt,
  completeReceiptAiAttempt,
  type ReceiptAttemptResult,
} from './queries-logistica-comprovantes-review.js';
import {
  readReceiptWithAI,
  RECEIPT_EXTRACTOR_VERSION,
  RECEIPT_PROMPT_VERSION,
} from './receipt-ai.js';

export interface ReceiptSuggestionProcessResult {
  attempt_id: string;
  ai_status: 'parsed' | 'unreadable' | 'pending';
  workflow_status: 'review_required';
  suggestion_status: 'suggested' | 'unreadable' | 'failed';
  ai_summary: string;
}

function safeAiErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown_error';
  const safe = message.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 120);
  return safe || 'unknown_error';
}

export async function extractReceiptSuggestion(
  input: {
    receipt_id: string;
    bytes: Buffer;
    mime: string;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<ReceiptSuggestionProcessResult> {
  const started = await beginReceiptAiAttempt({
    receipt_id: input.receipt_id,
    environment: input.environment,
    model: env.OPENAI_MODEL,
    extractor_version: RECEIPT_EXTRACTOR_VERSION,
    prompt_version: RECEIPT_PROMPT_VERSION,
  }, dbPool);

  try {
    const reading = await readReceiptWithAI(input.bytes, input.mime);
    const result: ReceiptAttemptResult = reading.kind === 'parsed'
      ? {
          status: 'suggested', amount: reading.amount, category: reading.category,
          merchant: reading.merchant, document_date: reading.document_date,
          confidence: reading.confidence, summary: reading.summary,
        }
      : { status: 'unreadable', summary: reading.summary };
    const completed = await completeReceiptAiAttempt({
      attempt_id: started.attempt_id,
      environment: input.environment,
      result,
    }, dbPool);
    return { attempt_id: started.attempt_id, ai_status: completed.ai_status,
      workflow_status: completed.workflow_status, suggestion_status: completed.status,
      ai_summary: reading.summary };
  } catch (error) {
    const errorCode = safeAiErrorCode(error);
    const summary = 'A leitura automática falhou; o comprovante continua aguardando revisão.';
    const completed = await completeReceiptAiAttempt({
      attempt_id: started.attempt_id,
      environment: input.environment,
      result: { status: 'failed', error_code: errorCode, summary },
    }, dbPool);
    return { attempt_id: started.attempt_id, ai_status: completed.ai_status,
      workflow_status: completed.workflow_status, suggestion_status: completed.status,
      ai_summary: summary };
  }
}
