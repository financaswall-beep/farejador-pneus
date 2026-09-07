import type { PoolClient } from 'pg';
import { isPlaceholderCustomerName } from '../shared/customer-name.js';
import { logger } from '../shared/logger.js';

export interface CustomerContextRow {
  name: string | null;
  has_phone: boolean;
  purchase_count: number;
  partial_ltv_brl: string | number | null;
  last_purchase_at: Date | string | null;
  last_purchase_item: string | null;
  has_previous_delivery_address: boolean;
}

function safeInline(value: unknown, max = 120): string {
  return String(value ?? '').replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function formatMoney(value: string | number | null): string {
  const number = Number(value ?? 0);
  return Number.isFinite(number)
    ? number.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0,00';
}

function formatDate(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(date);
}

export function formatCustomerContext(row: CustomerContextRow): string {
  const validName = !isPlaceholderCustomerName(row.name);
  const firstName = validName ? safeInline(row.name).split(/\s+/)[0] : null;
  const purchases = Math.max(0, Number(row.purchase_count) || 0);
  const parts: string[] = ['\n[CONTEXTO CLIENTE]'];

  if (firstName) {
    parts.push(`Nome conhecido do Chatwoot: ${firstName}. USE esse nome e NÃO pergunte novamente.`);
  } else {
    parts.push('Nome não confirmado no Chatwoot. Pergunte o nome durante a conversa, sem interromper a cotação.');
  }

  parts.push(row.has_phone
    ? 'Telefone já cadastrado neste contato. NÃO peça telefone ou WhatsApp novamente.'
    : 'Telefone ainda não cadastrado. Antes de criar qualquer pedido, peça telefone/WhatsApp com DDD.');

  if (purchases > 0) {
    parts.push(`Cliente recorrente: ${purchases} compra(s) concluída(s); total histórico R$ ${formatMoney(row.partial_ltv_brl)}.`);
    const lastDate = formatDate(row.last_purchase_at);
    const lastItem = safeInline(row.last_purchase_item);
    if (lastDate || lastItem) {
      parts.push(`Última compra concluída: ${[lastItem || null,lastDate ? `em ${lastDate}` : null].filter(Boolean).join(' ')}.`);
    }
    parts.push('Use o histórico apenas para reconhecer e ajudar. Não trate produto, preço, estoque, pagamento ou modalidade anteriores como atuais.');
  } else {
    parts.push('Nenhuma compra concluída ainda.');
  }

  if (row.has_previous_delivery_address) {
    parts.push('ENDEREÇO ANTERIOR DISPONÍVEL: se o cliente escolher ENTREGA e ainda não informar um endereço novo nesta conversa, pergunte exatamente uma vez: "Vai ser para o mesmo endereço da última entrega?". Só depois de resposta afirmativa chame criar_pedido com usar_endereco_anterior=true. Se responder não, peça rua, número e bairro. Nunca afirme nem revele o endereço anterior por conta própria.');
  }

  return parts.join(' ');
}

export async function loadCustomerContext(
  client: PoolClient,
  conversationId: string,
): Promise<string | null> {
  try {
    const result = await client.query<CustomerContextRow>(
      `WITH current_customer AS (
         SELECT cv.environment,cv.contact_id,ct.name,ct.phone_e164
           FROM core.conversations cv
           JOIN core.contacts ct ON ct.id=cv.contact_id AND ct.environment=cv.environment
          WHERE cv.id=$1 AND cv.deleted_at IS NULL AND ct.deleted_at IS NULL
          LIMIT 1
       ), completed_orders AS (
         SELECT o.*
           FROM current_customer cc
           JOIN commerce.orders o ON o.environment=cc.environment AND o.contact_id=cc.contact_id
          WHERE o.status IN ('confirmed','paid','delivered')
            AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered')
       ), history AS (
         SELECT count(*)::int AS purchase_count,COALESCE(sum(total_amount),0)::text AS partial_ltv_brl
           FROM completed_orders
       ), last_purchase AS (
         SELECT o.id,COALESCE(o.delivered_at,o.retrieved_at,o.created_at) AS occurred_at
           FROM completed_orders o
          ORDER BY COALESCE(o.delivered_at,o.retrieved_at,o.created_at) DESC,o.id DESC LIMIT 1
       )
       SELECT cc.name,(NULLIF(trim(cc.phone_e164),'') IS NOT NULL) AS has_phone,
              history.purchase_count,history.partial_ltv_brl,
              lp.occurred_at AS last_purchase_at,
              (SELECT COALESCE(ts.tire_size,p.product_name)
                 FROM commerce.order_items oi
                 JOIN commerce.products p ON p.id=oi.product_id AND p.environment=oi.environment
                 LEFT JOIN commerce.tire_specs ts ON ts.product_id=p.id AND ts.environment=p.environment
                WHERE oi.environment=cc.environment AND oi.order_id=lp.id
                ORDER BY oi.created_at DESC,oi.id DESC LIMIT 1) AS last_purchase_item,
              EXISTS(
                SELECT 1 FROM commerce.orders previous
                 WHERE previous.environment=cc.environment AND previous.contact_id=cc.contact_id
                   AND previous.fulfillment_mode='delivery'
                   AND (previous.delivery_status='delivered' OR previous.status='delivered')
                   AND NULLIF(trim(previous.delivery_address),'') IS NOT NULL
              ) AS has_previous_delivery_address
         FROM current_customer cc CROSS JOIN history LEFT JOIN last_purchase lp ON true`,
      [conversationId],
    );
    return result.rows[0] ? formatCustomerContext(result.rows[0]) : null;
  } catch (err) {
    logger.warn({ err, conversation_id: conversationId }, 'agent_v2: loadCustomerContext falhou (ignorado)');
    return null;
  }
}
