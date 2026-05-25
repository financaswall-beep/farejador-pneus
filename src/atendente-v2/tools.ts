import type { PoolClient } from 'pg';
import {
  buscarProduto,
  buscarCompatibilidade,
  calcularFrete,
  verificarEstoque,
  buscarPoliticaComercial,
} from '../atendente/tools/commerce-tools.js';
import { logger } from '../shared/logger.js';
import type { ToolDefinition } from './types.js';
import type { Environment } from '../shared/types/chatwoot.js';

// ─── OpenAI tool schemas ───────────────────────────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'buscar_compatibilidade',
      description: 'Dado o modelo da moto (e opcionalmente o ano), retorna os pneus compatíveis com preço e estoque.',
      parameters: {
        type: 'object',
        properties: {
          moto_modelo: { type: 'string', description: 'Modelo da moto. Ex: "Fan 150", "CG Titan 160"' },
          moto_ano: { type: 'integer', description: 'Ano do modelo (opcional)' },
          posicao_pneu: { type: 'string', enum: ['front', 'rear', 'both'], description: 'Posição do pneu (opcional)' },
        },
        required: ['moto_modelo'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_produto',
      description: 'Busca pneus por medida, marca ou código. Use quando o cliente mencionar medida (ex: 90/90-18) ou marca.',
      parameters: {
        type: 'object',
        properties: {
          medida_pneu: { type: 'string', description: 'Medida do pneu. Ex: "90/90-18"' },
          marca: { type: 'string', description: 'Marca. Ex: "Pirelli", "Levorin"' },
          posicao_pneu: { type: 'string', enum: ['front', 'rear', 'both'] },
          apenas_com_estoque: { type: 'boolean', description: 'Filtrar só com estoque disponível' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calcular_frete',
      description: 'Calcula frete para um bairro. Exige bairro. Cidade é opcional se for a cidade da loja.',
      parameters: {
        type: 'object',
        properties: {
          bairro: { type: 'string', description: 'Nome do bairro. Ex: "Centro", "Vila Mariana"' },
          municipio: { type: 'string', description: 'Cidade (opcional)' },
        },
        required: ['bairro'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verificar_estoque',
      description: 'Verifica estoque de um produto específico pelo product_id ou código.',
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'string', description: 'UUID do produto' },
          product_code: { type: 'string', description: 'Código do produto (alternativo ao product_id)' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_politica',
      description: 'Retorna políticas da loja: garantia, horário, formas de pagamento, troca, frete mínimo.',
      parameters: {
        type: 'object',
        properties: {
          policy_keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Chaves de política (opcional). Se omitido, retorna todas.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'criar_pedido',
      description: 'Cria o pedido quando o cliente confirmou produto, modalidade e dados de entrega/pagamento.',
      parameters: {
        type: 'object',
        properties: {
          itens: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'string', description: 'UUID do produto' },
                quantidade: { type: 'integer', minimum: 1 },
                preco_unitario: { type: 'number', description: 'Preço unitário em reais' },
              },
              required: ['product_id', 'quantidade', 'preco_unitario'],
              additionalProperties: false,
            },
          },
          nome_cliente: { type: 'string' },
          modalidade: { type: 'string', enum: ['delivery', 'pickup'] },
          endereco_entrega: { type: 'string', description: 'Obrigatório se modalidade=delivery' },
          forma_pagamento: { type: 'string', enum: ['pix', 'cartao', 'dinheiro'] },
          geo_resolution_id: { type: 'string', description: 'UUID da geo_resolution (opcional, do calcular_frete)' },
        },
        required: ['itens', 'nome_cliente', 'modalidade', 'forma_pagamento'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalar_humano',
      description: 'Escalada para atendente humano. Use quando o cliente pedir humano, após 2 falhas consecutivas, ou em reclamação grave.',
      parameters: {
        type: 'object',
        properties: {
          motivo: {
            type: 'string',
            enum: ['cliente_pediu', 'duvida_complexa', 'reclamacao', 'tool_falhou', 'outro'],
          },
          resumo: { type: 'string', description: 'Resumo da conversa para o atendente humano (máx 500 chars)' },
        },
        required: ['motivo', 'resumo'],
        additionalProperties: false,
      },
    },
  },
];

// ─── Helpers: enxugam retornos das tools antes de virar JSON pro LLM ─────
// Removem campos que o LLM não usa (vehicle_model_id, is_oem, source,
// confidence_level, displacement_cc, etc.) — esses dados ficam acumulados
// no histórico turn a turn e somam tokens à toa.

function trimVeiculo(v: {
  vehicle_model_id: string;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  displacement_cc: number | null;
  produtos: Array<{
    product_id: string;
    product_name: string;
    brand: string | null;
    tire_size: string;
    position: 'front' | 'rear' | 'both';
    is_oem: boolean;
    source: string;
    confidence_level: string | null;
    current_price: string | null;
    total_stock: number;
  }>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { model: v.model };
  if (v.variant) out.variant = v.variant;
  if (v.year_start) out.year_start = v.year_start;
  if (v.year_end) out.year_end = v.year_end;
  out.produtos = v.produtos.map((p) => {
    const item: Record<string, unknown> = {
      product_id: p.product_id,
      product_name: p.product_name,
      tire_size: p.tire_size,
      position: p.position,
      current_price: p.current_price,
      total_stock: p.total_stock,
    };
    if (p.brand) item.brand = p.brand;
    return item;
  });
  return out;
}

function trimProduto(p: {
  product_id: string;
  product_code: string;
  product_name: string;
  brand: string | null;
  tire_size: string | null;
  tire_position: 'front' | 'rear' | 'both' | null;
  price_amount: string | null;
  total_stock_available: number;
}): Record<string, unknown> {
  const item: Record<string, unknown> = {
    product_id: p.product_id,
    product_name: p.product_name,
    tire_size: p.tire_size,
    tire_position: p.tire_position,
    price_amount: p.price_amount,
    total_stock_available: p.total_stock_available,
  };
  if (p.brand) item.brand = p.brand;
  return item;
}

function trimEstoque(e: {
  product_id: string;
  product_name: string;
  disponivel: boolean;
  quantidade_total: number;
}): Record<string, unknown> {
  return {
    product_id: e.product_id,
    product_name: e.product_name,
    disponivel: e.disponivel,
    quantidade_total: e.quantidade_total,
  };
}

function trimFrete(f: {
  encontrado: boolean;
  bairro_canonico: string | null;
  municipio: string | null;
  disponivel: boolean;
  valor: string | null;
  prazo_dias: number | null;
  motivo?: string;
}): Record<string, unknown> {
  if (!f.encontrado) return { encontrado: false, motivo: f.motivo ?? 'bairro não encontrado' };
  return {
    encontrado: true,
    bairro_canonico: f.bairro_canonico,
    municipio: f.municipio,
    disponivel: f.disponivel,
    valor: f.valor,
    prazo_dias: f.prazo_dias,
  };
}

// ─── Tool executors ────────────────────────────────────────────────────────

export async function executeTool(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case 'buscar_compatibilidade': {
        const result = await buscarCompatibilidade(client, {
          environment,
          moto_modelo: args.moto_modelo as string,
          moto_ano: args.moto_ano as number | undefined,
          posicao_pneu: args.posicao_pneu as 'front' | 'rear' | 'both' | undefined,
          limit: 10,
        });
        if (result.length === 0) return JSON.stringify({ encontrado: false, mensagem: 'Nenhuma moto encontrada com esse modelo.' });
        return JSON.stringify({ encontrado: true, veiculos: result.map(trimVeiculo) });
      }

      case 'buscar_produto': {
        const result = await buscarProduto(client, {
          environment,
          medida_pneu: args.medida_pneu as string | undefined,
          marca: args.marca as string | undefined,
          posicao_pneu: args.posicao_pneu as 'front' | 'rear' | 'both' | undefined,
          apenas_com_estoque: (args.apenas_com_estoque as boolean | undefined) ?? false,
          limit: 10,
        });
        if (result.length === 0) return JSON.stringify({ encontrado: false, mensagem: 'Nenhum produto encontrado.' });
        return JSON.stringify({ encontrado: true, produtos: result.map(trimProduto) });
      }

      case 'calcular_frete': {
        const result = await calcularFrete(client, {
          environment,
          bairro: args.bairro as string,
          municipio: args.municipio as string | undefined,
        });
        return JSON.stringify(trimFrete(result));
      }

      case 'verificar_estoque': {
        const result = await verificarEstoque(client, {
          environment,
          product_id: args.product_id as string | undefined,
          product_code: args.product_code as string | undefined,
        });
        if (!result) return JSON.stringify({ encontrado: false });
        return JSON.stringify(trimEstoque(result));
      }

      case 'buscar_politica': {
        const result = await buscarPoliticaComercial(client, {
          environment,
          policy_keys: args.policy_keys as string[] | undefined,
        });
        return JSON.stringify({ politicas: result });
      }

      case 'criar_pedido': {
        return await criarPedido(client, environment, conversationId, args);
      }

      case 'escalar_humano': {
        logger.info(
          { environment, conversation_id: conversationId, motivo: args.motivo, resumo: args.resumo },
          'agent_v2: escalar_humano chamado',
        );
        return JSON.stringify({ ok: true, mensagem: 'Escalada registrada. Atendente humano será notificado.' });
      }

      default:
        return JSON.stringify({ erro: `Tool desconhecida: ${name}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ environment, conversation_id: conversationId, tool: name, err: message }, 'agent_v2: tool error');
    return JSON.stringify({ erro: message });
  }
}

// ─── criar_pedido ──────────────────────────────────────────────────────────

interface PedidoItem {
  product_id: string;
  quantidade: number;
  preco_unitario: number;
}

async function criarPedido(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const itens = args.itens as PedidoItem[];
  const totalAmount = itens.reduce((sum, i) => sum + i.quantidade * i.preco_unitario, 0);
  const modalidade = args.modalidade as string;

  // Busca contact_id direto da conversa
  const convResult = await client.query<{ contact_id: string | null }>(
    `SELECT contact_id FROM core.conversations WHERE id = $1 LIMIT 1`,
    [conversationId],
  );
  const contactId = convResult.rows[0]?.contact_id ?? null;

  if (!contactId) {
    return JSON.stringify({ erro: 'Contato não encontrado para esta conversa.' });
  }

  const orderResult = await client.query<{ id: string; order_number: string }>(
    `INSERT INTO commerce.orders (
       environment, contact_id, source_conversation_id, total_amount, status,
       fulfillment_mode, payment_method, delivery_address, geo_resolution_id, source
     ) VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, 'chatwoot_com_bot')
     RETURNING id, order_number`,
    [
      environment,
      contactId,
      conversationId,
      totalAmount.toFixed(2),
      modalidade,
      args.forma_pagamento ?? null,
      modalidade === 'delivery' ? (args.endereco_entrega ?? null) : null,
      args.geo_resolution_id ?? null,
    ],
  );

  const order = orderResult.rows[0];
  if (!order) throw new Error('Falha ao criar pedido');

  for (const item of itens) {
    await client.query(
      `INSERT INTO commerce.order_items (environment, order_id, product_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4, $5)`,
      [environment, order.id, item.product_id, item.quantidade, item.preco_unitario.toFixed(2)],
    );
  }

  logger.info(
    { environment, conversation_id: conversationId, order_id: order.id, order_number: order.order_number },
    'agent_v2: pedido criado',
  );

  return JSON.stringify({
    ok: true,
    order_number: order.order_number,
    total: totalAmount.toFixed(2),
    mensagem: `Pedido ${order.order_number} criado com sucesso.`,
  });
}
