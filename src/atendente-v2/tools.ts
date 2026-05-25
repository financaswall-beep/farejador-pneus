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
      strict: true,
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
      strict: true,
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
        return JSON.stringify({ encontrado: true, veiculos: result });
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
        return JSON.stringify({ encontrado: true, produtos: result });
      }

      case 'calcular_frete': {
        const result = await calcularFrete(client, {
          environment,
          bairro: args.bairro as string,
          municipio: args.municipio as string | undefined,
        });
        return JSON.stringify(result);
      }

      case 'verificar_estoque': {
        const result = await verificarEstoque(client, {
          environment,
          product_id: args.product_id as string | undefined,
          product_code: args.product_code as string | undefined,
        });
        if (!result) return JSON.stringify({ encontrado: false });
        return JSON.stringify(result);
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

  const orderResult = await client.query<{ id: string; order_number: string }>(
    `INSERT INTO commerce.orders (
       environment, source_conversation_id, total_amount, status,
       fulfillment_mode, payment_method, delivery_address, geo_resolution_id, source
     ) VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, 'bot_v2')
     RETURNING id, order_number`,
    [
      environment,
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
