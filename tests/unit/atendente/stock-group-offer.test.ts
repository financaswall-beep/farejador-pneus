import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProdutoOferta } from '../../../src/atendente/tools/commerce-tools.js';
import type { ChatMessage } from '../../../src/atendente-v2/types.js';

const mocked = vi.hoisted(() => ({
  env: { WHOLESALE_UNIFIED_STOCK: true, WHOLESALE_MATRIZ_DECREMENT: true, PICKUP_TO_PARTNER: true,
    BOT_OUTBOX: true, MATRIZ_CAR_GROUP_OFFERS: true, MATRIZ_MARKET_REFERENCE_OBJECTIONS: true },
  group: vi.fn(), location: vi.fn(), route: vi.fn(), matrix: vi.fn(), confirmation: vi.fn(),
  market: vi.fn(), officialQuantity: vi.fn(),
}));
vi.mock('../../../src/shared/config/env.js', () => ({ env: mocked.env }));
vi.mock('../../../src/admin/painel/stock-groups.js', () => ({ listAvailableMatrizStockGroups: mocked.group }));
vi.mock('../../../src/atendente-v2/matriz-delivery-eligibility.js', () => ({ evaluateMatrizDelivery: mocked.matrix }));
vi.mock('../../../src/atendente-v2/stock-confirmation-routing.js', () => ({
  confirmationLocation: mocked.location, routeStockConfirmation: mocked.route,
}));
vi.mock('../../../src/atendente-v2/stock-confirmation.js', () => ({ stockConfirmationRouteOptions: mocked.confirmation }));
vi.mock('../../../src/shared/catalog-market-reference.js', () => ({ readApprovedMarketReference: mocked.market }));
vi.mock('../../../src/atendente-v2/wholesale-stock-read.js', () => ({ getMatrizWholesaleStockQty: mocked.officialQuantity }));

import { checkedBotGroupOffer, findCarStockGroup, verifiedSingleCarTireConservation,
  verifyGroupFulfillment } from '../../../src/atendente-v2/stock-group-offer.js';
import { acceptedCarGroup } from '../../../src/atendente-v2/car-group-consent.js';
import { isPriceObjection, lookupMarketObjection } from '../../../src/atendente-v2/market-objection.js';

const productId = '506adcda-a70e-46df-a67d-078140e27841';
const groupId = 'b0468399-c88c-4bbd-88f2-f265d303542f';
const otherGroupId = 'b0468399-c88c-4bbd-88f2-f265d303542a';
const measure = '265/60 R18';
const product = {
  product_id: productId, brand: 'Bridgestone', tire_condition: 'meia_vida',
  price_amount: '390.00', currency: 'BRL', price_type: 'regular', total_stock_available: 8,
} as ProdutoOferta;
const group = {
  group_id: groupId, product_id: productId, measure, brand: product.brand,
  tire_condition: product.tire_condition, model: 'Dueler', revision: '2',
  quantity_available: 8, conservation_grade: 'selecionado',
  positions: [{ location_code: 'B3' }], conservation_note: 'Nota da equipe',
};
const args = { tipo_veiculo: 'car', medida_pneu: measure };
const quote = { conjunto_id: groupId, product_id: productId, medida: measure,
  quantidade: 4, preco_unitario: 390, revisao: '2' };
const orderItems = [{ product_id: productId, quantidade: 4, preco_unitario: 390 }];
const client = { query: vi.fn() } as unknown as PoolClient;

function savedSearch(result: object = { produtos: [product], conjunto_carro: quote }) {
  const actions: ChatMessage[] = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'offer', type: 'function',
      function: { name: 'buscar_produto', arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: 'offer', content: JSON.stringify(result) },
  ];
  return { actions, provider_message_id: '100', say_text: 'Quer levar o jogo de quatro pneus?' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.env.WHOLESALE_MATRIZ_DECREMENT = true;
  mocked.env.MATRIZ_CAR_GROUP_OFFERS = true;
  mocked.env.MATRIZ_MARKET_REFERENCE_OBJECTIONS = true;
  mocked.location.mockImplementation(async () => ({
    municipio: 'Rio de Janeiro', customerLocation: { lat: 0, lng: 0 }, modalidade: 'delivery',
  }));
  mocked.route.mockResolvedValue({ kind: 'matriz', canFulfill: true });
  mocked.confirmation.mockResolvedValue({});
  mocked.matrix.mockResolvedValue({ canFulfill: true, block: null });
  mocked.officialQuantity.mockResolvedValue(1);
  mocked.group.mockReset().mockResolvedValue([group]);
  vi.mocked(client.query).mockReset();
});

describe('oferta de conjunto de carro da Matriz', () => {
  it('sugere a quantidade conferida quando o cliente não pediu um total, sem expor notas nem pilhas', async () => {
    const offer = await findCarStockGroup(client, 'test', 'conversation', args, [product]);
    expect(offer).toMatchObject({ ...quote, quantidade: 8 });
    expect(offer).toMatchObject({ total: 3120, modelo: 'Dueler', conservacao: 'selecionado' });
    expect(JSON.stringify(offer)).not.toMatch(/B3|Nota da equipe/);
    expect(mocked.group.mock.calls[0]?.[2]).toMatchObject({ quantity: 2, brand: product.brand });
  });

  it('oferece um conjunto de três quando conferido e respeita quantidade explícita acima de quatro', async () => {
    mocked.group.mockResolvedValueOnce([{ ...group, quantity_available: 3 }]);
    expect(await findCarStockGroup(client, 'test', 'conversation', args, [product])).toMatchObject({ quantidade: 3 });
    mocked.group.mockClear();
    expect(await findCarStockGroup(client, 'test', 'conversation', { ...args, quantidade: 6 }, [product]))
      .toMatchObject({ quantidade: 6, total: 2340 });
    expect(mocked.group).toHaveBeenCalledTimes(1);
  });

  it('preserva moto, tipo desconhecido, avulso, uma unidade e medidas por posição', async () => {
    vi.mocked(client.query).mockResolvedValue({ rows: [{ all_car: false }] } as never);
    const otherRequests = [{ ...args, tipo_veiculo: 'motorcycle', quantidade: 2 },
      { medida_pneu: measure, quantidade: 2 }, { ...args, quantidade: 1 },
      { ...args, pneus_avulsos: true }, { ...args, posicao_pneu: 'front' }];
    for (const request of otherRequests) {
      expect(await findCarStockGroup(client, 'test', 'conversation', request, [product])).toBeNull();
    }
    expect(mocked.group).not.toHaveBeenCalled();
  });

  it('impede grupo em parceiro e quantidade que o saldo total não atende', async () => {
    mocked.route.mockResolvedValueOnce({ kind: 'partner' });
    expect(await findCarStockGroup(client, 'test', 'conversation', args, [product])).toBeNull();
    mocked.group.mockClear();
    expect(await findCarStockGroup(client, 'test', 'conversation', { ...args, quantidade: 9 }, [product])).toBeNull();
    expect(mocked.group).not.toHaveBeenCalled();
  });

  it('aceita somente medida classificada inequivocamente como carro quando o tipo foi omitido', async () => {
    vi.mocked(client.query)
      .mockResolvedValueOnce({ rows: [{ all_car: true }] } as never)
      .mockResolvedValueOnce({ rows: [{ all_car: false }] } as never);
    const search = { medida_pneu: measure };
    await expect(findCarStockGroup(client, 'test', 'conversation', search, [product]))
      .resolves.toMatchObject({ quantidade: 8, conjunto_id: groupId });
    expect(vi.mocked(client.query).mock.calls[0]?.[1]).toEqual(['test', '265-60-18']);
    await expect(findCarStockGroup(client, 'test', 'conversation', search, [product])).resolves.toBeNull();
  });

  it('procura par explícito além do primeiro SKU e antes do limite de dez opções', async () => {
    const productsWithoutSets = Array.from({ length: 10 }, (_, index) => ({
      ...product, product_id: 'avulso-' + index, brand: 'Outra marca', total_stock_available: 10,
    }));
    const availableProducts = [...productsWithoutSets, { ...product, total_stock_available: 3 }];
    await expect(findCarStockGroup(client, 'test', 'conversation', args, availableProducts)).resolves.toBeNull();
    await expect(findCarStockGroup(client, 'test', 'conversation', {
      ...args, quantidade: 2, quer_conjunto: true,
    }, availableProducts)).resolves.toMatchObject({ product_id: productId, quantidade: 2, conjunto_id: groupId });
  });

  it('com a flag desligada não consulta grupos nem obriga novo vínculo em venda comum', async () => {
    mocked.env.MATRIZ_CAR_GROUP_OFFERS = false;
    await expect(findCarStockGroup(client, 'test', 'conversation', args, [product])).resolves.toBeNull();
    await expect(checkedBotGroupOffer(client, 'test', 'conversation', 'message', undefined, orderItems)).resolves.toEqual({});
    expect(mocked.group).not.toHaveBeenCalled();
    expect(vi.mocked(client.query)).not.toHaveBeenCalled();
  });

  it('valida a opção ofertada com ID, revisão, SKU, quantidade e preço antes da reserva', async () => {
    vi.mocked(client.query).mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM agent.turns') ? [savedSearch()] : [{ cliente: true, texto: 'Quero ver a foto' }],
    }) as never).mockResolvedValueOnce({ rows: [savedSearch()] } as never)
      .mockResolvedValueOnce({ rows: [{ cliente: true, texto: 'Quero o jogo' }] } as never);
    const verify = (id?: string, items = orderItems) =>
      checkedBotGroupOffer(client, 'test', 'conversation', 'message', id, items);
    await expect(verify(groupId)).resolves.toEqual({
      offer: { groupId, productId, quantity: 4, revision: '2' },
      accepted: true,
      quotedUnitPrice: 390,
    });
    await expect(verify()).resolves.toEqual({ error: 'conjunto_exige_id' });
    await expect(verify(otherGroupId)).resolves.toEqual({ error: 'conjunto_oferta_invalida' });
    await expect(verify(groupId)).resolves.toMatchObject({ accepted: false });
    await expect(verify(groupId, [{ ...orderItems[0]!, quantidade: 5 }]))
      .resolves.toEqual({ error: 'conjunto_oferta_invalida' });
    await expect(verify(undefined, Array.from({ length: 4 }, () => ({ ...orderItems[0]!, quantidade: 1 }))))
      .resolves.toEqual({ error: 'conjunto_exige_id' });
    expect(vi.mocked(client.query).mock.calls[0]?.[1]).toEqual(['test', 'conversation', 'message', false]);
  });

  it('comprova aceite da proposta e não transforma resposta a foto ou avulso em aceite', () => {
    const answer = (texto: string) => ({ cliente: true, texto });
    expect(acceptedCarGroup('Quer levar o jogo de quatro pneus?', 4, [answer('Sim')])).toBe(true);
    expect(acceptedCarGroup('Tenho um jogo de quatro. Quer ver as fotos?', 4, [answer('Sim')])).toBe(false);
    expect(acceptedCarGroup('Tenho o conjunto disponível.', 4, [answer('Quero o conjunto'), answer('Pix')])).toBe(true);
    expect(acceptedCarGroup('Tenho o conjunto disponível.', 4, [answer('Quero o conjunto'), answer('Só um avulso')])).toBe(false);
    expect(acceptedCarGroup('Tenho o conjunto de quatro disponível.', 4, [answer('Quero o par')])).toBe(false);
    expect(acceptedCarGroup('Tenho o conjunto de quatro disponível.', 4, [answer('Quero o jogo de dois pneus')])).toBe(false);
    expect(acceptedCarGroup('Tenho o conjunto de quatro disponível.', 4, [answer('Pode ser o jogo de quatro pneus')])).toBe(true);
  });

  it('revalida a revisão e a quantidade do grupo antes de cotar frete', async () => {
    vi.mocked(client.query).mockResolvedValue({ rows: [savedSearch()] } as never);
    const verify = () => verifyGroupFulfillment(client, 'test', 'conversation', 'message', { conjunto_id: groupId }, 'delivery');
    await expect(verify()).resolves.toMatchObject({ quote, location: { modalidade: 'delivery' } });
    mocked.group.mockResolvedValueOnce([{ ...group, revision: '3' }]);
    await expect(verify()).resolves.toBeNull();
  });

  it('atribui grau ao avulso apenas quando o saldo validado identifica uma unidade com grau', async () => {
    const single = [{ ...product, total_stock_available: 1 }];
    mocked.group.mockResolvedValue([{ ...group, quantity_available: 1 }]);
    const check = (products = single) => verifiedSingleCarTireConservation(
      client, 'test', 'conversation', { ...args, quantidade: 1 }, products,
    );
    await expect(check()).resolves.toEqual({ product_id: productId, conservacao: 'selecionado' });
    await expect(check([product])).resolves.toBeNull();
    mocked.group.mockResolvedValueOnce([{ ...group, quantity_available: 1, conservation_grade: null }]);
    await expect(check()).resolves.toBeNull();
    mocked.officialQuantity.mockResolvedValueOnce(2);
    await expect(check()).resolves.toBeNull();
  });
});

describe('referência online em objeção de preço', () => {
  it('distingue objeção explícita de consulta normal e frete', () => {
    expect(isPriceObjection('Esse pneu tá caro, vi mais barato')).toBe(true);
    expect(isPriceObjection('Faz por R$ 300?')).toBe(true);
    expect(isPriceObjection('Quanto sai o jogo?')).toBe(false);
    expect(isPriceObjection('O frete está muito caro')).toBe(false);
    expect(isPriceObjection('O frete desse pneu está caro')).toBe(false);
    expect(isPriceObjection('Não achei caro')).toBe(false);
    expect(isPriceObjection('Não preciso de desconto')).toBe(false);
    expect(isPriceObjection('O frete é ok, mas o pneu tá caro')).toBe(true);
  });

  it('só lê o preço online quando a mensagem real é uma objeção e o último produto é daquela Matriz', async () => {
    vi.mocked(client.query)
      .mockResolvedValueOnce({ rows: [{ content: 'Qual o valor?' }] } as never)
      .mockResolvedValueOnce({ rows: [{ content: 'Achei muito caro' }] } as never)
      .mockResolvedValueOnce({ rows: [{ ...savedSearch(), say_text: 'O jogo Bridgestone sai por R$ 1.560,00.' }] } as never);
    mocked.market.mockResolvedValue({ amount: 689, model: 'Dueler', observed_on: '2026-11-23', comparison: 'cotacao',
      source_url: 'https://nao-compartilhar.invalid' });
    const lookup = () => lookupMarketObjection(client, 'test', 'conversation', 'message', { product_id: productId });
    await expect(lookup()).resolves.toEqual({ referencia_disponivel: false });
    expect(mocked.market).not.toHaveBeenCalled();
    const result = await lookup();
    expect(result).toMatchObject({ preco_online_novo: 689, data_da_consulta: '2026-11-23', tipo_da_referencia: 'cotacao' });
    expect(result).not.toHaveProperty('source_url');
    const [query] = vi.mocked(client.query).mock.calls[2]!;
    expect(query).toContain('outbound.body AS say_text');
    expect(query).toContain('o.turn_id=t.id');
    expect(query).toContain('newer.provider_message_id < current.chatwoot_message_id');
  });

  it('não lê a referência para mera busca ou texto sem confirmação de envio', async () => {
    for (const previous of [savedSearch(), { ...savedSearch(), provider_message_id: null,
      say_text: 'Bridgestone R$ 390,00.' }]) {
      vi.mocked(client.query).mockResolvedValueOnce({ rows: [{ content: 'Achei muito caro' }] } as never)
        .mockResolvedValueOnce({ rows: [previous] } as never);
      await expect(lookupMarketObjection(client, 'test', 'conversation', 'message', { product_id: productId }))
        .resolves.toEqual({ referencia_disponivel: false });
    }
    expect(mocked.market).not.toHaveBeenCalled();
  });

  it('com a flag desligada a ferramenta não acessa o banco', async () => {
    mocked.env.MATRIZ_MARKET_REFERENCE_OBJECTIONS = false;
    await expect(lookupMarketObjection(client, 'test', 'conversation', 'message', { product_id: productId }))
      .resolves.toEqual({ referencia_disponivel: false });
    expect(vi.mocked(client.query)).not.toHaveBeenCalled();
  });
});
