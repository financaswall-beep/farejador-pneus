/**
 * PESQUISA DE SATISFAÇÃO (estrelas, 0105) — lado bot.
 *
 * Fluxo (TUDO atrás da flag SATISFACTION_SURVEY; off = dormente, zero efeito):
 *   - DISPARO (worker): quando o parceiro marca um pedido do bot como entregue
 *     (delivery → delivered_at) ou retirado (pickup → retrieved_at), o dispatcher
 *     enfileira UMA pesquisa (dedup por pedido) e manda a pergunta no WhatsApp.
 *   - CAPTURA (inbound): o cliente responde "5" / "⭐⭐⭐⭐⭐" → casa com a pesquisa
 *     pendente da conversa e grava a nota (1-5). Determinístico, sem LLM.
 *   - EXPIRAÇÃO (worker): pendente sem resposta na janela (24h) vira 'expired'.
 *
 * Espelha o padrão da foto sob demanda (photo-requests.ts): worker no server,
 * envio via sender.ts, endereço de volta LIDO do próprio registro (nunca adivinha).
 * Diferença: a NOTA vem do CLIENTE (não do parceiro) — captura é no inbound.
 */

import type { PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { sendMessage } from './sender.js';
import { parseRating, surveyQuestion, thankYouText } from './satisfaction-rating.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { enqueueAccessoryText } from './outbox-accessory.js';

const WORKER_INTERVAL_MS = 60_000;
// Janela de "recém-finalizado" que o dispatcher varre — evita inundar pedidos
// antigos quando a flag for ligada (só os finalizados nas últimas 2h entram).
const RECENT_WINDOW = '2 hours';

// ─── Captura da nota (chamada no inbound, em runAgentV2) ──────────────────────

/**
 * Se houver pesquisa PENDENTE pra esta conversa (dentro da janela) E a mensagem
 * do cliente for uma nota, grava a nota + agradece e devolve true (o caller pula
 * o LLM — é resposta de pesquisa, não pergunta). Senão devolve false (segue o bot).
 * Dormente com a flag off.
 */
export async function tryCaptureSurveyReply(
  client: PoolClient,
  environment: Environment,
  chatwootConversationId: number,
  customerText: string | null,
): Promise<boolean> {
  if (!env.SATISFACTION_SURVEY) return false;
  if (!customerText) return false;

  const pend = await client.query<{ id: string }>(
    `SELECT id FROM commerce.satisfaction_surveys
      WHERE environment = $1 AND conversation_id = $2 AND status = 'pending' AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [environment, chatwootConversationId],
  );
  if (pend.rowCount !== 1) return false;

  const rating = parseRating(customerText);
  if (rating == null) return false; // não é nota → deixa o bot responder normal

  // Grava a nota (idempotente no estado: só transita de pending).
  const upd = await client.query(
    `UPDATE commerce.satisfaction_surveys
        SET status = 'answered', rating = $2, comment = $3, answered_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [pend.rows[0]!.id, rating, customerText.slice(0, 500)],
  );
  if (upd.rowCount !== 1) return false; // corrida: já respondida → deixa o bot seguir

  try {
    if (env.BOT_OUTBOX) {
      await enqueueAccessoryText(client, { environment, chatwootConversationId,
        kind: 'survey_text', body: thankYouText(rating),
        idempotencyKey: `survey-thanks:${pend.rows[0]!.id}` });
    } else {
      await sendMessage(chatwootConversationId, thankYouText(rating));
    }
  } catch (err) {
    logger.error({ err, surveyId: pend.rows[0]!.id }, 'satisfaction: agradecimento nao enviado');
  }
  logger.info({ surveyId: pend.rows[0]!.id, rating }, 'satisfaction: nota capturada');
  return true;
}

// ─── Disparo: enfileira + manda a pergunta (worker, bot-pool) ────────────────

/**
 * Acha pedidos do BOT recém-finalizados (entregue/retirado) que ainda não têm
 * pesquisa, enfileira UMA (dedup atômico pelo índice único por pedido) e manda a
 * pergunta no WhatsApp. O endereço de volta sai do espelho do pedido → conversa.
 */
async function dispatchNewSurveys(): Promise<void> {
  const cands = await pool.query<{
    partner_order_id: string;
    unit_id: string;
    environment: string;
    fulfillment_mode: string;
    conv: string;
    contact: string | null;
    loja: string;
  }>(
    `SELECT po.id AS partner_order_id, po.unit_id, po.environment::text AS environment,
            po.fulfillment_mode, cv.chatwoot_conversation_id AS conv,
            ct.chatwoot_contact_id AS contact, COALESCE(pu.display_name, u.name) AS loja
       FROM commerce.partner_orders po
       JOIN commerce.orders o ON o.partner_order_id = po.id AND o.environment = po.environment
       JOIN core.conversations cv ON cv.id = o.source_conversation_id
       LEFT JOIN core.contacts ct ON ct.id = cv.contact_id
       JOIN core.units u ON u.id = po.unit_id
       LEFT JOIN network.partner_units pu ON pu.unit_id = po.unit_id AND pu.environment = po.environment
      WHERE po.deleted_at IS NULL AND po.status = 'paid'
        AND ( (po.fulfillment_mode = 'pickup'   AND po.retrieved_at >= now() - interval '${RECENT_WINDOW}')
           OR (po.fulfillment_mode = 'delivery' AND po.delivered_at  >= now() - interval '${RECENT_WINDOW}') )
        AND cv.chatwoot_conversation_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM commerce.satisfaction_surveys s WHERE s.partner_order_id = po.id)
      LIMIT 50`,
  );

  for (const r of cands.rows) {
    // Claim atômico: o índice único parcial por pedido garante 1 pesquisa só.
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO commerce.satisfaction_surveys
         (environment, unit_id, partner_order_id, fulfillment_mode, conversation_id, contact_id, status, asked_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', now())
       ON CONFLICT (partner_order_id) WHERE partner_order_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [r.environment, r.unit_id, r.partner_order_id, r.fulfillment_mode, Number(r.conv), r.contact ? Number(r.contact) : null],
    );
    if (ins.rowCount !== 1) continue; // outra réplica já pegou

    try {
      if (env.BOT_OUTBOX) {
        await enqueueAccessoryText(pool, { environment: r.environment as Environment,
          chatwootConversationId: Number(r.conv), kind: 'survey_text',
          body: surveyQuestion(r.loja), idempotencyKey: `survey-ask:${ins.rows[0]!.id}` });
      } else {
        await sendMessage(Number(r.conv), surveyQuestion(r.loja));
      }
    } catch (err) {
      // Pergunta que falhou fica logada; a pesquisa permanece pending (será
      // expirada na janela). Não reabre pra não mandar 2x.
      logger.error({ err, partnerOrderId: r.partner_order_id }, 'satisfaction: pergunta nao enviada');
    }
  }
  if (cands.rowCount && cands.rowCount > 0) {
    logger.info({ count: cands.rowCount }, 'satisfaction: pesquisas disparadas');
  }
}

/**
 * Disparo da MATRIZ (0131): a matriz virou loja e é quem MAIS entrega, mas o
 * pedido dela vive em commerce.orders (unit 'main'), SEM partner_order_id — então
 * o dispatch acima nunca a via. Aqui o segundo trilho: entrega da main marcada
 * 'delivered' (setMatrizDeliveryStatus) recém-finalizada, sem pesquisa, ganha UMA
 * (dedup pelo índice único parcial em order_id). Retirada da matriz não tem marco
 * de escrita (commerce.orders não tem retrieved_at) → fora do escopo, de propósito.
 * A captura da nota (por conversation_id) e o expirador servem os DOIS trilhos.
 */
export async function dispatchMatrizDeliverySurveys(): Promise<void> {
  const cands = await pool.query<{
    order_id: string; unit_id: string; environment: string;
    conv: string; contact: string | null; loja: string;
  }>(
    `SELECT o.id AS order_id, o.unit_id, o.environment::text AS environment,
            cv.chatwoot_conversation_id AS conv, ct.chatwoot_contact_id AS contact, u.name AS loja
       FROM commerce.orders o
       JOIN core.units u ON u.id = o.unit_id AND u.environment = o.environment AND u.slug = 'main'
       JOIN core.conversations cv ON cv.id = o.source_conversation_id
       LEFT JOIN core.contacts ct ON ct.id = cv.contact_id
      WHERE o.status = 'delivered' AND o.fulfillment_mode = 'delivery'
        AND o.delivery_status = 'delivered'
        AND o.delivered_at >= now() - interval '${RECENT_WINDOW}'
        AND cv.chatwoot_conversation_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM commerce.satisfaction_surveys s WHERE s.order_id = o.id)
      LIMIT 50`,
  );

  for (const r of cands.rows) {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO commerce.satisfaction_surveys
         (environment, unit_id, order_id, fulfillment_mode, conversation_id, contact_id, status, asked_at)
       VALUES ($1, $2, $3, 'delivery', $4, $5, 'pending', now())
       ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [r.environment, r.unit_id, r.order_id, Number(r.conv), r.contact ? Number(r.contact) : null],
    );
    if (ins.rowCount !== 1) continue; // outra réplica já pegou

    try {
      if (env.BOT_OUTBOX) {
        await enqueueAccessoryText(pool, { environment: r.environment as Environment,
          chatwootConversationId: Number(r.conv), kind: 'survey_text',
          body: surveyQuestion(r.loja), idempotencyKey: `survey-ask:${ins.rows[0]!.id}` });
      } else {
        await sendMessage(Number(r.conv), surveyQuestion(r.loja));
      }
    } catch (err) {
      logger.error({ err, orderId: r.order_id }, 'satisfaction matriz: pergunta nao enviada');
    }
  }
  if (cands.rowCount && cands.rowCount > 0) {
    logger.info({ count: cands.rowCount }, 'satisfaction matriz: pesquisas disparadas');
  }
}

// ─── Expiração ────────────────────────────────────────────────────────────────

async function expireStaleSurveys(): Promise<void> {
  const expired = await pool.query(
    `UPDATE commerce.satisfaction_surveys
        SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now()
      RETURNING id`,
  );
  if (expired.rowCount && expired.rowCount > 0) {
    logger.info({ count: expired.rowCount }, 'satisfaction: pesquisas expiradas');
  }
}

// ─── Worker (server.ts) ───────────────────────────────────────────────────────

/**
 * Liga o worker (60s): dispara pesquisas novas + expira as vencidas. Atrás da
 * flag SATISFACTION_SURVEY: off = não agenda nada. Retorna stop() pro shutdown.
 */
export function startSatisfactionSurveyWorker(): () => void {
  if (!env.SATISFACTION_SURVEY) {
    return () => undefined;
  }
  const timer = setInterval(() => {
    dispatchNewSurveys().catch((err) => logger.error({ err }, 'satisfaction dispatcher: varredura falhou'));
    dispatchMatrizDeliverySurveys().catch((err) => logger.error({ err }, 'satisfaction matriz dispatcher: varredura falhou'));
    expireStaleSurveys().catch((err) => logger.error({ err }, 'satisfaction expirer: varredura falhou'));
  }, WORKER_INTERVAL_MS);
  logger.info('satisfaction survey: worker ligado (SATISFACTION_SURVEY on)');
  return () => clearInterval(timer);
}
