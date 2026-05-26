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
      description: 'Reconfirma estoque de um produto. RARAMENTE NECESSÁRIA: estoque já vem em buscar_compatibilidade e buscar_produto. Use SÓ antes de criar_pedido se a busca foi há 8+ turnos. Não chame só por segurança.',
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
          valor_frete: { type: 'number', description: 'Valor do frete em reais. OBRIGATÓRIO quando modalidade=delivery — passe o valor retornado por calcular_frete. Em pickup, omita ou 0.' },
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
      name: 'consultar_pedido',
      description: 'Consulta pedido(s) que o cliente JÁ FEZ. Use quando o cliente perguntar "cadê meu pedido?", "qual o status do PED-XXXX?", "já saiu?", etc. Se ele passar o número, busca por número. Se não, lista os últimos pedidos dele.',
      parameters: {
        type: 'object',
        properties: {
          order_number: { type: 'string', description: 'Número do pedido (ex: "PED-0006"). Opcional — se omitido, lista os últimos pedidos do contato da conversa atual.' },
          limit: { type: 'integer', description: 'Quantos pedidos retornar quando lista (default 5)', minimum: 1, maximum: 10 },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancelar_pedido',
      description: 'Cancela um pedido com status=open (recém criado, ainda não confirmado/pago/entregue). Use quando cliente desistir, achar caro, mudar de planos, ou pedir cancelamento. SEMPRE confirme com o cliente antes de chamar. Não cancela pedido pago/entregue (escalar humano nesses casos).',
      parameters: {
        type: 'object',
        properties: {
          order_number: { type: 'string', description: 'Número do pedido (ex: "PED-0010"). Obrigatório.' },
          motivo: {
            type: 'string',
            enum: ['sem_grana', 'achou_outro_lugar', 'frete_caro', 'mudou_planos', 'atraso_entrega', 'erro_pedido', 'outro'],
            description: 'Categoria do motivo. Use o que mais se aproxima do que o cliente disse.',
          },
          detalhes: { type: 'string', description: 'Detalhes em texto livre do que o cliente disse (opcional, max 300 chars)' },
        },
        required: ['order_number', 'motivo'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editar_pedido',
      description: 'Edita um pedido com status=open (recém criado). Use quando cliente quiser mudar endereço, forma de pagamento, OU remover/adicionar item. SEMPRE confirme com o cliente antes de chamar. Cliente DEVE explicitamente pedir a mudança. Não edita pedido pago/entregue.',
      parameters: {
        type: 'object',
        properties: {
          order_number: { type: 'string', description: 'Número do pedido (ex: "PED-0010"). Obrigatório.' },
          novo_endereco: { type: 'string', description: 'Novo endereço completo (rua, número, bairro). Opcional.' },
          nova_forma_pagamento: { type: 'string', enum: ['pix', 'cartao', 'dinheiro'], description: 'Nova forma de pagamento. Opcional.' },
          remover_itens: {
            type: 'array',
            items: { type: 'string', description: 'product_id (UUID) do item a remover' },
            description: 'product_ids dos itens a remover do pedido. Opcional.',
          },
          adicionar_itens: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'string' },
                quantidade: { type: 'integer', minimum: 1 },
                preco_unitario: { type: 'number' },
              },
              required: ['product_id', 'quantidade', 'preco_unitario'],
              additionalProperties: false,
            },
            description: 'Novos itens a adicionar. Opcional.',
          },
          motivo: { type: 'string', description: 'Motivo livre da edição (ex: "cliente trocou bairro de entrega")' },
        },
        required: ['order_number'],
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

      case 'consultar_pedido': {
        return await consultarPedido(client, environment, conversationId, args);
      }

      case 'cancelar_pedido': {
        return await cancelarPedido(client, environment, conversationId, args);
      }

      case 'editar_pedido': {
        return await editarPedido(client, environment, conversationId, args);
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
  const subtotal = itens.reduce((sum, i) => sum + i.quantidade * i.preco_unitario, 0);
  const modalidade = args.modalidade as string;
  const valorFrete = Number(args.valor_frete ?? 0) || 0;

  // Guard: delivery sem frete é provavelmente o LLM esquecendo o campo.
  // Retorna erro estruturado pra ele rechamar com valor_frete.
  if (modalidade === 'delivery' && valorFrete <= 0) {
    return JSON.stringify({
      erro: 'valor_frete obrigatório quando modalidade=delivery. Reuse o valor do calcular_frete que você já chamou.',
    });
  }

  const totalAmount = subtotal + valorFrete;

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
       fulfillment_mode, payment_method, delivery_address, geo_resolution_id, source, customer_name
     ) VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, 'chatwoot_com_bot', $9)
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
      // customer_name: nome dado NA conversa (pode diferir de core.contacts.name
      // quando o WhatsApp e compartilhado). Mantemos core.contacts.name intocado.
      (args.nome_cliente as string | undefined)?.slice(0, 200) ?? null,
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
    subtotal_itens: subtotal.toFixed(2),
    valor_frete: valorFrete.toFixed(2),
    total: totalAmount.toFixed(2),
    mensagem: `Pedido ${order.order_number} criado com sucesso.`,
  });
}

// ─── consultar_pedido ──────────────────────────────────────────────────────

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  total_amount: string;
  fulfillment_mode: string;
  payment_method: string | null;
  delivery_address: string | null;
  customer_name: string | null;
  created_at: Date;
  closed_at: Date | null;
}

interface OrderItemRow {
  product_name: string;
  product_code: string;
  quantity: number;
  unit_price: string;
}

async function consultarPedido(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const orderNumber = args.order_number as string | undefined;
  const limit = Math.min(Math.max(Number(args.limit ?? 5), 1), 10);

  // Busca contact_id da conversa atual.
  const convResult = await client.query<{ contact_id: string | null }>(
    `SELECT contact_id FROM core.conversations WHERE id = $1 LIMIT 1`,
    [conversationId],
  );
  const contactId = convResult.rows[0]?.contact_id ?? null;

  let orders: OrderRow[];

  if (orderNumber) {
    // Busca por numero — pode ser de qualquer contato (cliente pode estar
    // perguntando de pedido de outra conta dele).
    const result = await client.query<OrderRow>(
      `SELECT id, order_number, status, total_amount, fulfillment_mode,
              payment_method, delivery_address, customer_name, created_at, closed_at
       FROM commerce.orders
       WHERE environment = $1
         AND order_number = $2
       LIMIT 1`,
      [environment, orderNumber.toUpperCase().trim()],
    );
    orders = result.rows;

    if (orders.length === 0) {
      return JSON.stringify({
        encontrado: false,
        mensagem: `Não encontrei pedido ${orderNumber}. Confere o número?`,
      });
    }
  } else {
    // Sem numero — lista os ultimos pedidos do contato da conversa atual.
    if (!contactId) {
      return JSON.stringify({
        encontrado: false,
        mensagem: 'Não consegui identificar o contato. Me passa o número do pedido (ex: PED-0042).',
      });
    }
    const result = await client.query<OrderRow>(
      `SELECT id, order_number, status, total_amount, fulfillment_mode,
              payment_method, delivery_address, customer_name, created_at, closed_at
       FROM commerce.orders
       WHERE environment = $1
         AND contact_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [environment, contactId, limit],
    );
    orders = result.rows;

    if (orders.length === 0) {
      return JSON.stringify({
        encontrado: false,
        mensagem: 'Você ainda não tem pedidos comigo. Quer fazer um?',
      });
    }
  }

  // Pra cada pedido, busca os itens.
  const pedidos = await Promise.all(
    orders.map(async (o) => {
      const itensResult = await client.query<OrderItemRow>(
        `SELECT p.product_name, p.product_code,
                oi.quantity, oi.unit_price
         FROM commerce.order_items oi
         JOIN commerce.products p ON p.id = oi.product_id
         WHERE oi.order_id = $1
         ORDER BY p.product_name`,
        [o.id],
      );
      return {
        order_number: o.order_number,
        status: o.status,
        total: o.total_amount,
        modalidade: o.fulfillment_mode,
        pagamento: o.payment_method,
        endereco_entrega: o.delivery_address,
        cliente_nome: o.customer_name,
        criado_em: o.created_at.toISOString(),
        fechado_em: o.closed_at?.toISOString() ?? null,
        itens: itensResult.rows.map((i) => ({
          produto: i.product_name,
          codigo: i.product_code,
          quantidade: i.quantity,
          preco_unitario: i.unit_price,
        })),
      };
    }),
  );

  return JSON.stringify({
    encontrado: true,
    pedidos,
    total_pedidos: pedidos.length,
  });
}

// ─── cancelar_pedido ───────────────────────────────────────────────────────

async function cancelarPedido(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const orderNumber = (args.order_number as string)?.toUpperCase().trim();
  const motivo = args.motivo as string;
  const detalhes = (args.detalhes as string | undefined)?.slice(0, 300);

  if (!orderNumber || !motivo) {
    return JSON.stringify({ erro: 'order_number e motivo sao obrigatorios' });
  }

  // Busca pedido + valida que pertence ao contato da conversa atual
  const orderResult = await client.query<{
    id: string;
    status: string;
    total_amount: string;
    contact_id: string | null;
    conv_contact_id: string | null;
  }>(
    `SELECT o.id, o.status, o.total_amount, o.contact_id,
            (SELECT contact_id FROM core.conversations WHERE id = $2) AS conv_contact_id
     FROM commerce.orders o
     WHERE o.environment = $1 AND o.order_number = $3
     LIMIT 1`,
    [environment, conversationId, orderNumber],
  );

  const order = orderResult.rows[0];
  if (!order) {
    return JSON.stringify({ erro: `Pedido ${orderNumber} nao encontrado.` });
  }

  // Bot so cancela pedido do PROPRIO cliente
  if (order.contact_id && order.conv_contact_id && order.contact_id !== order.conv_contact_id) {
    return JSON.stringify({ erro: 'Esse pedido nao eh deste contato. Escalando pra humano.' });
  }

  if (order.status !== 'open') {
    return JSON.stringify({
      erro: `Pedido esta com status '${order.status}', nao pode ser cancelado automaticamente.`,
      sugestao: 'Encaminhe pra humano se cliente insistir.',
    });
  }

  // Reaproveita function ja existente do admin (commerce.cancel_manual_order)
  try {
    const reason = detalhes ? `${motivo}: ${detalhes}` : motivo;
    await client.query('SELECT commerce.cancel_manual_order($1, $2, $3)', [
      order.id,
      'agent_v2_bot',
      reason,
    ]);

    logger.info(
      { environment, conversation_id: conversationId, order_number: orderNumber, motivo, detalhes },
      'agent_v2: pedido cancelado via bot',
    );

    return JSON.stringify({
      ok: true,
      order_number: orderNumber,
      motivo,
      mensagem: `Pedido ${orderNumber} cancelado.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ environment, order_number: orderNumber, err: message }, 'agent_v2: erro ao cancelar pedido');
    return JSON.stringify({ erro: `Nao foi possivel cancelar: ${message}` });
  }
}

// ─── editar_pedido ─────────────────────────────────────────────────────────

interface ItemAdicionar {
  product_id: string;
  quantidade: number;
  preco_unitario: number;
}

async function editarPedido(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const orderNumber = (args.order_number as string)?.toUpperCase().trim();
  if (!orderNumber) {
    return JSON.stringify({ erro: 'order_number obrigatorio' });
  }

  const novoEndereco = args.novo_endereco as string | undefined;
  const novaFormaPagamento = args.nova_forma_pagamento as string | undefined;
  const removerItens = (args.remover_itens as string[] | undefined) ?? [];
  const adicionarItens = (args.adicionar_itens as ItemAdicionar[] | undefined) ?? [];
  const motivo = (args.motivo as string | undefined) ?? 'cliente_solicitou';

  if (!novoEndereco && !novaFormaPagamento && removerItens.length === 0 && adicionarItens.length === 0) {
    return JSON.stringify({ erro: 'Nenhuma mudanca informada. Passe ao menos um campo.' });
  }

  // Busca pedido + valida ownership
  const orderResult = await client.query<{
    id: string;
    status: string;
    contact_id: string | null;
    conv_contact_id: string | null;
    fulfillment_mode: string;
  }>(
    `SELECT o.id, o.status, o.contact_id, o.fulfillment_mode,
            (SELECT contact_id FROM core.conversations WHERE id = $2) AS conv_contact_id
     FROM commerce.orders o
     WHERE o.environment = $1 AND o.order_number = $3
     LIMIT 1`,
    [environment, conversationId, orderNumber],
  );

  const order = orderResult.rows[0];
  if (!order) return JSON.stringify({ erro: `Pedido ${orderNumber} nao encontrado.` });

  if (order.contact_id && order.conv_contact_id && order.contact_id !== order.conv_contact_id) {
    return JSON.stringify({ erro: 'Esse pedido nao eh deste contato. Escalando pra humano.' });
  }

  if (order.status !== 'open') {
    return JSON.stringify({
      erro: `Pedido com status '${order.status}' nao pode ser editado automaticamente.`,
      sugestao: 'Escalando pra humano.',
    });
  }

  // Tudo dentro de uma transacao
  try {
    await client.query('BEGIN');

    if (novoEndereco) {
      await client.query(
        `UPDATE commerce.orders SET delivery_address = $1, updated_at = now() WHERE id = $2`,
        [novoEndereco, order.id],
      );
    }

    if (novaFormaPagamento) {
      await client.query(
        `UPDATE commerce.orders SET payment_method = $1, updated_at = now() WHERE id = $2`,
        [novaFormaPagamento, order.id],
      );
    }

    if (removerItens.length > 0) {
      await client.query(
        `DELETE FROM commerce.order_items WHERE order_id = $1 AND product_id = ANY($2::uuid[])`,
        [order.id, removerItens],
      );
    }

    for (const item of adicionarItens) {
      await client.query(
        `INSERT INTO commerce.order_items (environment, order_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [environment, order.id, item.product_id, item.quantidade, item.preco_unitario.toFixed(2)],
      );
    }

    // Recalcula total: soma itens (NAO inclui frete pra evitar perder o valor original)
    // O frete ja esta embutido em total_amount; vamos manter a diferenca
    const totalsResult = await client.query<{ subtotal: string; total_amount: string }>(
      `SELECT
         COALESCE(SUM(oi.quantity * oi.unit_price), 0)::text AS subtotal,
         o.total_amount
       FROM commerce.orders o
       LEFT JOIN commerce.order_items oi ON oi.order_id = o.id
       WHERE o.id = $1
       GROUP BY o.total_amount`,
      [order.id],
    );

    const newSubtotal = parseFloat(totalsResult.rows[0]?.subtotal ?? '0');
    const oldTotal = parseFloat(totalsResult.rows[0]?.total_amount ?? '0');
    // Estima o frete antigo subtraindo (heuristica)
    const subtotalAntigoResult = await client.query<{ s: string }>(
      `SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0)::text AS s
       FROM commerce.order_items oi WHERE oi.order_id = $1`,
      [order.id],
    );
    // Recupera o frete original via diferenca historica nao da (ja recalculamos os itens)
    // Solucao: pegamos o frete via JOIN delivery_zones se houver geo_resolution_id, senao 0
    const freteResult = await client.query<{ frete: string }>(
      `SELECT COALESCE(dz.delivery_fee, 0)::text AS frete
       FROM commerce.orders o
       LEFT JOIN commerce.delivery_zones dz ON dz.geo_resolution_id = o.geo_resolution_id
       WHERE o.id = $1`,
      [order.id],
    );
    const freteAtual = parseFloat(freteResult.rows[0]?.frete ?? '0');
    const newTotal = newSubtotal + (order.fulfillment_mode === 'delivery' ? freteAtual : 0);

    await client.query(
      `UPDATE commerce.orders SET total_amount = $1, updated_at = now() WHERE id = $2`,
      [newTotal.toFixed(2), order.id],
    );

    await client.query('COMMIT');

    logger.info(
      {
        environment, conversation_id: conversationId, order_number: orderNumber,
        novoEndereco: !!novoEndereco, novaFormaPagamento, removidos: removerItens.length, adicionados: adicionarItens.length,
        motivo, novo_total: newTotal,
      },
      'agent_v2: pedido editado via bot',
    );

    return JSON.stringify({
      ok: true,
      order_number: orderNumber,
      novo_subtotal: newSubtotal.toFixed(2),
      valor_frete: freteAtual.toFixed(2),
      novo_total: newTotal.toFixed(2),
      mensagem: `Pedido ${orderNumber} atualizado.`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ environment, order_number: orderNumber, err: message }, 'agent_v2: erro ao editar pedido');
    return JSON.stringify({ erro: `Nao foi possivel editar: ${message}` });
  }
}
