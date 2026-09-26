import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { buscarPoliticaComercial, type ProdutoOferta } from '../atendente/tools/commerce-tools.js';
import { buscarProdutoMatriz, buscarCompatibilidadeMatriz, vehiclesWithApprovedFitments } from '../atendente-v2/matriz-product-search.js';
import { vehicleApplicationAnswer } from '../atendente-v2/vehicle-application-answer.js';
import { readDeliverySettings, applyMatrizDeliveryPolicies } from '../atendente-v2/matriz-delivery-settings.js';
import { loadVehicleApplicationCatalog } from '../shared/vehicle-application-catalog.js';
import { tireSizeKey } from '../shared/tire-size.js';
import type { Environment } from '../shared/types/chatwoot.js';

const condition = z.enum(['novo', 'meia_vida', 'remold']).nullable().default(null);
const productArgs = z.object({
  medida: z.string().trim().min(1).max(40).refine(value => Boolean(tireSizeKey(value))),
  condicao: condition,
  marca: z.string().trim().min(1).max(80).nullable().default(null),
}).strict();
const vehicleArgs = z.object({
  tipo_veiculo: z.enum(['motorcycle', 'car']),
  modelo: z.string().trim().min(1).max(100),
  ano: z.number().int().min(1900).max(2100).nullable().default(null),
  posicao: z.enum(['front', 'rear', 'both']).nullable().default(null),
  condicao: condition,
}).strict();
const schemas = { consultar_pneu: productArgs, consultar_veiculo: vehicleArgs, consultar_loja: z.object({}).strict() };
export type CommentToolName = keyof typeof schemas;
export type CommentLookup = (name: CommentToolName, args: Record<string, unknown>) => Promise<unknown>;
const nullableCondition = { type: ['string', 'null'], enum: ['novo', 'meia_vida', 'remold', null] };

/** Esta lista não importa o executor do atendente: nenhuma ferramenta de escrita existe aqui. */
export const COMMENT_TOOLS = [
  {
    type: 'function', name: 'consultar_pneu', strict: true,
    description: 'Consulta o catálogo, o saldo vendável e o preço atual da 2W Pneus. Use sempre antes de afirmar preço, marca, condição ou disponibilidade de uma medida. Medida informada dispensa veículo/ano. Não confirma entrega nem loja próxima. Não cria reserva.',
    parameters: { type: 'object', additionalProperties: false, required: ['medida', 'condicao', 'marca'], properties: {
      medida: { type: 'string', description: 'Medida dita pelo cliente ou identificada na publicação, como 130/70-13 ou 175/65R14.' },
      condicao: nullableCondition, marca: { type: ['string', 'null'] },
    } },
  },
  {
    type: 'function', name: 'consultar_veiculo', strict: true,
    description: 'Consulta as mesmas aplicações aprovadas do atendimento para moto ou carro. Não adivinhe medida por conhecimento próprio. Respeite os campos precisa_confirmar e consulte estoque somente para medidas identificadas.',
    parameters: { type: 'object', additionalProperties: false, required: ['tipo_veiculo', 'modelo', 'ano', 'posicao', 'condicao'], properties: {
      tipo_veiculo: { type: 'string', enum: ['motorcycle', 'car'] }, modelo: { type: 'string' },
      ano: { type: ['integer', 'null'] }, posicao: { type: ['string', 'null'], enum: ['front', 'rear', 'both', null] },
      condicao: nullableCondition,
    } },
  },
  {
    type: 'function', name: 'consultar_loja', strict: true,
    description: 'Consulta endereço público, funcionamento presencial e políticas públicas da loja. Use antes de informar endereço, horário, montagem, pagamento ou garantia. Não calcula frete e não acessa dados de clientes.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
] as const;

export function isCommentTool(name: string): name is CommentToolName {
  return Object.hasOwn(schemas, name);
}

export function parseCommentToolArgs(name: string, args: unknown): Record<string, unknown> {
  if (!isCommentTool(name)) throw new Error('comment_tool_not_allowed');
  return schemas[name].parse(args);
}

/** O ambiente vem do servidor, nunca da IA. A transação de leitura não atravessa chamadas de rede. */
export function createCommentLookup(pool: Pool, environment: Environment): CommentLookup {
  return async (name, args) => {
    // Validação antes de abrir conexão, inclusive para chamadas fora do modelo.
    const parsed = parseCommentToolArgs(name, args);
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = name === 'consultar_pneu'
        ? await products(client, environment, productArgs.parse(parsed))
        : name === 'consultar_veiculo'
          ? await vehicle(client, environment, vehicleArgs.parse(parsed))
          : await shop(client, environment);
      await client.query('COMMIT');
      return result;
    } catch {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      // Não expor SQL/credenciais nem transformar indisponibilidade técnica em estoque zerado.
      return { erro: 'consulta_indisponivel', orientacao: 'Não foi possível consultar agora. Não confirme preço, medida, estoque, endereço ou horário sem dados; encaminhe ao atendimento privado.' };
    } finally { client.release(discard); }
  };
}

type PublicProduct = ReturnType<typeof publicProduct>;
function publicProduct(product: ProdutoOferta & { stock_block_reason?: string | null }) {
  const uncertain = product.stock_block_reason && !['walkin_stock_insufficient', 'walkin_measure_not_found'].includes(product.stock_block_reason);
  const price = product.price_amount == null ? null : Number(product.price_amount);
  return {
    medida: product.tire_size, posicao: product.tire_position, condicao: product.tire_condition, marca: product.brand,
    disponivel: uncertain ? null : product.total_stock_available > 0,
    preco: price !== null && Number.isFinite(price) && price > 0 && product.currency === 'BRL' ? price : null,
    moeda: product.currency,
  };
}

async function products(client: PoolClient, environment: Environment, args: z.infer<typeof productArgs>, position?: 'front' | 'rear' | 'both') {
  // Reutiliza catálogo/preço vigente e estoque oficial com reservas descontadas.
  // Não usa executeTool: ele também grava localização/demanda da conversa privada.
  const rows = await buscarProdutoMatriz(client, {
    environment, medida_pneu: args.medida, marca: args.marca ?? undefined,
    condicao_pneu: args.condicao ?? undefined, posicao_pneu: position, apenas_com_estoque: false, limit: 20,
  });
  return {
    consultado_em: new Date().toISOString(), medida_consultada: args.medida,
    catalogo_encontrado: rows.length > 0, produtos: rows.map(publicProduct),
    escopo: 'Estoque da 2W Pneus. Não confirma entrega, reserva ou disponibilidade em outra loja. Cadastro sem saldo não é disponibilidade. Ausência de cadastro não comprova falta física.',
  };
}

async function vehicle(client: PoolClient, environment: Environment, args: z.infer<typeof vehicleArgs>) {
  const input = { environment, moto_modelo: args.modelo, moto_ano: args.ano ?? undefined,
    posicao_pneu: args.posicao ?? undefined, condicao_pneu: args.condicao ?? undefined, limit: 20 };
  // Preserva os vínculos de SKU já usados pelo atendente para motos.
  const approved = args.tipo_veiculo === 'motorcycle'
    ? vehiclesWithApprovedFitments(await buscarCompatibilidadeMatriz(client, input, { deferLimit: true })) : [];
  if (approved.length > 0) {
    const needsModel = new Set(approved.map(v => `${v.make}:${v.model}:${v.variant ?? ''}`)).size > 1;
    const needsContext = !args.ano || !args.posicao || needsModel;
    const matchingProducts: PublicProduct[] = needsContext ? [] : approved.flatMap(v => v.produtos.map(p => publicProduct({
      ...p, product_code: '', product_type: 'tire', short_description: null, tire_position: p.position,
      intended_use: null, price_amount: p.current_price, currency: 'BRL', price_type: null,
      total_stock_available: p.total_stock,
    })));
    return { encontrado: true, precisa_confirmar_ano: !args.ano, precisa_confirmar_posicao: !args.posicao,
      precisa_confirmar_modelo_versao: needsModel, estoque_consultado: !needsContext,
      modelos: approved.map(({ make, model, variant, year_start, year_end }) => ({ make, model, variant, year_start, year_end })),
      produtos: matchingProducts,
    };
  }
  const catalog = await loadVehicleApplicationCatalog(client, environment, undefined, args.tipo_veiculo);
  const application = vehicleApplicationAnswer(input, catalog, args.tipo_veiculo);
  if (!application) return { encontrado: false, estoque_consultado: false,
    orientacao: 'Compatibilidade não confirmada no cadastro. Peça a medida escrita no pneu; não adivinhe nem afirme falta de estoque.' };
  const stock = [];
  for (const query of application.consultas_de_produto.slice(0, 4)) {
    const positions = [...new Set(application.aplicacoes.filter(a => a.display_measure === query.medida_pneu).map(a => a.position))];
    stock.push(await products(client, environment, { medida: query.medida_pneu, condicao: args.condicao, marca: null },
      positions.length === 1 ? positions[0] : 'both'));
  }
  return {
    encontrado: application.encontrado, precisa_confirmar_ano: application.precisa_confirmar_ano,
    precisa_confirmar_posicao: application.precisa_confirmar_posicao,
    precisa_confirmar_modelo_versao: application.precisa_confirmar_modelo_versao,
    precisa_confirmar_medida: application.precisa_confirmar_medida,
    aplicacoes: application.aplicacoes.map(a => ({ modelo: a.model, ano_inicio: a.year_start, ano_fim: a.year_end,
      posicao: a.position, medida: a.tire_size, indice: a.index_spec, montagem: a.mounting })),
    estoque_consultado: stock.length > 0, consultas_estoque: stock,
    orientacao: 'Pergunte somente o que as flags indicam faltar. Aplicação de medida não homologa qualquer SKU: preserve construção radial/diagonal, índices e montagem; não substitua medidas.',
  };
}

const PUBLIC_POLICIES = ['endereco', 'horario_funcionamento', 'formas_pagamento_aceitas',
  'parcelamento_maximo', 'prazo_garantia_pneus', 'garantia_descricao', 'faz_montagem',
  'politica_montagem', 'prazo_troca', 'politica_devolucao', 'emite_nota_fiscal'];

async function shop(client: PoolClient, environment: Environment) {
  const saved = await readDeliverySettings(client, environment);
  const policies = await buscarPoliticaComercial(client, { environment, policy_keys: PUBLIC_POLICIES });
  const current = saved ? applyMatrizDeliveryPolicies(policies, saved) : policies;
  return {
    agora_brasilia: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    politicas: current.filter(p => PUBLIC_POLICIES.includes(p.policy_key)).map(p => ({ chave: p.policy_key, valor: p.policy_value })),
    entrega_habilitada: saved?.settings.delivery_enabled ?? null,
    retirada_habilitada: saved?.settings.pickup_enabled ?? null,
    orientacao: 'Dados públicos da loja 2W Pneus; omita o termo Matriz na resposta. Horário da loja não é horário de entrega. Feriados precisam de confirmação. Frete/cobertura exigem endereço e consulta no privado.',
  };
}
