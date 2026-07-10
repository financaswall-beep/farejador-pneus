/**
 * PUSH (PWA) — disparador de notificação nativa pro celular do borracheiro.
 *
 * O PROBLEMA que isto resolve (achado do dono na operação 2026-06-17): o som da
 * página (app.foto.js) só toca com a aba ABERTA. Navegador fechado = ninguém
 * toca. Aqui o aviso vai por PUSH do navegador: o "ajudante" (service worker,
 * sw.js) é acordado pelo serviço de push mesmo com tudo fechado e dispara a
 * notificação nativa (toca/vibra/acende a tela).
 *
 * Como engata: reusa o canal pg_notify('partner_chat') que JÁ existe (o mesmo que
 * acorda a campainha da foto). Vira uma ESCUTA GLOBAL do hub
 * (subscribeAllPartnerChat) — de propósito não depende de haver SSE aberto na
 * unidade, porque o caso é exatamente o aparelho no bolso. Reage só a FOTO e
 * PEDIDO novo; chat normal não vira push.
 *
 * Tudo atrás da flag PUSH_NOTIFICATIONS (off = inerte). Sem chaves VAPID, degrada
 * elegante (não engata). FAIL-OPEN: erro de envio/banco nunca derruba o processo.
 */

import webpush from 'web-push';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { subscribeAllPartnerChat, type PartnerChatEvent } from '../normalization/partner-chat.notify.js';
import { isAllowedPushEndpoint } from './push-endpoint.js';

// TTL do push (segundos): 10 min casa com a janela da foto. Depois disso o aviso
// já não é útil — melhor expirar que tocar atrasado.
const PUSH_TTL_SECONDS = 600;

let configured = false;

/** Pronto pra disparar? Flag on E as duas chaves VAPID presentes. */
export function isPushConfigured(): boolean {
  return Boolean(env.PUSH_NOTIFICATIONS && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function ensureConfigured(): boolean {
  if (configured) return true;
  if (!isPushConfigured()) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Agrupa notificações do mesmo tipo (o celular não empilha 10 iguais). */
  tag: string;
  kind: string;
}

/**
 * Traduz o evento do canal em texto de notificação. Só FOTO e PEDIDO viram push;
 * qualquer outro kind (mensagem de chat, etc.) devolve null = não dispara.
 * PURO/determinístico — é o que o teste cobre.
 */
export function payloadForEvent(event: PartnerChatEvent): PushPayload | null {
  switch (event.kind) {
    case 'photo_request':
      return {
        title: '📷 Pediram uma foto',
        body: 'Um cliente quer ver o pneu. Toca pra fotografar antes que ele desista.',
        tag: 'foto',
        kind: event.kind,
      };
    case 'new_order':
      return {
        title: '🛞 Pedido novo na sua loja',
        body: 'Caiu um pedido da Rede. Toca pra ver e separar.',
        tag: 'pedido',
        kind: event.kind,
      };
    default:
      return null;
  }
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function sendToUnit(unitId: string, payload: PushPayload): Promise<void> {
  const { rows } = await pool.query<SubRow>(
    `SELECT endpoint, p256dh, auth FROM commerce.partner_push_subscriptions
      WHERE environment = $1 AND unit_id = $2`,
    [env.FAREJADOR_ENV, unitId],
  );
  if (rows.length === 0) return;
  const body = JSON.stringify(payload);
  await Promise.all(rows.map((row) => deliver(unitId, row, body)));
}

async function deliver(unitId: string, sub: SubRow, body: string): Promise<void> {
  try {
    // Revalida no envio para cobrir registros antigos e mudanca de DNS.
    if (!(await isAllowedPushEndpoint(sub.endpoint))) {
      // Não apaga: uma falha transitória de DNS não deve destruir inscrição válida.
      // O envio continua fail-closed e tentará revalidar no próximo evento.
      logger.warn({ unitId }, 'push: endpoint não validado; envio bloqueado');
      return;
    }
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body,
      { TTL: PUSH_TTL_SECONDS, urgency: 'high' },
    );
    await pool
      .query(
        `UPDATE commerce.partner_push_subscriptions
            SET last_success_at = now(), failure_count = 0
          WHERE environment = $1 AND endpoint = $2`,
        [env.FAREJADOR_ENV, sub.endpoint],
      )
      .catch(() => undefined);
  } catch (err) {
    const status = (err as { statusCode?: number } | null)?.statusCode;
    // 404/410 = inscrição morta (app desinstalado / permissão revogada): apaga.
    if (status === 404 || status === 410) {
      await pool
        .query(
          `DELETE FROM commerce.partner_push_subscriptions WHERE environment = $1 AND endpoint = $2`,
          [env.FAREJADOR_ENV, sub.endpoint],
        )
        .catch(() => undefined);
      logger.info({ unitId, status }, 'push: inscrição morta removida');
      return;
    }
    // Outros erros (rede, 5xx do serviço de push): conta a falha, não remove.
    await pool
      .query(
        `UPDATE commerce.partner_push_subscriptions
            SET failure_count = failure_count + 1
          WHERE environment = $1 AND endpoint = $2`,
        [env.FAREJADOR_ENV, sub.endpoint],
      )
      .catch(() => undefined);
    logger.warn({ err, unitId, status }, 'push: falha no envio');
  }
}

/** Dispara o push pra unidade do evento (no-op se não configurado / kind ignorado). */
export async function pushForEvent(event: PartnerChatEvent): Promise<void> {
  if (!ensureConfigured()) return;
  if (!event.unit_id) return;
  const payload = payloadForEvent(event);
  if (!payload) return;
  await sendToUnit(event.unit_id, payload);
}

let stop: (() => void) | null = null;

/**
 * Liga a escuta global → push. Idempotente. Atrás da flag PUSH_NOTIFICATIONS.
 * Retorna o stop() pro shutdown gracioso (padrão dos workers do server.ts).
 */
export function startPartnerPushFanout(): () => void {
  if (!env.PUSH_NOTIFICATIONS) return () => undefined;
  if (!ensureConfigured()) {
    logger.warn('push fanout: PUSH_NOTIFICATIONS on mas VAPID ausente — push inerte');
    return () => undefined;
  }
  if (stop) return stop;
  const unsub = subscribeAllPartnerChat((event) => {
    pushForEvent(event).catch((err) => logger.error({ err }, 'push fanout: disparo falhou'));
  });
  stop = () => {
    unsub();
    stop = null;
  };
  logger.info('push fanout: ligado (PUSH_NOTIFICATIONS on)');
  return stop;
}
