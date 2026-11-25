import type { PoolClient } from 'pg';
import { z } from 'zod';
import { listAvailableMatrizStockGroups } from '../admin/painel/stock-groups.js';
import type { ProdutoOferta } from '../atendente/tools/commerce-tools.js';
import { env } from '../shared/config/env.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { evaluateMatrizDelivery } from './matriz-delivery-eligibility.js';
import { confirmationLocation, routeStockConfirmation, type StockConfirmationLocation } from './stock-confirmation-routing.js';
import { stockConfirmationRouteOptions } from './stock-confirmation.js';
import { getMatrizWholesaleStockQty } from './wholesale-stock-read.js';
import type { ChatMessage, ToolDefinition } from './types.js';
import { customerAcceptedCarGroup } from './car-group-consent.js';
import { isCarTireSearch, tireSearchQuantity } from './car-search-type.js';
import { matchesSentMarketQuote, type MarketQuoteProduct } from './market-quote-validation.js';

export function matrizStockGroupsEnabled(): boolean {
  return env.MATRIZ_CAR_GROUP_OFFERS && env.WHOLESALE_UNIFIED_STOCK && env.WHOLESALE_MATRIZ_DECREMENT;
}

export function withoutCarGroupToolArgs(tool: ToolDefinition): ToolDefinition {
  if (!['buscar_produto', 'calcular_frete', 'localizacao_loja', 'criar_pedido'].includes(tool.function.name)) return tool;
  const properties = { ...tool.function.parameters.properties as Record<string, unknown> };
  delete properties.pneus_avulsos;
  delete properties.quer_conjunto;
  delete properties.conjunto_id;
  return { ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters, properties } } };
}

export async function requestedCarQuantity(
  client: PoolClient, environment: Environment, args: Record<string, unknown>,
): Promise<number | undefined> {
  const quantity = tireSearchQuantity(args);
  return quantity !== undefined && matrizStockGroupsEnabled() && await isCarTireSearch(client, environment, args)
    ? quantity : undefined;
}

const groupSchema = z.object({
  conjunto_id: z.string().uuid(),
  product_id: z.string().uuid(),
  medida: z.string().min(1),
  quantidade: z.number().int().min(2).max(20),
  revisao: z.string().min(1),
  preco_unitario: z.number().positive(),
  modelo: z.string().trim().min(1).nullable().optional(),
});

type GroupQuote = z.infer<typeof groupSchema>;

async function groupStillAvailable(client: PoolClient, environment: Environment, quote: GroupQuote) {
  const groups=await listAvailableMatrizStockGroups(client,environment,{
    measure:quote.medida,quantity:quote.quantidade,productIds:[quote.product_id],groupId:quote.conjunto_id,
  });
  return groups.some(group=>group.group_id===quote.conjunto_id && group.product_id===quote.product_id && group.revision===quote.revisao);
}

export interface BotGroupReservation {
  groupId: string;
  productId: string;
  quantity: number;
  revision: string;
}

function eligible(product: ProdutoOferta, quantity: number): boolean {
  return product.total_stock_available >= quantity && product.price_amount !== null
    && Number(product.price_amount) > 0 && product.currency === 'BRL';
}

async function matrixCanOfferGroup(
  client: PoolClient, environment: Environment, conversationId: string, location: StockConfirmationLocation,
  productId: string, quantity: number,
): Promise<boolean> {
  if (!location.municipio && !location.customerLocation) return false;
  const items = [{ product_id: productId, quantity }];
  const routing: { onlyUnitId?: string; excludedUnitIds?: string[] } =
    await stockConfirmationRouteOptions(client, environment, conversationId, items);
  if (routing.onlyUnitId) return false;
  if (location.modalidade === 'delivery' || env.PICKUP_TO_PARTNER) {
    const decision = await routeStockConfirmation(client, environment, location, items, routing.excludedUnitIds);
    if (decision.kind !== 'matriz' || (location.customerLocation && !decision.canFulfill)) return false;
  }
  const matrix = await evaluateMatrizDelivery(client, environment, { ...location, items });
  return matrix.canFulfill && !matrix.block;
}

export async function findCarStockGroup(
  client: PoolClient, environment: Environment, conversationId: string,
  args: Record<string, unknown>, products: ProdutoOferta[],
) {
  if (!matrizStockGroupsEnabled() || typeof args.medida_pneu !== 'string' || args.pneus_avulsos === true) return null;
  const requested = tireSearchQuantity(args);
  if (requested === 1 || (args.quantidade !== undefined && requested === undefined)) return null;
  const candidates = products.filter(product => eligible(product, requested ?? 1));
  const chosenProducts = args.quer_conjunto === true ? candidates : candidates.slice(0, 1);
  const minimum = requested ?? 2;
  const choices = chosenProducts.filter(product => product.price_type !== 'partner_retail' && eligible(product, minimum));
  if (!choices.length || !await isCarTireSearch(client, environment, args)) return null;
  const location = await confirmationLocation(client, environment, conversationId, args);
  if (args.modalidade === 'pickup' || args.modalidade === 'delivery') location.modalidade = args.modalidade;
  if (!location.municipio && !location.customerLocation) return null;

  const groups = await listAvailableMatrizStockGroups(client, environment, {
    measure: args.medida_pneu, quantity: minimum, productIds: choices.map(product => product.product_id),
  });
  for (const product of choices) {
    const group = groups.find(item => item.product_id === product.product_id);
    if (!group) continue;
    const quantity = requested ?? Math.min(20, group.quantity_available, product.total_stock_available);
    if (!await matrixCanOfferGroup(client, environment, conversationId, location, product.product_id, quantity)) continue;
    const amount = Number(product.price_amount);
    return {
      conjunto_id: group.group_id, product_id: group.product_id,
      medida: group.measure, marca: group.brand, modelo: group.model,
      condicao: group.tire_condition, quantidade: quantity,
      conservacao: group.conservation_grade,
      preco_unitario: amount, total: (Math.round(amount * 100) * quantity) / 100,
      revisao: group.revision,
    };
  }
  return null;
}

export async function verifiedSingleCarTireConservation(
  client: PoolClient, environment: Environment, conversationId: string,
  args: Record<string, unknown>, products: ProdutoOferta[],
) {
  if (!matrizStockGroupsEnabled() || typeof args.medida_pneu !== 'string'
    || (tireSearchQuantity(args) ?? 1) !== 1 || args.quer_conjunto === true) return null;
  const winner = products.find(product => eligible(product, 1));
  if (!winner || winner.total_stock_available !== 1 || winner.price_type === 'partner_retail'
    || !await isCarTireSearch(client, environment, args)) return null;
  const groups = await listAvailableMatrizStockGroups(client, environment, {
    measure: args.medida_pneu, quantity: 1, productIds: [winner.product_id],
  });
  const matches = groups.filter(group => group.product_id === winner.product_id && group.quantity_available > 0);
  const sole = matches[0];
  if (matches.length !== 1 || sole?.quantity_available !== 1 || !sole.conservation_grade) return null;
  const location = await confirmationLocation(client, environment, conversationId, args);
  if (args.modalidade === 'pickup' || args.modalidade === 'delivery') location.modalidade = args.modalidade;
  if (!await matrixCanOfferGroup(client, environment, conversationId, location, winner.product_id, 1)
    || await getMatrizWholesaleStockQty(client, environment, winner.product_id) !== 1) return null;
  return { product_id: winner.product_id, conservacao: sole.conservation_grade };
}

interface ProductSearch {
  produtos?: (MarketQuoteProduct & { total_stock_available: number;
    currency: string | null; price_type: string | null })[];
  conjunto_carro?: unknown;
  precisa_localizacao?: boolean;
  precisa_municipio?: boolean;
  sem_estoque_loja_perto?: boolean;
  quantidade_integral_disponivel?: boolean;
  aguardando_parceiro?: boolean;
}

interface ProductSearchTurn {
  result: ProductSearch;
  args: Record<string, unknown>;
  say_text: string;
  provider_message_id: string | null;
}

interface SearchHistoryRow {
  actions: ChatMessage[];
  say_text: string | null;
  provider_message_id: string | null;
}

function latestProductSearch(turns: SearchHistoryRow[]): ProductSearchTurn | null {
  for (const turn of turns) {
    const calls = new Map(turn.actions.flatMap(message =>
      (message.tool_calls ?? []).filter(call => call.function.name === 'buscar_produto')
        .map(call => [call.id, call.function.arguments])));
    const result = [...turn.actions].reverse().find(message =>
      message.role === 'tool' && message.tool_call_id && calls.has(message.tool_call_id));
    if (!result?.content) continue;
    try {
      return { result: JSON.parse(result.content) as ProductSearch,
        args: JSON.parse(calls.get(result.tool_call_id!) ?? '{}') as Record<string, unknown>,
        say_text: turn.say_text ?? '', provider_message_id: turn.provider_message_id };
    }
    catch { return null; }
  }
  return null;
}

async function sentProductSearch(
  client: PoolClient, environment: Environment, conversationId: string, requestId: string | null,
  confirmedQuote = false,
): Promise<ProductSearchTurn | null> {
  if (!requestId) return null;
  const result = await client.query<SearchHistoryRow>(`
    SELECT t.actions,outbound.body AS say_text,
           outbound.provider_message_id::text AS provider_message_id
      FROM agent.turns t
      JOIN core.messages quoted ON quoted.id=t.trigger_message_id AND quoted.environment=t.environment
      JOIN core.messages current ON current.id=$3 AND current.environment=t.environment
        AND current.conversation_id=t.conversation_id AND current.sender_type='contact'
        AND NOT current.is_private AND current.deleted_at IS NULL
      LEFT JOIN LATERAL (SELECT o.provider_message_id,o.body FROM ops.outbound_messages o
        WHERE o.environment=t.environment AND o.conversation_id=t.conversation_id AND o.turn_id=t.id
          AND o.kind='agent_text' AND o.status IN ('sent_api_ack','delivered') AND o.provider_message_id IS NOT NULL
        ORDER BY o.created_at DESC LIMIT 1) outbound ON TRUE
      WHERE t.environment=$1 AND t.conversation_id=$2 AND t.agent_version='v2'
        AND (t.status IN ('sent_api_ack','delivered') OR ($4 AND t.status='generated'))
        AND t.actions IS NOT NULL AND NULLIF(trim(t.say_text),'') IS NOT NULL
        AND (quoted.sent_at,quoted.chatwoot_message_id)<(current.sent_at,current.chatwoot_message_id)
        ${confirmedQuote ? `AND outbound.provider_message_id < current.chatwoot_message_id
          AND NOT EXISTS (SELECT 1 FROM ops.outbound_messages newer
            WHERE newer.environment=t.environment AND newer.conversation_id=t.conversation_id
              AND newer.kind='agent_text' AND newer.status IN ('sent_api_ack','delivered')
              AND newer.provider_message_id > outbound.provider_message_id
              AND newer.provider_message_id < current.chatwoot_message_id)` : ''}
      ORDER BY t.created_at DESC LIMIT 12`,
  [environment, conversationId, requestId, !confirmedQuote && environment === 'test' && !env.BOT_OUTBOX]);
  return latestProductSearch(result.rows);
}

export async function checkedBotGroupOffer(
  client: PoolClient, environment: Environment, conversationId: string, requestId: string | null,
  requestedId: unknown, items: { product_id: string; quantidade: number; preco_unitario: number }[],
): Promise<{
  offer?: BotGroupReservation;
  accepted?: boolean;
  quotedUnitPrice?: number;
  error?: 'conjunto_exige_id' | 'conjunto_oferta_invalida';
}> {
  if (!matrizStockGroupsEnabled()) return requestedId === undefined ? {} : { error: 'conjunto_oferta_invalida' };
  if (requestedId === undefined && items.reduce((total, item) => total + item.quantidade, 0) < 2) return {};
  const previous = await sentProductSearch(client, environment, conversationId, requestId);
  const parsed = groupSchema.safeParse(previous?.result.conjunto_carro);
  const quote: GroupQuote | undefined = parsed.success ? parsed.data : undefined;
  const item = items[0];
  const matches = quote && items.length === 1 && item?.product_id === quote.product_id
    && item.quantidade === quote.quantidade;
  if (requestedId === undefined) {
    const requestedQuantity = items.reduce((total, part) =>
      part.product_id === quote?.product_id ? total + part.quantidade : total, 0);
    return quote && requestedQuantity === quote.quantidade ? { error: 'conjunto_exige_id' } : {};
  }
  if (!matches || quote.conjunto_id !== requestedId || !previous) {
    return { error: 'conjunto_oferta_invalida' };
  }
  return { offer: { groupId: quote.conjunto_id, productId: quote.product_id,
    quantity: quote.quantidade, revision: quote.revisao },
    quotedUnitPrice: quote.preco_unitario,
    accepted: await customerAcceptedCarGroup(client, environment, conversationId, requestId, previous, quote.quantidade),
  };
}

export async function verifiedObjectionProduct(
  client: PoolClient, environment: Environment, conversationId: string, requestId: string,
  productId: string,
): Promise<boolean> {
  const previous = await sentProductSearch(client, environment, conversationId, requestId, true);
  const search = previous?.result;
  if (!previous?.provider_message_id || !previous.say_text || !search || search.precisa_localizacao || search.precisa_municipio
    || search.sem_estoque_loja_perto || search.aguardando_parceiro
    || search.quantidade_integral_disponivel === false) return false;
  const group = groupSchema.safeParse(search.conjunto_carro);
  const candidates = Array.isArray(search.produtos)
    ? search.produtos.filter(p => p && Number(p.price_amount) > 0 && p.currency === 'BRL') : [];
  const product = candidates.find(p => p.product_id === productId);
  const quantity = group.success && group.data.product_id === productId
    ? group.data.quantidade : tireSearchQuantity(previous.args) ?? 1;
  if (!product || !(product.total_stock_available >= quantity) || product.price_type === 'partner_retail'
    || !matchesSentMarketQuote(previous.say_text, productId, candidates, group.data)) return false;
  if (group.success && group.data.product_id===productId && !await groupStillAvailable(client,environment,group.data)) return false;
  const location = await confirmationLocation(client, environment, conversationId, previous.args);
  if (previous.args.modalidade === 'pickup' || previous.args.modalidade === 'delivery') {
    location.modalidade = previous.args.modalidade;
  }
  return matrixCanOfferGroup(client, environment, conversationId, location, productId, quantity);
}

export async function verifyGroupFulfillment(
  client: PoolClient, environment: Environment, conversationId: string, requestId: string | null,
  args: Record<string, unknown>, modality: 'pickup' | 'delivery',
) {
  if (!matrizStockGroupsEnabled()) return null;
  const previous = await sentProductSearch(client, environment, conversationId, requestId);
  const parsed = groupSchema.safeParse(previous?.result.conjunto_carro);
  if (!parsed.success || parsed.data.conjunto_id !== args.conjunto_id) return null;
  const quote = parsed.data;
  if (!await groupStillAvailable(client,environment,quote)) return null;
  const location = await confirmationLocation(client, environment, conversationId, args);
  location.modalidade = modality;
  return await matrixCanOfferGroup(client, environment, conversationId, location, quote.product_id, quote.quantidade)
    ? { quote, location } : null;
}

export const GROUP_ROUTE_CHANGED = {
  encontrado: false, disponivel: false, erro: 'stock_group_route_changed',
  mensagem: 'Não foi possível reconfirmar o conjunto nesta modalidade. Atualize a consulta antes de prometer loja, quantidade ou reserva.',
};
