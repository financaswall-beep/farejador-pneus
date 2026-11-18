import type { PoolClient } from 'pg';
import { tireSizeKey } from '../../src/shared/tire-size.js';
import { repriceMatrizQuotedItems } from '../../src/atendente-v2/channel-pricing.js';
import type { ChatMessage } from '../../src/atendente-v2/types.js';

export interface LabScenario {
  id: string;
  nome: string;
  medida: string;
  estoque: number;
  precoCentavos: number;
  custoCentavos: number;
  freteCentavos: number;
  paradaCentavos: number | null;
  giroSemanal: number;
  reposicaoDias: number;
  rotaConfirmada: boolean;
}

const abundant: LabScenario = {
  id: 'abundante', nome: 'Estoque alto e rota confirmada', medida: '110/70-13',
  estoque: 100, precoCentavos: 11000, custoCentavos: 5000, freteCentavos: 1500,
  paradaCentavos: 500, giroSemanal: 4, reposicaoDias: 7, rotaConfirmada: true,
};

export const LAB_SCENARIOS: LabScenario[] = [
  abundant,
  { ...abundant, id: 'escasso', nome: 'Últimas unidades e reposição em três semanas',
    medida: '140/70-17', estoque: 2, reposicaoDias: 21 },
  { ...abundant, id: 'exclusiva', nome: 'Entrega exclusiva', paradaCentavos: 3500, rotaConfirmada: false },
];

const skuId = '00000000-4444-4444-8444-000000000001';
const supportedArea = 'Centro';
const store = 'Matriz de teste';
const normalized = (value: unknown) => String(value ?? '').trim().toLowerCase();
const supported = (value: unknown) => normalized(value) === normalized(supportedArea);
const missingRegion = { encontrado: false, precisa_localizacao: true, motivo: 'sem_localizacao_pergunte_bairro' };
const outsideRegion = { encontrado: false, disponivel: false, motivo: 'bairro_nao_encontrado' };

function product(s: LabScenario) {
  return { product_id: skuId, product_code: 'LAB-01', product_name: 'Pneu novo ' + s.medida,
    product_type: 'tire', brand: 'Marca Teste', tire_condition: 'novo', tire_size: s.medida,
    tire_position: null, price_amount: (s.precoCentavos/100).toFixed(2), currency: 'BRL',
    price_type: 'retail', total_stock_available: s.estoque };
}

function locationFromHistory(history: ChatMessage[]): string {
  // Reutiliza apenas o bairro já informado pelo cliente e registrado no laboratório.
  const calls = history.flatMap(message => message.tool_calls ?? []);
  const call = calls.reverse().find(item => item.function.name === 'registrar_localizacao_lead');
  if (!call) return '';
  const saved = JSON.parse(call.function.arguments);
  return typeof saved.bairro === 'string' ? saved.bairro : '';
}

async function checkOrder(s: LabScenario, args: Record<string, unknown>) {
  const items = Array.isArray(args.itens) ? args.itens : [];
  if (!items.length || items.some(item => item?.product_id !== skuId
    || !Number.isInteger(item.quantidade) || item.quantidade < 1 || typeof item.preco_unitario !== 'number')) {
    return { erro: 'itens_invalidos' };
  }
  if (items.reduce((n, item) => n + item.quantidade, 0) > s.estoque) return { erro: 'estoque_insuficiente' };

  // Reaproveita a conferência de preço do checkout V2. A função só conhece este leitor
  // de catálogo em memória. Os handlers de comércio, PostgreSQL e reserva nunca são chamados.
  const fixtureReader = { query: async () => ({ rows: [product(s)] }) } as unknown as PoolClient;
  const priced = await repriceMatrizQuotedItems(fixtureReader, 'test', items);
  if (!priced.ok) return priced.response;
  if (args.modalidade !== 'delivery' && args.modalidade !== 'pickup') return { erro: 'modalidade_obrigatoria' };
  const expectedFreight = args.modalidade === 'delivery' ? s.freteCentavos : 0;
  if (Math.round(Number(args.valor_frete ?? 0)*100) !== expectedFreight) {
    return { erro: 'frete_alterado', nova_confirmacao_obrigatoria: true, valor_frete_atual: expectedFreight/100 };
  }
  return { erro: 'fechamento_indisponivel', mensagem: 'O pagamento e a criação de pedido estão desligados neste teste. Nenhum pedido foi criado.' };
}

export async function labTool(name: string, args: Record<string, unknown>, s: LabScenario, history: ChatMessage[]) {
  const bairro = args.bairro || locationFromHistory(history);
  switch (name) {
    case 'buscar_produto': {
      if (bairro && !supported(bairro)) return outsideRegion;
      if ((args.medida_pneu && tireSizeKey(String(args.medida_pneu)) !== tireSizeKey(s.medida))
        || (args.marca && normalized(args.marca) !== 'marca teste')
        || (args.condicao_pneu && args.condicao_pneu !== 'novo')) {
        return { encontrado: false, mensagem: 'Nenhum produto encontrado.' };
      }
      return { encontrado: true, produtos: [product(s)], ...(bairro ? {} : { precisa_localizacao: true }) };
    }
    case 'buscar_compatibilidade':
      return { encontrado: false, veiculos: [], mensagem: 'Aplicação por moto não cadastrada. Solicite a medida escrita no pneu.' };
    case 'calcular_frete':
      if (!bairro) return missingRegion;
      if (!supported(bairro)) return outsideRegion;
      if (Array.isArray(args.produtos) && args.produtos.some(p => p?.product_id !== skuId)) return { erro: 'produto_desconhecido' };
      return { encontrado: true, disponivel: true, bairro_canonico: supportedArea, valor: (s.freteCentavos/100).toFixed(2),
        prazo_dias: null, geo_resolution_id: null, delivery_mode: 'delivery' };
    case 'verificar_estoque':
      if (args.product_id !== skuId && args.product_code !== 'LAB-01') return { encontrado: false };
      return { product_id: skuId, disponivel: s.estoque > 0, quantidade_total: s.estoque,
        locations: [{ location: store, quantity_available: s.estoque, quantity_reserved: 0 }] };
    case 'registrar_localizacao_lead':
      if (!args.texto_informado) return { erro: 'localizacao_lead_invalida' };
      return { ok: true, registrado: 'localizacao_lead', natureza: 'estimada_nao_confirmada_para_entrega' };
    case 'localizacao_loja':
      if (!bairro) return missingRegion;
      if (!supported(bairro) || (Array.isArray(args.product_ids) && args.product_ids.some(id => id !== skuId))) {
        return { encontrado: false, motivo: 'sem_loja_com_estoque_perto' };
      }
      return { encontrado: true, nome_loja: store };
    case 'buscar_politica': return { politicas: [] };
    case 'consultar_horario_loja': return { encontrado: true, nome_loja: store, horario: null, status_agora: 'desconhecido' };
    case 'criar_pedido': return checkOrder(s, args);
    case 'consultar_pedido': return { encontrado: false, pedidos: [] };
    default: return { erro: 'operacao_indisponivel_no_teste', mensagem: 'Operação indisponível. Nenhuma ação realizada.' };
  }
}
