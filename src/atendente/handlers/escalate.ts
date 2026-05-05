import type { PoolClient } from 'pg';
import { ChatwootApiClient } from '../../admin/chatwoot-api.client.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import type { EscalateAction } from '../../shared/zod/agent-actions.js';

const REASON_LABELS: Record<EscalateAction['reason'], string> = {
  ready_to_close: 'Pronto para fechar',
  customer_requested: 'Cliente pediu atendimento humano',
  validator_blocked: 'Bot bloqueado por validação',
  confidence_low: 'Confiança insuficiente para responder',
  pending_expired: 'Confirmação pendente expirou',
  other: 'Outro',
};

function formatNoteBody(action: EscalateAction): string {
  const label = REASON_LABELS[action.reason] ?? action.reason;
  return `🤖 *Atendente automático escalou esta conversa*\n\n*Motivo:* ${label}\n\n${action.summary_text}`;
}

/**
 * Envia nota interna no Chatwoot informando o atendente humano sobre a escalada.
 *
 * - Só executa se CHATWOOT_API_BASE_URL, CHATWOOT_API_TOKEN e CHATWOOT_ACCOUNT_ID
 *   estiverem configurados.
 * - Falha na API não lança exceção — apenas loga warn. O estado no banco já foi
 *   persistido antes desta chamada (fora da transação do Worker).
 * - Idempotência por DB: `syncEscalation` garante que não há duas escaladas
 *   abertas com o mesmo motivo; a nota Chatwoot pode aparecer duplicada em replay,
 *   mas isso é aceitável em produção (shadow não envia nada).
 */
export async function postEscalateNote(
  client: PoolClient,
  environment: string,
  conversationId: string,
  action: EscalateAction,
): Promise<void> {
  if (!env.CHATWOOT_API_BASE_URL || !env.CHATWOOT_API_TOKEN || !env.CHATWOOT_ACCOUNT_ID) {
    logger.debug(
      { environment, conversation_id: conversationId, reason: action.reason },
      'escalate handler: Chatwoot API não configurada — nota interna ignorada',
    );
    return;
  }

  const conv = await client.query<{ chatwoot_conversation_id: number }>(
    `SELECT chatwoot_conversation_id
     FROM core.conversations
     WHERE environment = $1
       AND id = $2
     LIMIT 1`,
    [environment, conversationId],
  );

  if (!conv.rows[0]) {
    logger.warn(
      { environment, conversation_id: conversationId },
      'escalate handler: conversa não encontrada em core.conversations — nota ignorada',
    );
    return;
  }

  const chatwootConversationId = conv.rows[0].chatwoot_conversation_id;
  const noteBody = formatNoteBody(action);

  try {
    const apiClient = new ChatwootApiClient();
    await apiClient.createNote(chatwootConversationId, noteBody);
    logger.info(
      {
        environment,
        conversation_id: conversationId,
        chatwoot_conversation_id: chatwootConversationId,
        reason: action.reason,
      },
      'escalate handler: nota interna criada no Chatwoot',
    );
  } catch (err) {
    logger.warn(
      {
        environment,
        conversation_id: conversationId,
        chatwoot_conversation_id: chatwootConversationId,
        reason: action.reason,
        error: err instanceof Error ? err.message : String(err),
      },
      'escalate handler: falha ao criar nota no Chatwoot (não crítico — estado DB já salvo)',
    );
  }
}
