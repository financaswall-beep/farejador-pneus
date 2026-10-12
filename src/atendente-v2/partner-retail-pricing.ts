import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { moneyCents } from '../shared/catalog-pricing.js';
import type { PartnerOrderRouting } from './fulfillment.js';

export interface PartnerRetailAvailability { unitId: string; available: number }
export interface PartnerRetailOffer extends PartnerRetailAvailability { stockId: string; unitPrice: number }

/** O valor e o saldo pertencem à mesma linha da loja escolhida, nunca à tabela central. */
export async function loadPartnerRetailOffers(client: Pick<PoolClient, 'query'>, environment: Environment,
  availability: ReadonlyMap<string, PartnerRetailAvailability>): Promise<Map<string, PartnerRetailOffer>> {
  if (!availability.size) return new Map();
  const rows = await client.query<{ id: string; unit_id: string; product_id: string; sale_price: string; disponivel: string }>(
    `SELECT id,unit_id,product_id,sale_price::text,
       (quantity_on_hand-COALESCE(quantity_reserved,0))::text disponivel
     FROM commerce.partner_stock_levels
     WHERE environment=$1 AND unit_id=ANY($2::uuid[]) AND product_id=ANY($3::uuid[])
       AND deleted_at IS NULL AND tire_condition IS NOT NULL
       AND is_tracked=true AND quantity_on_hand IS NOT NULL
       AND quantity_on_hand-COALESCE(quantity_reserved,0)>0 AND sale_price>0
     ORDER BY quantity_on_hand-COALESCE(quantity_reserved,0) DESC,id`,
    [environment, [...new Set([...availability.values()].map(value => value.unitId))], [...availability.keys()]]);
  const offers = new Map<string, PartnerRetailOffer>();
  for (const row of rows.rows) {
    const target = availability.get(row.product_id), price = Number(row.sale_price), available = Number(row.disponivel);
    if (!target || target.unitId !== row.unit_id || offers.has(row.product_id)
      || !Number.isFinite(price) || price <= 0 || !Number.isFinite(available) || available <= 0) continue;
    offers.set(row.product_id, { unitId: row.unit_id, stockId: row.id, available, unitPrice: price });
  }
  return offers;
}

interface QuotedItem { product_id: string; preco_unitario: number }
interface PriceConfirmation { conversationId: string; requestId: string | null }
/** Trava a edição de preço até terminar o pedido; divergência exige novo aceite. */
export async function validatePartnerRetailQuote(client: Pick<PoolClient, 'query'>, environment: Environment,
  routing: PartnerOrderRouting, quoted: QuotedItem[], confirmation?: PriceConfirmation): Promise<{ ok: true } | { ok: false; response: Record<string, unknown> }> {
  const stock = await client.query<{ id: string; product_id: string; sale_price: string | null }>(
    `SELECT id,product_id,sale_price::text FROM commerce.partner_stock_levels
     WHERE environment=$1 AND unit_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL
     ORDER BY id FOR UPDATE`, [environment, routing.unitId, routing.items.map(item => item.partner_stock_id)]);
  const compared = routing.items.map(item => {
    const row = stock.rows.find(value => value.id === item.partner_stock_id && value.product_id === item.product_id);
    const current = row?.sale_price == null ? null : Number(row.sale_price);
    const quotes = quoted.filter(value => value.product_id === item.product_id), quotedPrice = quotes[0]?.preco_unitario;
    const valid = current !== null && Number.isFinite(current) && current > 0 && quotedPrice !== undefined
      && quotes.every(value => moneyCents(current) === moneyCents(value.preco_unitario))
      && moneyCents(current) === moneyCents(item.unit_price);
    return { product_id: item.product_id, preco_informado: quotedPrice ?? null,
      preco_atual: current !== null && Number.isFinite(current) && current > 0 ? current : null, valid };
  });
  const changed = compared.filter(item => !item.valid);
  // O modelo não pode corrigir o argumento e fechar no mesmo turno sem o cliente.
  // O evento registra só referências e valores; uma nova mensagem libera nova avaliação.
  const prior = confirmation?.requestId ? await client.query(
    `SELECT id FROM audit.events WHERE environment=$1 AND entity_table='core.conversations'
     AND entity_id=$2 AND event_type='bot_partner_price_reconfirmation_required'
     AND payload_after->>'request_message_id'=$3 LIMIT 1`,
    [environment, confirmation.conversationId, confirmation.requestId]) : null;
  if (changed.length && confirmation?.requestId && !prior?.rows.length) await client.query(
    `INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
     VALUES($1,'bot_price','core.conversations',$2,'bot_partner_price_reconfirmation_required','bot',$3::jsonb)`,
    [environment, confirmation.conversationId, JSON.stringify({ request_message_id: confirmation.requestId,
      unit_id: routing.unitId, items: changed.map(({ valid: _valid, ...item }) => item) })]);
  if (!changed.length && !prior?.rows.length) return { ok: true };
  const difference = (changed.length ? changed : compared).map(({ valid: _valid, ...item }) => item);
  return { ok: false, response: { erro: changed.some(item => item.preco_atual === null) ? 'partner_sale_price_missing' : 'preco_alterado',
    preco_alterado: true, nova_confirmacao_obrigatoria: true, nome_loja: routing.ctx.unitName, itens: difference,
    mensagem: difference.some(item => item.preco_atual === null)
      ? 'A loja ainda precisa confirmar o preço de venda. O pedido não foi fechado.'
      : `O preço de venda da loja mudou: ${difference.map(item => `R$ ${item.preco_atual!.toFixed(2).replace('.', ',')} por pneu`).join('; ')}. Confirme esses valores com o cliente antes de fechar.` } };
}
