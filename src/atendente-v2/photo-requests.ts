/**
 * FOTO SOB DEMANDA (0094) — lado bot: criação do pedido, despacho da foto
 * pro cliente e expiração com fallback honesto.
 *
 * Princípio de correlação (decisão Wallace 2026-06-10): a foto NUNCA chega
 * solta. O pedido de foto nasce com o endereço de volta DENTRO dele
 * (conversation_id = id da conversa no Chatwoot) e o botão da câmera vive no
 * card — a foto sobe grudada no photo_request_id. O bot nunca adivinha o
 * destino: ele LÊ. 5 ou 50 atendimentos simultâneos não misturam.
 *
 * Tudo determinístico (ZERO LLM): quem manda a foto/fallback é código.
 * O LLM só cria o pedido via tool `pedir_foto` (tools.ts), com guards POR
 * CÓDIGO (máx 2 ativos por conversa + dedup) — prompt injection do cliente
 * não vira flood de cards (exigência E18).
 *
 * Plano: docs/PLANO_FOTO_SOB_DEMANDA_2026-06-10.md (+ ANEXO_ARTEFATOS §B).
 */

import type { PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { sendAttachment, sendMessage } from './sender.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { enqueueAccessoryText, enqueuePhotoAttachment } from './outbox-accessory.js';

const PHOTO_REQUEST_TTL_MINUTES = 10;
const MAX_ACTIVE_PER_CONVERSATION = 2;
const EXPIRER_INTERVAL_MS = 60_000;

// ─── Criação (chamada pela tool pedir_foto, com a loja JÁ resolvida) ─────────

export interface CreatePhotoRequestInput {
  /** core.units.id da loja que vai fotografar (resolvida pelo roteamento). */
  unitId: string;
  /** id da conversa NO CHATWOOT (endereço de volta do dispatcher). */
  chatwootConversationId: number;
  /** O que o card mostra em destaque (nome/medida do pneu). */
  tireSize: string;
  brand: string | null;
  /**
   * Nome do cliente pro card de Avisos (decisão do dono 2026-06-15): SÓ o nome,
   * pra o borracheiro diferenciar as pessoas. NUNCA telefone/contato (só o nome
   * não permite contatar fora da Rede). Opcional — caller que não passa = null.
   */
  customerLabel?: string | null;
}

export type CreatePhotoRequestResult =
  | { status: 'created'; photoRequestId: string; prazoMin: number }
  | { status: 'dedup'; photoRequestId: string; prazoMin: number }
  | { status: 'limit' };

/**
 * Cria o pedido de foto (bot-pool; o parceiro NÃO tem INSERT — E4) e avisa o
 * painel via pg_notify no canal do chat (kind 'photo_request' — payload SEM o
 * conversation_id do cliente, E16). Guards por código:
 *   - dedup: já existe pending pra mesma loja+pneu nesta conversa → devolve o existente;
 *   - máx 2 ativos (pending+answered) por conversa → 'limit'.
 */
export async function createPhotoRequest(
  client: PoolClient,
  environment: Environment,
  input: CreatePhotoRequestInput,
): Promise<CreatePhotoRequestResult> {
  // Dedup: o LLM chamando 2x (ou cliente repetindo) não vira 2 cards iguais.
  const dup = await client.query<{ id: string; expires_at: Date }>(
    `SELECT id, expires_at FROM commerce.photo_requests
      WHERE environment = $1 AND conversation_id = $2 AND unit_id = $3
        AND tire_size = $4 AND status = 'pending'
      LIMIT 1`,
    [environment, input.chatwootConversationId, input.unitId, input.tireSize],
  );
  if (dup.rowCount === 1) {
    const restanteMs = new Date(dup.rows[0]!.expires_at).getTime() - Date.now();
    return {
      status: 'dedup',
      photoRequestId: dup.rows[0]!.id,
      prazoMin: Math.max(1, Math.ceil(restanteMs / 60_000)),
    };
  }

  // Máx N ativos por conversa (anti-flood/prompt-injection — E18).
  const active = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM commerce.photo_requests
      WHERE environment = $1 AND conversation_id = $2 AND status IN ('pending', 'answered')`,
    [environment, input.chatwootConversationId],
  );
  if (Number(active.rows[0]?.n ?? 0) >= MAX_ACTIVE_PER_CONVERSATION) {
    return { status: 'limit' };
  }

  const ins = await client.query<{ id: string }>(
    `INSERT INTO commerce.photo_requests
       (environment, unit_id, conversation_id, tire_size, brand, customer_label,
        expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))
     RETURNING id`,
    [
      environment,
      input.unitId,
      input.chatwootConversationId,
      input.tireSize,
      input.brand,
      input.customerLabel ?? null,
      PHOTO_REQUEST_TTL_MINUTES,
    ],
  );
  const photoRequestId = ins.rows[0]!.id;

  // Acorda o painel da loja (mesmo canal/hub do chat — Tijolo 4 consome).
  // Payload de propósito SEM o conversation_id do cliente (anti-bypass, E16).
  await client.query(`SELECT pg_notify('partner_chat', $1)`, [
    JSON.stringify({
      unit_id: input.unitId,
      conversation_id: '',
      kind: 'photo_request',
      photo_request_id: photoRequestId,
    }),
  ]);

  return { status: 'created', photoRequestId, prazoMin: PHOTO_REQUEST_TTL_MINUTES };
}

// ─── Amarração ao pedido (chamada pelo criar_pedido, pós-materialização) ─────

/**
 * O cliente FECHOU o pedido: (1) gruda as fotos respondidas desta conversa nos
 * itens do pedido — o card "Em separação" passa a mostrar a foto e o separador
 * pega o pneu CERTO; (2) cancela os pedidos de foto ainda pendentes da conversa
 * (senão o expirador mandaria "a loja não conseguiu a foto" pra quem JÁ comprou).
 *
 * Guards na própria query: a foto só migra se a loja do pedido == loja da foto
 * (re-roteou no meio do caminho → NÃO migra: é peça física de outra loja) e o
 * casamento é por product_name do CATÁLOGO (pr.tire_size nasceu exatamente de
 * commerce.products.product_name na tool — mesmo campo, casamento confiável;
 * divergiu → não liga e degrada honesto, sem foto errada na separação).
 */
export async function linkPhotoRequestsToOrder(
  client: PoolClient,
  environment: Environment,
  chatwootConversationId: number,
  partnerOrderId: string,
): Promise<void> {
  await client.query(
    `UPDATE commerce.photo_requests pr
        SET order_item_id = poi.id
       FROM commerce.partner_orders po
       JOIN commerce.partner_order_items poi ON poi.order_id = po.id
       JOIN commerce.partner_stock_levels ps ON ps.id = poi.partner_stock_id
       JOIN commerce.products p ON p.id = ps.product_id AND p.environment = po.environment
      WHERE po.id = $1
        AND pr.environment = $2
        AND pr.conversation_id = $3
        AND pr.status IN ('answered', 'sent')
        AND pr.order_item_id IS NULL
        AND po.environment = pr.environment
        AND po.unit_id = pr.unit_id
        AND p.product_name = pr.tire_size`,
    [partnerOrderId, environment, chatwootConversationId],
  );

  await client.query(
    `UPDATE commerce.photo_requests
        SET status = 'cancelled'
      WHERE environment = $1 AND conversation_id = $2 AND status = 'pending'`,
    [environment, chatwootConversationId],
  );
}

// ─── Despacho da foto (chamado pelo upload do painel, pós-attach) ────────────

/**
 * Manda a foto anexada pro cliente. Determinístico: lê o ENDEREÇO DE VOLTA do
 * próprio registro (E5 — o caller só passa o id; nunca escolhe o destino).
 * Marca 'sent' só se o envio ao Chatwoot foi aceito. Fire-and-forget do route:
 * falha fica logada e o card permanece 'answered' (foto guardada, envio não
 * confirmado) — visível na fila.
 */
export async function dispatchPhotoToCustomer(
  photoRequestId: string,
  photo: { bytes: Buffer; mime: string },
  wasLate: boolean,
): Promise<void> {
  const res = await pool.query<{
    environment: Environment;
    conversation_id: string;
    tire_size: string;
    brand: string | null;
    status: string;
  }>(
    `SELECT environment, conversation_id, tire_size, brand, status
       FROM commerce.photo_requests
      WHERE id = $1`,
    [photoRequestId],
  );
  if (res.rowCount !== 1) {
    logger.warn({ photoRequestId }, 'photo dispatch: pedido nao encontrado');
    return;
  }
  const row = res.rows[0]!;
  // Multi-foto (até 3 por card): despacha enquanto o card não estiver cancelado. O
  // route só chama o dispatch quando uma foto NOVA foi anexada (attached=true), então
  // cada chamada = uma foto a mandar (o status já pode ser 'sent' das anteriores).
  if (row.status === 'cancelled') {
    logger.info({ photoRequestId, status: row.status }, 'photo dispatch: cancelado (no-op)');
    return;
  }

  const nomePneu = row.brand ? `${row.tire_size} ${row.brand}` : row.tire_size;
  // Legenda OBRIGATÓRIA (vira o content do eco → o LLM "lembra" que mandou).
  // Diz "do que temos" — NUNCA promete unicidade que o estoque não garante.
  const caption = wasLate
    ? `Chegou! 📸 A foto do ${nomePneu} que você pediu — dá uma olhada no estado.`
    : `Ó ele aqui 📸 ${nomePneu} — foto real do que temos na loja. Dá uma olhada no estado!`;

  if (env.BOT_OUTBOX) {
    await enqueuePhotoAttachment(pool, {
      environment: row.environment,
      chatwootConversationId: Number(row.conversation_id),
      photoRequestId,
      caption,
    });
    return;
  }

  await sendAttachment(Number(row.conversation_id), {
    buffer: photo.bytes,
    filename: `pneu-${photoRequestId.slice(0, 8)}.jpg`,
    contentType: photo.mime,
  }, caption);

  await pool.query(
    `UPDATE commerce.photo_requests
        SET status = 'sent', sent_to_customer_at = now()
      WHERE id = $1 AND status = 'answered'`,
    [photoRequestId],
  );
}

// ─── Expiração + fallback honesto ────────────────────────────────────────────

// Decisão #15 do plano (texto SUAVE recomendado, pendente ratificação do dono):
// não promete "equivalente ou melhor" — promete o que o fluxo GARANTE (ver e
// aprovar antes de pagar, que é a regra de ouro já implementada no COD/balcão).
const FALLBACK_TEXT =
  'A loja tá no corre agora e não conseguiu mandar a foto a tempo 🙏 ' +
  'Mas fica tranquilo: você vê o pneu na hora e só paga se aprovar. Quer que eu siga com o pedido?';

/**
 * Marca os pendentes vencidos como expired (UPDATE...RETURNING atômico — duas
 * réplicas nunca mandam o fallback duas vezes) e manda o fallback pro cliente.
 * Restart do Coolify é seguro: no boot, o WHERE pega os vencidos da janela morta.
 */
async function expirePendingPhotoRequests(): Promise<void> {
  const expired = await pool.query<{ id: string; environment: Environment; conversation_id: string }>(
    `UPDATE commerce.photo_requests
        SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now()
      RETURNING id, environment, conversation_id`,
  );
  for (const row of expired.rows) {
    try {
      if (env.BOT_OUTBOX) {
        await enqueueAccessoryText(pool, { environment: row.environment,
          chatwootConversationId: Number(row.conversation_id), kind: 'photo_text',
          body: FALLBACK_TEXT, idempotencyKey: `photo-fallback:${row.id}` });
      } else {
        await sendMessage(Number(row.conversation_id), FALLBACK_TEXT);
      }
    } catch (err) {
      // Fallback que falhou não volta o estado: melhor card expirado sem
      // mensagem do que reprocessar e arriscar mandar 2x. Fica no log.
      logger.error({ err, photoRequestId: row.id }, 'photo expirer: fallback nao enviado');
    }
  }
  if (expired.rowCount && expired.rowCount > 0) {
    logger.info({ count: expired.rowCount }, 'photo expirer: pedidos expirados + fallback');
  }
}

/**
 * Liga o expirador (60s). Atrás da flag PHOTO_REQUESTS: off = não agenda nada.
 * Retorna o stop() pro shutdown gracioso (padrão dos workers do server.ts).
 */
export function startPhotoRequestExpirer(): () => void {
  if (!env.PHOTO_REQUESTS) {
    return () => undefined;
  }
  const timer = setInterval(() => {
    expirePendingPhotoRequests().catch((err) => {
      logger.error({ err }, 'photo expirer: varredura falhou');
    });
  }, EXPIRER_INTERVAL_MS);
  logger.info('photo expirer: ligado (PHOTO_REQUESTS on)');
  return () => clearInterval(timer);
}
