import type { PoolClient } from 'pg';
import {
  buscarProduto,
  buscarCompatibilidade,
  calcularFrete,
  verificarEstoque,
  buscarPoliticaComercial,
} from '../atendente/tools/commerce-tools.js';
import { logger } from '../shared/logger.js';
import { normalizeBrazilianPhone } from '../shared/phone.js';
import type { ToolDefinition } from './types.js';
import type { Environment } from '../shared/types/chatwoot.js';
import {
  resolveMatrizUnitId,
  resolveMunicipioFromGeo,
  resolveMunicipioFromBairro,
  decideStoreForItems,
  decideStoreForItemsGeo,
  getPartnerStockMap,
  resolveProductAvailabilityByProximity,
  materializePartnerOrder,
  getUnitMapsUrl,
  getUnitDisplayById,
  normalizeRegion,
  FRETE_PADRAO_BRL,
  matrizFreightForKm,
  matrizDistanceKm,
  type PartnerOrderRouting,
} from './fulfillment.js';
import { env } from '../shared/config/env.js';
import { getLatestCustomerLocation, resolveCustomerLocation } from './customer-location.js';
import { getRecentProductIds } from './conversation-products.js';
import { cachedReverseGeocode } from '../shared/geo/geo-cache.js';
import { buildOrderIdempotencyKey } from './order-idempotency.js';
import { createPhotoRequest, linkPhotoRequestsToOrder } from './photo-requests.js';
import { lookupChatwootConversationId } from './history.js';

// ─── Camada GEO: resolução de loja por proximidade (compartilhada) ───────────
// FONTE ÚNICA da decisão de loja pros dois caminhos (calcular_frete e criar_pedido),
// pra a cotação e o registro nunca divergirem (invariante §5.7). Com ROUTING_GEO on
// e coordenada do cliente → motor de proximidade (anel); senão → caminho de hoje
// (por cidade). A coordenada vem em camadas (resolveCustomerLocation, customer-location.ts):
// pino → endereço completo (rua+número via Google) → bairro; sem nenhuma → cidade (caso F).

/**
 * Pino-first (decisão Wallace 2026-06-09): quando o caminho do BAIRRO DIGITADO não
 * resolveu a CIDADE (`municipio == null`) e há um pino na conversa, reverse-geocoda o
 * pino → cidade (e bairro, se o cliente não digitou). É ADITIVO e NÃO toca a busca por
 * bairro escrito: se a cidade já veio do bairro, devolve a entrada intacta (early
 * return) — o bairro SEMPRE vence e nem chega aqui. Degrada elegante: ROUTING_GEO off /
 * sem chave / sem pino / Google falhou → devolve o que entrou (o bot volta a pedir o
 * bairro, como hoje). O bairro digitado, quando há, mantém prioridade no canônico.
 */
async function fillCityFromPin(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  current: { municipio: string | null; neighborhoodCanonical: string | null },
): Promise<{ municipio: string | null; neighborhoodCanonical: string | null }> {
  if (current.municipio) return current;
  if (!env.ROUTING_GEO || !env.GOOGLE_MAPS_API_KEY) return current;
  const pin = await getLatestCustomerLocation(client, environment, conversationId);
  if (!pin) return current;
  const rev = await cachedReverseGeocode(client, pin, env.GOOGLE_MAPS_API_KEY);
  if (!rev?.municipio) return current;
  return {
    municipio: rev.municipio,
    neighborhoodCanonical:
      current.neighborhoodCanonical ?? (rev.neighborhood ? normalizeRegion(rev.neighborhood) : null),
  };
}

interface GeoOnlyFar {
  unitName: string;
  distanceKm: number;
}

/**
 * Decide a loja (entrega) por proximidade quando ROUTING_GEO está on e há coordenada;
 * senão cai no caminho de hoje (decideStoreForItems por cidade). Retorna o routing
 * (loja escolhida ou null=matriz) e, no caso E (só tem longe), o onlyFar pra o bot
 * dar a resposta honesta (D3). Os DOIS tools chamam isto com as MESMAS entradas.
 */
async function decideStoreGeoOrFallback(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  input: {
    municipio: string | null;
    items: { product_id: string; quantity: number }[];
    bairro: string | null | undefined;
    /** Endereço completo (rua+número) digitado pelo cliente na ENTREGA — geocodifica fino. */
    fullAddress?: string | null;
  },
): Promise<{
  routing: PartnerOrderRouting | null;
  onlyFar?: GeoOnlyFar;
  // Frete da MATRIZ por distância (só preenchido quando a entrega cai na matriz).
  // Garantido por CÓDIGO (não confiar no valor_frete que o LLM passa).
  matrizFreight?: number;
  matrizDistanceKm?: number | null;
}> {
  if (env.ROUTING_GEO && input.municipio) {
    const customerLocation = await resolveCustomerLocation(client, environment, conversationId, {
      municipio: input.municipio,
      bairro: input.bairro,
      fullAddress: input.fullAddress,
      apiKey: env.GOOGLE_MAPS_API_KEY,
    });
    if (customerLocation) {
      const geo = await decideStoreForItemsGeo(client, environment, {
        municipio: input.municipio,
        items: input.items,
        modalidade: 'delivery', // calcular_frete e o roteamento de pedido do bot são entrega
        customerLocation,
        clientNeighborhoodCanonical: input.bairro ? normalizeRegion(input.bairro) : null,
      });
      if (geo.kind === 'partner') return { routing: geo.routing };
      if (geo.kind === 'only_far') return { routing: null, onlyFar: { unitName: geo.unitName, distanceKm: geo.distanceKm } };
      // matriz: mede cliente→Matriz e cobra o frete por DISTÂNCIA (decisão 06-19).
      const km = await matrizDistanceKm(client, customerLocation);
      return { routing: null, matrizFreight: matrizFreightForKm(km), matrizDistanceKm: km };
    }
    // sem coordenada → cai no fallback por cidade (caso F)
  }
  const routing = await decideStoreForItems(client, environment, { municipio: input.municipio, items: input.items });
  // matriz sem coordenada (caso F): não dá pra medir distância → frete base da rede.
  return routing ? { routing } : { routing: null, matrizFreight: matrizFreightForKm(null), matrizDistanceKm: null };
}

// ─── OpenAI tool schemas ───────────────────────────────────────────────────

/**
 * Definições ATIVAS pro LLM: a tool pedir_foto só aparece com PHOTO_REQUESTS on
 * (flag off = o bot nem sabe que foto existe; o prompt também é condicional).
 */
export function activeToolDefinitions(): ToolDefinition[] {
  if (env.PHOTO_REQUESTS) return TOOL_DEFINITIONS;
  return TOOL_DEFINITIONS.filter((t) => t.function.name !== 'pedir_foto');
}

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
          bairro: { type: 'string', description: 'Bairro do cliente, se já informado — pra mostrar o estoque da loja que vai atender.' },
          municipio: { type: 'string', description: 'Cidade (opcional, ajuda a localizar o bairro).' },
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
          bairro: { type: 'string', description: 'Bairro do cliente, se já informado — pra mostrar o estoque da loja que vai atender.' },
          municipio: { type: 'string', description: 'Cidade (opcional, ajuda a localizar o bairro).' },
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
          produtos: {
            type: 'array',
            description: 'Os pneus já escolhidos pelo cliente (dos resultados de busca). Inclua o product_id de cada um — necessário para cotar o frete da loja certa.',
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'string', description: 'UUID do produto' },
                quantidade: { type: 'number', description: 'Quantidade (padrão 1)' },
              },
              required: ['product_id'],
              additionalProperties: false,
            },
          },
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
      name: 'localizacao_loja',
      description: 'Retorna nome, endereço escrito, horário e link do Google Maps da loja que atende o cliente. Use quando o cliente perguntar onde fica / como chegar / o endereço, ou quando escolher RETIRADA. SEMPRE passe o bairro do cliente — é o que acha a loja MAIS PERTO dele. Se o cliente já escolheu um pneu, SEMPRE passe product_ids (os product_id vindos de buscar_produto/buscar_compatibilidade) — assim a loja indicada é a que REALMENTE TEM o produto, não só a mais perto. encontrado:false motivo sem_localizacao_pergunte_bairro → PERGUNTE o bairro. encontrado:false motivo sem_loja_com_estoque_perto → a loja mais perto NÃO tem esse pneu: seja honesto e ofereça alternativa (entrega de uma loja que tem / medida equivalente / avisar quando chegar), NÃO indique loja. NUNCA invente um link — só mande o maps_url retornado aqui.',
      parameters: {
        type: 'object',
        properties: {
          bairro: { type: 'string', description: 'Bairro do cliente, se informado (ajuda a achar a loja que atende).' },
          municipio: { type: 'string', description: 'Cidade do cliente, se informada.' },
          product_ids: { type: 'array', items: { type: 'string' }, description: 'product_id dos pneus que o cliente quer (de buscar_produto/buscar_compatibilidade). Passe SEMPRE que houver pneu escolhido — a loja indicada passa a ser a que TEM o item em estoque.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pedir_foto',
      description:
        'Pede pra LOJA tirar uma foto AO VIVO do pneu USADO em estoque e mandar pro cliente. Use SÓ quando o cliente PEDIR pra ver foto/estado/conservação do pneu — NUNCA ofereça foto por conta própria. Exige pneu já buscado (product_id de buscar_produto/buscar_compatibilidade) e localização do cliente (bairro ou pino) pra achar a loja certa. Retorno foto_solicitada → avise "vou pedir pra loja te mandar a foto, 1 minutinho 📸" e SIGA a conversa normalmente (a foto chega sozinha depois, você não precisa esperar nem confirmar). Retorno precisa_produto → pergunte qual pneu. Retorno sem_loja → peça o bairro/localização (sem isso não dá pra achar a loja que tem o pneu). Retorno limite_fotos → já tem foto a caminho, avise que chega já.',
      parameters: {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
            description: 'UUID do pneu que o cliente quer ver (de buscar_produto/buscar_compatibilidade). Se omitir, uso o último pneu buscado na conversa.',
          },
          bairro: { type: 'string', description: 'Bairro do cliente, se informado — acha a loja que TEM o pneu.' },
          municipio: { type: 'string', description: 'Cidade (opcional).' },
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
          bairro: { type: 'string', description: 'Bairro do cliente. Na ENTREGA, passe o MESMO usado no calcular_frete. Na RETIRADA, passe o bairro que o cliente informou — é o que permite achar a loja mais perto pra ele retirar.' },
          confirma_retirada_distante: { type: 'boolean', description: 'Use SOMENTE na RETIRADA e SOMENTE depois que o cliente, avisado de que a loja mais perto que tem o pneu fica longe, disser EXPLICITAMENTE que vai buscar mesmo assim ("não tem problema, eu passo aí", "eu vou aí pegar"). true = reserva o pneu na loja mais perto que tem, mesmo fora do raio normal de retirada. NUNCA marque sozinho: só com a confirmação do cliente.' },
          telefone_cliente: { type: 'string', description: 'Telefone/WhatsApp do cliente (com DDD). Passe SÓ quando o contato não tem número — Instagram e Facebook não trazem telefone. Sem ele, o pedido é recusado (entrega E retirada — todo pedido precisa de número). Em conversa de WhatsApp, OMITA: o número já vem do contato.' },
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
        // C2: estoque da loja que VAI ATENDER, por PROXIMIDADE. SEM bairro/localização não
        // há loja resolvida → marca precisa_localizacao (furo #4): o bot pede o bairro antes
        // de prometer estoque, em vez de cravar "tenho" sem saber a loja perto do cliente.
        let lojaResolvidaCompat = false;
        let estoqueLojaPertoCompat = false; // ≥1 produto com estoque de loja perto/parceira (não central)
        {
          const bairro = args.bairro as string | undefined;
          let municipio = bairro
            ? await resolveMunicipioFromBairro(client, environment, bairro, args.municipio as string | undefined)
            : ((args.municipio as string | undefined) ?? null);
          let clientNeighborhoodCanonical = bairro ? normalizeRegion(bairro) : null;
          // Pino-first: SÓ pino (sem bairro) → reverse-geocode preenche a cidade. Aditivo
          // (no-op quando o bairro já resolveu a cidade — ele sempre vence).
          ({ municipio, neighborhoodCanonical: clientNeighborhoodCanonical } = await fillCityFromPin(
            client, environment, conversationId, { municipio, neighborhoodCanonical: clientNeighborhoodCanonical },
          ));
          const customerLocation =
            env.ROUTING_GEO && municipio
              ? await resolveCustomerLocation(client, environment, conversationId, {
                  municipio,
                  bairro,
                  apiKey: env.GOOGLE_MAPS_API_KEY,
                })
              : null;
          if (customerLocation && municipio) {
            const productIds = result.flatMap((v) => v.produtos.map((p) => p.product_id));
            const avail = await resolveProductAvailabilityByProximity(client, environment, {
              municipio,
              customerLocation,
              clientNeighborhoodCanonical,
              productIds,
            });
            for (const v of result) {
              for (const p of v.produtos) {
                const a = avail.get(p.product_id);
                if (a) { p.total_stock = a.available; estoqueLojaPertoCompat = true; }
              }
            }
            lojaResolvidaCompat = true;
          } else if (bairro && municipio) {
            // fallback por CIDADE (ROUTING_GEO off ou sem coordenada) — comportamento de hoje.
            const partnerStock = await getPartnerStockMap(client, environment, municipio);
            if (partnerStock.size > 0) {
              for (const v of result) {
                for (const p of v.produtos) {
                  const q = partnerStock.get(p.product_id);
                  if (q != null) { p.total_stock = q; estoqueLojaPertoCompat = true; }
                }
              }
            }
            lojaResolvidaCompat = true;
          }
        }
        // sem_estoque_loja_perto: sei a localização, mas NENHUMA loja perto tem o item — o
        // total_stock mostrado é o da REDE/matriz (backstop), não de uma loja perto confirmada.
        // O bot NÃO pode cravar "tenho na tua loja" nesse caso (furo: confirmava estoque local
        // baseado no estoque central). A retirada se resolve depois no localizacao_loja.
        return JSON.stringify({
          encontrado: true,
          veiculos: result,
          ...(lojaResolvidaCompat ? {} : { precisa_localizacao: true }),
          ...(lojaResolvidaCompat && !estoqueLojaPertoCompat ? { sem_estoque_loja_perto: true } : {}),
        });
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
        // C2: a busca mostra o estoque da loja que VAI ATENDER, por PROXIMIDADE. SEM
        // bairro/localização não há loja resolvida → o estoque é o da matriz (genérico) e
        // marcamos precisa_localizacao (furo #4): o bot pede o bairro antes de prometer
        // estoque, em vez de cravar "tenho" sem saber a loja perto do cliente.
        let lojaResolvida = false;
        let estoqueLojaPerto = false; // ≥1 produto com estoque de loja perto/parceira (não central)
        {
          const bairro = args.bairro as string | undefined;
          let municipio = bairro
            ? await resolveMunicipioFromBairro(client, environment, bairro, args.municipio as string | undefined)
            : ((args.municipio as string | undefined) ?? null);
          let clientNeighborhoodCanonical = bairro ? normalizeRegion(bairro) : null;
          // Pino-first: SÓ pino (sem bairro) → reverse-geocode preenche a cidade. Aditivo
          // (no-op quando o bairro já resolveu a cidade — ele sempre vence).
          ({ municipio, neighborhoodCanonical: clientNeighborhoodCanonical } = await fillCityFromPin(
            client, environment, conversationId, { municipio, neighborhoodCanonical: clientNeighborhoodCanonical },
          ));
          const customerLocation =
            env.ROUTING_GEO && municipio
              ? await resolveCustomerLocation(client, environment, conversationId, {
                  municipio,
                  bairro,
                  apiKey: env.GOOGLE_MAPS_API_KEY,
                })
              : null;
          if (customerLocation && municipio) {
            const avail = await resolveProductAvailabilityByProximity(client, environment, {
              municipio,
              customerLocation,
              clientNeighborhoodCanonical,
              productIds: result.map((p) => p.product_id),
            });
            for (const p of result) {
              const a = avail.get(p.product_id);
              if (a) { p.total_stock_available = a.available; estoqueLojaPerto = true; }
            }
            lojaResolvida = true;
          } else if (bairro && municipio) {
            // fallback por CIDADE (ROUTING_GEO off ou sem coordenada) — comportamento de hoje.
            const partnerStock = await getPartnerStockMap(client, environment, municipio);
            if (partnerStock.size > 0) {
              for (const p of result) {
                const q = partnerStock.get(p.product_id);
                if (q != null) { p.total_stock_available = q; estoqueLojaPerto = true; }
              }
            }
            lojaResolvida = true;
          }
        }
        // sem_estoque_loja_perto: ver buscar_compatibilidade — sei a localização, mas nenhuma
        // loja perto tem o item; o estoque exibido é o da REDE/matriz, não de loja perto.
        return JSON.stringify({
          encontrado: true,
          produtos: result,
          ...(lojaResolvida ? {} : { precisa_localizacao: true }),
          ...(lojaResolvida && !estoqueLojaPerto ? { sem_estoque_loja_perto: true } : {}),
        });
      }

      case 'calcular_frete': {
        const result = await calcularFrete(client, {
          environment,
          bairro: args.bairro as string,
          municipio: args.municipio as string | undefined,
        });
        // C3b: se a entrega cai num parceiro (MESMA decisão do criar_pedido), o frete é
        // o fixo do parceiro (FRETE_PADRAO_BRL), não o da matriz — pra a cotação bater
        // com o que o pedido vai cobrar. Com ROUTING_GEO, a decisão é por PROXIMIDADE
        // (anel) e pode devolver "só tem longe" (caso E) → o bot responde com honestidade
        // (D3). decideStoreGeoOrFallback é a fonte única (mesma decisão do criar_pedido).
        let produtos = (args.produtos as { product_id: string; quantidade?: number }[] | undefined) ?? [];
        // Memória do produto (furo raiz): se o LLM não passou os produtos, usa o que o
        // bot já buscou na conversa — pra a cotação rotear pelo MESMO produto do pedido.
        if (produtos.length === 0) {
          const ids = await getRecentProductIds(client, conversationId);
          produtos = ids.map((id) => ({ product_id: id, quantidade: 1 }));
        }
        if (result.encontrado && result.geo_resolution_id && produtos.length > 0) {
          let municipio = await resolveMunicipioFromGeo(client, environment, result.geo_resolution_id);
          // Pino-first: geo órfão e sem cidade → reverse-geocode do pino preenche. Aditivo.
          ({ municipio } = await fillCityFromPin(client, environment, conversationId, { municipio, neighborhoodCanonical: null }));
          const decision = await decideStoreGeoOrFallback(client, environment, conversationId, {
            municipio,
            items: produtos.map((p) => ({ product_id: p.product_id, quantity: p.quantidade ?? 1 })),
            bairro: args.bairro as string | undefined,
          });
          if (decision.routing) {
            return JSON.stringify({
              ...result,
              disponivel: true,
              valor: FRETE_PADRAO_BRL.toFixed(2),
              motivo: undefined,
            });
          }
          if (decision.onlyFar) {
            return JSON.stringify({
              ...result,
              disponivel: false,
              apenas_longe: true,
              distancia_km: Math.round(decision.onlyFar.distanceKm),
              nome_loja_distante: decision.onlyFar.unitName,
              orientacao:
                'Esse pneu só tem numa loja mais distante. Seja honesto: avise a distância e ofereça opções (entregar mesmo assim / medida equivalente mais perto / reservar e avisar). NÃO finja que é entrega normal.',
            });
          }
          // Matriz (nem parceiro nem só-longe): se a entrega está disponível, o frete da
          // Matriz é por DISTÂNCIA (decisão Wallace 06-19), garantido por CÓDIGO — não o
          // fee fixo da zona. O criar_pedido cobra o MESMO valor (mesma fonte: o wrapper).
          if (decision.matrizFreight != null && result.disponivel) {
            return JSON.stringify({ ...result, valor: decision.matrizFreight.toFixed(2), motivo: undefined });
          }
        }
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

      case 'localizacao_loja': {
        const bairro = args.bairro as string | undefined;
        let municipio = (args.municipio as string | undefined) ?? null;
        if (!municipio && bairro) {
          municipio = await resolveMunicipioFromBairro(client, environment, bairro, null);
        }
        let clientNeighborhoodCanonical = bairro ? normalizeRegion(bairro) : null;
        // Pino-first: só pino (sem bairro) → reverse-geocode preenche a cidade. Aditivo
        // (no-op quando o bairro já resolveu a cidade — ele sempre vence).
        ({ municipio, neighborhoodCanonical: clientNeighborhoodCanonical } = await fillCityFromPin(
          client, environment, conversationId, { municipio, neighborhoodCanonical: clientNeighborhoodCanonical },
        ));
        let productIds = Array.isArray(args.product_ids)
          ? (args.product_ids as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        // Memória do produto (furo raiz): se o LLM não passou product_ids, usa o pneu que o
        // bot já buscou na conversa → a loja indicada passa a ser a MESMA do pedido (régua +
        // estoque + anel de retirada), em vez de cair no getUnitMapsUrl sem régua.
        if (productIds.length === 0) {
          productIds = await getRecentProductIds(client, conversationId);
        }
        // Coordenada do cliente (pino → geocode do bairro), MESMA fonte do criar_pedido,
        // pra escolher a loja MAIS PERTO entre as que cobrem o município (não a mais antiga).
        const customerLocation = await resolveCustomerLocation(client, environment, conversationId, {
          municipio,
          bairro,
          apiKey: env.GOOGLE_MAPS_API_KEY,
        });

        // RETIRADA com pneu escolhido: usa a MESMA decisão do pedido de retirada
        // (decideStoreForItemsGeo pickup) — respeita estoque, deleted_at, anel de retirada
        // de 15 km E a régua de justiça. Assim a loja indicada = a loja que o pedido vai
        // reservar (nunca diverge). Fora do raio → apenas_longe (bot honesto, oferece entrega).
        if (productIds.length > 0 && customerLocation && env.ROUTING_GEO && municipio) {
          const geo = await decideStoreForItemsGeo(client, environment, {
            municipio,
            items: productIds.map((id) => ({ product_id: id, quantity: 1 })),
            modalidade: 'pickup',
            customerLocation,
            clientNeighborhoodCanonical,
          });
          if (geo.kind === 'partner') {
            const disp = await getUnitDisplayById(client, environment, geo.routing.unitId);
            if (disp) {
              // Opção 1 (decisão Wallace 2026-06-14): ANTES de fechar, o bot recebe só
              // qual loja + a que distância — SEM endereço/maps_url. Trava por CÓDIGO (§3):
              // o cliente não força o bot a entregar o endereço pra ir direto sem reservar.
              // O cartão da loja (endereço+mapa+horário) volta no criar_pedido e entra no resumo.
              return JSON.stringify({ encontrado: true, nome_loja: disp.nome_loja, distancia_km: Math.round(geo.distanceKm), horario: disp.opening_hours, taxa_instalacao: disp.installation_fee });
            }
          } else if (geo.kind === 'only_far') {
            // Tem o pneu, mas a loja mais perto que tem fica fora do raio de retirada.
            // sem distancia_km de proposito: o "longe" é gatilho negativo (decisão Wallace) —
            // o bot nomeia a loja e oferece a entrega como solução positiva. Mas devolve TAMBÉM
            // o cartão da loja (endereço/mapa): se o cliente bancar ir buscar (consentimento), o
            // bot já tem o que passar e fecha com criar_pedido(confirma_retirada_distante=true).
            const disp = await getUnitDisplayById(client, environment, geo.unitId);
            // Opção 1: sem endereço/maps aqui também. Se o cliente bancar ir buscar longe,
            // o endereço sai no resumo do criar_pedido(confirma_retirada_distante=true).
            return JSON.stringify({
              encontrado: false,
              motivo: 'retirada_so_longe',
              nome_loja_distante: geo.unitName,
              nome_loja: disp?.nome_loja ?? geo.unitName,
              horario: disp?.opening_hours ?? null,
              taxa_instalacao: disp?.installation_fee ?? null,
            });
          } else {
            // matriz: nenhum parceiro perto tem o pneu pra retirar.
            return JSON.stringify({ encontrado: false, motivo: 'sem_loja_com_estoque_perto' });
          }
        }

        const loc = await getUnitMapsUrl(client, environment, { bairro, municipio, customerLocation, productIds });
        if (!loc) {
          // Com produto + coordenada: null = nenhuma loja PERTO tem o item em estoque (ativo).
          // Seja honesto, NÃO chute a loja mais perto sem estoque (caso Madureira apagada).
          if (productIds.length > 0 && customerLocation) {
            return JSON.stringify({ encontrado: false, motivo: 'sem_loja_com_estoque_perto' });
          }
          // Senão (várias lojas + bairro desconhecido) → o bot PERGUNTA o bairro antes de indicar.
          return JSON.stringify({ encontrado: false, motivo: 'sem_localizacao_pergunte_bairro' });
        }
        // Opção 1: só nome + horário (sem endereço/maps antes de fechar).
        return JSON.stringify({
          encontrado: true,
          nome_loja: loc.nome_loja,
          horario: loc.opening_hours,
        });
      }

      case 'pedir_foto': {
        // FOTO SOB DEMANDA (0094). Guards por CÓDIGO (E18): a tool resolve a
        // loja pela MESMA régua do pedido (decideStoreForItemsGeo pickup, igual
        // localizacao_loja) e o createPhotoRequest trava dedup + máx 2 ativos.
        if (!env.PHOTO_REQUESTS) {
          return JSON.stringify({ status: 'indisponivel' });
        }

        // Produto: o que o LLM passou, senão o último pneu buscado na conversa.
        let productId = typeof args.product_id === 'string' ? args.product_id : null;
        if (!productId) {
          const ids = await getRecentProductIds(client, conversationId);
          productId = ids[0] ?? null;
        }
        if (!productId) {
          return JSON.stringify({ status: 'precisa_produto' });
        }

        // Localização: mesma cadeia do localizacao_loja (bairro → cidade; pino preenche).
        const bairro = args.bairro as string | undefined;
        let municipio = (args.municipio as string | undefined) ?? null;
        if (!municipio && bairro) {
          municipio = await resolveMunicipioFromBairro(client, environment, bairro, null);
        }
        let clientNeighborhoodCanonical = bairro ? normalizeRegion(bairro) : null;
        ({ municipio, neighborhoodCanonical: clientNeighborhoodCanonical } = await fillCityFromPin(
          client, environment, conversationId, { municipio, neighborhoodCanonical: clientNeighborhoodCanonical },
        ));
        const customerLocation = await resolveCustomerLocation(client, environment, conversationId, {
          municipio,
          bairro,
          apiKey: env.GOOGLE_MAPS_API_KEY,
        });
        if (!env.ROUTING_GEO || !municipio || !customerLocation) {
          return JSON.stringify({ status: 'sem_loja' });
        }

        // A loja que fotografa = a loja que TEM o pneu e atenderia o cliente
        // (anel pickup + estoque + régua — fonte única; nunca diverge da indicada).
        const geo = await decideStoreForItemsGeo(client, environment, {
          municipio,
          items: [{ product_id: productId, quantity: 1 }],
          modalidade: 'pickup',
          customerLocation,
          clientNeighborhoodCanonical,
        });
        // partner = atende perto; only_far = TEM o pneu (longe, mas a foto ajuda
        // a fechar por entrega). matriz = ninguém da rede tem → sem foto.
        const unitId = geo.kind === 'partner' ? geo.routing.unitId : geo.kind === 'only_far' ? geo.unitId : null;
        if (!unitId) {
          return JSON.stringify({ status: 'sem_loja' });
        }

        // Rótulo do card (medida em destaque) — snapshot do produto.
        const prod = await client.query<{ product_name: string; brand: string | null }>(
          'SELECT product_name, brand FROM commerce.products WHERE id = $1 LIMIT 1',
          [productId],
        );
        const nomePneu = prod.rows[0]?.product_name ?? 'pneu';
        const marca = prod.rows[0]?.brand ?? null;

        // Endereço de volta = id da conversa NO CHATWOOT (o dispatcher só lê daqui).
        const chatwootConvId = await lookupChatwootConversationId(client, conversationId);
        if (!chatwootConvId) {
          logger.warn({ conversationId }, 'pedir_foto: conversa sem chatwoot_conversation_id');
          return JSON.stringify({ status: 'sem_loja' });
        }

        // Nome do cliente pro card de Avisos (decisão do dono 2026-06-15): SÓ o
        // nome, pra diferenciar as pessoas. Sem telefone/contato (só o nome não
        // permite contatar fora da Rede). Best-effort: sem nome = card sem rótulo.
        const nameRow = await client.query<{ name: string | null }>(
          `SELECT ct.name
             FROM core.conversations cv
             JOIN core.contacts ct ON ct.id = cv.contact_id
            WHERE cv.chatwoot_conversation_id = $1
            LIMIT 1`,
          [chatwootConvId],
        );
        const customerLabel = nameRow.rows[0]?.name?.trim().slice(0, 80) || null;

        const created = await createPhotoRequest(client, environment, {
          unitId,
          chatwootConversationId: chatwootConvId,
          tireSize: nomePneu,
          brand: marca,
          customerLabel,
        });
        if (created.status === 'limit') {
          return JSON.stringify({
            status: 'limite_fotos',
            mensagem: 'Já tem pedido de foto em andamento pra essa conversa — assim que chegar eu mando.',
          });
        }
        return JSON.stringify({
          status: 'foto_solicitada',
          prazo_min: created.prazoMin,
          nome_pneu: nomePneu,
          ja_pedida: created.status === 'dedup',
        });
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

/**
 * Grava o ESPELHO em commerce.orders + order_items e devolve {id, order_number}.
 * Extraído do criar_pedido (Tijolo 3.2) pra os DOIS caminhos — matriz e parceiro —
 * usarem a MESMA peça, sem duplicar o INSERT. Comportamento idêntico ao de antes;
 * o caminho parceiro vai passar unit_id da loja (e, após a migration 0081, o link).
 */
async function insertCommerceOrderMirror(
  client: PoolClient,
  environment: Environment,
  input: {
    contactId: string;
    conversationId: string;
    totalAmount: string;
    fulfillmentMode: string;
    paymentMethod: string | null;
    deliveryAddress: string | null;
    geoResolutionId: string | null;
    customerName: string | null;
    unitId: string | null;
    partnerOrderId?: string | null;
    idempotencyKey?: string | null;
    items: { product_id: string; quantity: number; unit_price: string }[];
  },
): Promise<{ id: string; order_number: string }> {
  // idempotency_key dedup via índice parcial orders_idempotency_key_uniq — os DOIS
  // caminhos (parceiro e matriz) passam chave estável; em colisão o ON CONFLICT DO
  // NOTHING devolve o existente abaixo. Chave NULA (defensivo) nunca conflita → INSERT normal.
  const ins = await client.query<{ id: string; order_number: string }>(
    `INSERT INTO commerce.orders (
       environment, contact_id, source_conversation_id, total_amount, status,
       fulfillment_mode, payment_method, delivery_address, geo_resolution_id, source, customer_name, unit_id,
       partner_order_id, idempotency_key
     ) VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, 'chatwoot_com_bot', $9, $10, $11, $12)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id, order_number`,
    [
      environment,
      input.contactId,
      input.conversationId,
      input.totalAmount,
      input.fulfillmentMode,
      input.paymentMethod,
      input.deliveryAddress,
      input.geoResolutionId,
      input.customerName,
      input.unitId,
      input.partnerOrderId ?? null,
      input.idempotencyKey ?? null,
    ],
  );

  if (ins.rows[0]) {
    const order = ins.rows[0];
    for (const item of input.items) {
      await client.query(
        `INSERT INTO commerce.order_items (environment, order_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [environment, order.id, item.product_id, item.quantity, item.unit_price],
      );
    }
    return order;
  }

  // Sem linha = colisão de idempotência (retry/dupla-chamada do MESMO pedido): devolve o
  // existente sem reinserir itens. Vale pros dois caminhos (parceiro e matriz têm chave).
  if (input.idempotencyKey) {
    const ex = await client.query<{ id: string; order_number: string }>(
      `SELECT id, order_number FROM commerce.orders
       WHERE environment = $1 AND idempotency_key = $2 LIMIT 1`,
      [environment, input.idempotencyKey],
    );
    if (ex.rows[0]) return ex.rows[0];
  }
  throw new Error('Falha ao criar pedido');
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
  // let: o frete da MATRIZ por distância é reescrito por CÓDIGO no roteamento abaixo
  // (não confiar no valor_frete do LLM). Parceiro/retirada não tocam aqui.
  let valorFrete = Number(args.valor_frete ?? 0) || 0;
  // Consentimento de retirada longe (decisão Wallace 2026-06-08): o bot só marca true
  // depois que o cliente confirma que vai buscar mesmo a loja ficando longe.
  const confirmaRetiradaDistante = args.confirma_retirada_distante === true;

  // Guard: delivery sem frete é provavelmente o LLM esquecendo o campo.
  // Retorna erro estruturado pra ele rechamar com valor_frete.
  if (modalidade === 'delivery' && valorFrete <= 0) {
    return JSON.stringify({
      erro: 'valor_frete obrigatório quando modalidade=delivery. Reuse o valor do calcular_frete que você já chamou.',
    });
  }

  let totalAmount = subtotal + valorFrete;

  // Busca contact_id + telefone (phone_e164) direto da conversa/contato.
  const convResult = await client.query<{ contact_id: string | null; phone_e164: string | null }>(
    `SELECT cv.contact_id, ct.phone_e164
       FROM core.conversations cv
       LEFT JOIN core.contacts ct ON ct.id = cv.contact_id
      WHERE cv.id = $1 LIMIT 1`,
    [conversationId],
  );
  const contactId = convResult.rows[0]?.contact_id ?? null;
  // Número do WhatsApp do cliente → grava no pedido pra habilitar Ligar/WhatsApp
  // no card do parceiro. Antes ia null (o botão nascia morto).
  const contactPhone = convResult.rows[0]?.phone_e164 ?? null;

  if (!contactId) {
    return JSON.stringify({ erro: 'Contato não encontrado para esta conversa.' });
  }

  // Telefone efetivo do pedido: o que o BOT coletou (contato sem número — Insta/FB)
  // tem prioridade; senão usa o do contato (WhatsApp). Reusa o normalizador E164
  // compartilhado e testado (normalizeBrazilianPhone).
  const telefoneInformado =
    typeof args.telefone_cliente === 'string' ? normalizeBrazilianPhone(args.telefone_cliente) : null;
  const effectivePhone = telefoneInformado ?? contactPhone;

  // Guard: TODO pedido precisa de telefone — entrega (entregador alcança o cliente)
  // e retirada (loja avisa "seu pneu chegou"). Contato de Instagram/Facebook não traz
  // número (phone_e164 null); nesse caso o bot PEDE o WhatsApp e rechama com
  // telefone_cliente. Garantido por código (decisão Wallace 2026-06-10), não por prompt.
  if (!effectivePhone) {
    return JSON.stringify({
      erro: 'telefone_obrigatorio',
      telefone_obrigatorio: true,
      mensagem:
        'Este contato não tem telefone (provavelmente Instagram/Facebook). Peça o WhatsApp/telefone do cliente e rechame criar_pedido com telefone_cliente — todo pedido precisa do número (entrega ou retirada).',
    });
  }

  // Dados comuns aos dois caminhos.
  const customerName = (args.nome_cliente as string | undefined)?.slice(0, 200) ?? null;
  const deliveryAddress =
    modalidade === 'delivery' ? ((args.endereco_entrega as string | undefined) ?? null) : null;
  const geoResolutionId = (args.geo_resolution_id as string | undefined) ?? null;
  const formaPagamento = (args.forma_pagamento as string | undefined) ?? null;

  // ── ROTEAMENTO (Tijolo 3.2): decidir matriz vs parceiro ───────────────────
  // ENTREGA com região conhecida → parceiro (H5: todos os itens no MESMO parceiro com
  // estoque rastreado/disponível; senão matriz). RETIRADA: por padrão vai pra matriz,
  // mas com PICKUP_TO_PARTNER on + proximidade (ROUTING_GEO + coordenada) vai pro
  // parceiro mais perto RESERVANDO o pneu (decisão Wallace 2026-06-07).
  let partner: PartnerOrderRouting | null = null;

  if (modalidade === 'delivery') {
    // Município do geo (se cotou frete) OU do bairro. Sem este OR, entrega SEM
    // geo_resolution_id caía 100% na matriz mesmo havendo parceiro com estoque na cidade
    // (furo #3 da auditoria) → parceiro perdia a venda e a régua não contava o lead.
    let municipio = geoResolutionId
      ? await resolveMunicipioFromGeo(client, environment, geoResolutionId)
      : await resolveMunicipioFromBairro(client, environment, (args.bairro as string | undefined) ?? '', null);
    // Pino-first: sem geo e sem bairro → reverse-geocode do pino preenche a cidade. Aditivo.
    ({ municipio } = await fillCityFromPin(client, environment, conversationId, { municipio, neighborhoodCanonical: null }));
    const decision = await decideStoreGeoOrFallback(client, environment, conversationId, {
      municipio,
      items: itens.map((i) => ({ product_id: i.product_id, quantity: i.quantidade })),
      bairro: args.bairro as string | undefined,
      // Endereço digitado (rua+número) → geocodificação fina da casa; bairro é paraquedas.
      fullAddress: deliveryAddress,
    });
    // Caso E (só tem longe): NÃO cria o pedido caladamente — devolve estruturado pro bot
    // confirmar a opção com o cliente antes (D3). Salvaguarda: o bot só deve chamar
    // criar_pedido depois que o cliente escolher.
    if (decision.onlyFar) {
      return JSON.stringify({
        erro: 'apenas_longe',
        apenas_longe: true,
        distancia_km: Math.round(decision.onlyFar.distanceKm),
        nome_loja_distante: decision.onlyFar.unitName,
        mensagem:
          'Esse item só tem numa loja mais distante. Confirme a opção com o cliente (entregar mesmo assim / equivalente perto / reservar) ANTES de criar o pedido.',
      });
    }
    partner = decision.routing;
    // Frete da MATRIZ por DISTÂNCIA garantido por CÓDIGO (decisão Wallace 06-19): se a
    // entrega cai na Matriz (sem parceiro), o frete é a tabela por km do MESMO wrapper que
    // o calcular_frete usou — NÃO o valor_frete que o LLM passou (pode estar defasado).
    // Parceiro segue no fixo (caminho próprio abaixo). Recalcula o total (frete mudou).
    if (!partner && decision.matrizFreight != null) {
      valorFrete = decision.matrizFreight;
      totalAmount = subtotal + valorFrete;
    }
  } else if (modalidade === 'pickup' && env.PICKUP_TO_PARTNER) {
    // RETIRADA pelos MESMOS critérios da entrega: proximidade (anel de retirada) + régua
    // de justiça. Município vem do geo (se houver) ou do bairro; coordenada vem do pino
    // ou do geocode do bairro. Sem município/coordenada → cai na matriz (como hoje).
    let municipio = geoResolutionId
      ? await resolveMunicipioFromGeo(client, environment, geoResolutionId)
      : await resolveMunicipioFromBairro(client, environment, (args.bairro as string | undefined) ?? '', null);
    // Pino-first: sem geo e sem bairro → reverse-geocode do pino preenche a cidade. Aditivo.
    ({ municipio } = await fillCityFromPin(client, environment, conversationId, { municipio, neighborhoodCanonical: null }));
    if (env.ROUTING_GEO && municipio) {
      const customerLocation = await resolveCustomerLocation(client, environment, conversationId, {
        municipio,
        bairro: args.bairro as string | undefined,
        apiKey: env.GOOGLE_MAPS_API_KEY,
      });
      if (customerLocation) {
        const geo = await decideStoreForItemsGeo(client, environment, {
          municipio,
          items: itens.map((i) => ({ product_id: i.product_id, quantity: i.quantidade })),
          modalidade: 'pickup',
          customerLocation,
          clientNeighborhoodCanonical: args.bairro ? normalizeRegion(args.bairro as string) : null,
        });
        // Caso E (só tem longe): por padrão pergunta antes de criar (igual à entrega).
        // EXCEÇÃO — consentimento (decisão Wallace 2026-06-08): se o cliente já bancou ir
        // buscar mesmo longe (o bot marcou confirma_retirada_distante), reserva o pneu na
        // loja mais perto que tem, mesmo fora do raio. NÃO é regra: dispara só com a
        // confirmação do cliente nesta conversa; nada é persistido sobre a região (nasceu
        // loja perto → ela ganha sozinha no anel, e este caminho nem é alcançado).
        if (geo.kind === 'only_far') {
          if (confirmaRetiradaDistante) {
            partner = geo.routing;
          } else {
            return JSON.stringify({
              erro: 'apenas_longe',
              apenas_longe: true,
              distancia_km: Math.round(geo.distanceKm),
              nome_loja_distante: geo.unitName,
              mensagem:
                'Esse item só tem numa loja mais distante pra retirar. Confirme com o cliente (retirar lá mesmo / equivalente mais perto) ANTES de criar o pedido. Se ele disser que vai buscar mesmo assim, chame de novo com confirma_retirada_distante=true.',
            });
          }
        } else if (geo.kind === 'partner') {
          partner = geo.routing;
        }
      }
    }
  }

  let order: { id: string; order_number: string };
  let respSubtotal: number;
  let respFrete: number;
  let respTotal: number;
  // Opção 1 (decisão Wallace 2026-06-14): o cartão da loja (endereço/mapa/horário) só é
  // devolvido AGORA, no fechamento da retirada — entra no resumo do pedido. Antes de fechar
  // o bot nunca teve esses dados (localizacao_loja só dá nome+distância).
  let retirada: { nome_loja: string; endereco: string | null; maps_url: string | null; horario: string | null } | null = null;

  if (partner) {
    // ── CAMINHO PARCEIRO: dono (partner_order 2w + reserva + COD) + espelho ──
    // Impressão digital estável (H2): o MESMO pedido em retry gera a MESMA chave →
    // não duplica o espelho nem o partner_order (register_partner_local_order dedup).
    const idempotencyKey = buildOrderIdempotencyKey(conversationId, partner.unitId, itens, modalidade);

    const mat = await materializePartnerOrder(client, partner.ctx, {
      customer_name: customerName,
      customer_phone: effectivePhone,
      items: partner.items.map((it) => ({
        partner_stock_id: it.partner_stock_id,
        quantity: it.quantity,
        unit_price: it.central_price,
      })),
      fulfillment_mode: modalidade as 'delivery' | 'pickup',
      delivery_address: deliveryAddress,
      freight_amount: modalidade === 'delivery' ? FRETE_PADRAO_BRL : 0,
      idempotency_key: idempotencyKey,
      // RETIRADA → reserva o pneu (segura até retirar), sem recebível. Entrega segue COD.
      reserve_for_pickup: modalidade === 'pickup',
    });

    // FOTO SOB DEMANDA: o pedido fechou → gruda as fotos respondidas desta
    // conversa nos itens (card "Em separação" mostra a foto; guard de
    // re-roteamento na query) e cancela pendentes (sem fallback pós-compra).
    if (env.PHOTO_REQUESTS) {
      const cwConvId = await lookupChatwootConversationId(client, conversationId);
      if (cwConvId) {
        await linkPhotoRequestsToOrder(client, environment, cwConvId, mat.partner_order_id);
      }
    }

    // H1: o total do espelho é LIDO DE VOLTA do partner_order (uma fonte de número,
    // nunca o que o LLM cotou) — e os itens vão a preço CENTRAL.
    order = await insertCommerceOrderMirror(client, environment, {
      contactId,
      conversationId,
      totalAmount: mat.total_amount,
      fulfillmentMode: modalidade,
      paymentMethod: 'A receber',
      deliveryAddress,
      geoResolutionId,
      customerName,
      unitId: partner.unitId,
      partnerOrderId: mat.partner_order_id,
      idempotencyKey,
      items: partner.items.map((it) => ({
        product_id: it.product_id,
        quantity: it.quantity,
        unit_price: it.central_price.toFixed(2),
      })),
    });

    respSubtotal = partner.items.reduce((s, it) => s + it.central_price * it.quantity, 0);
    respFrete = modalidade === 'delivery' ? FRETE_PADRAO_BRL : 0;
    respTotal = Number(mat.total_amount);

    // Cartão da loja que RESERVOU (unit do pedido — NÃO re-roteia, senão pegaria outra loja).
    if (modalidade === 'pickup') {
      const disp = await getUnitDisplayById(client, environment, partner.unitId);
      if (disp) {
        retirada = { nome_loja: disp.nome_loja, endereco: disp.address, maps_url: disp.maps_url, horario: disp.opening_hours };
      }
    }

    logger.info(
      {
        environment,
        conversation_id: conversationId,
        order_id: order.id,
        order_number: order.order_number,
        partner_order_id: mat.partner_order_id,
        unit_id: partner.unitId,
        store: 'partner',
      },
      'agent_v2: pedido criado (parceiro 2w)',
    );
  } else {
    // ── CAMINHO MATRIZ (= Etapa 1): carimba unit_id da matriz, sem partner_order ──
    // Dedup: chave estável (conversa+loja+itens+modalidade) como no parceiro — em
    // dupla-chamada do MESMO pedido o ON CONFLICT devolve o existente em vez de duplicar.
    // Defensivo: unit_id NULL se não achar a matriz. (Fix Vitor Fernando 06-15: PED-0045/0046.)
    const unitId = await resolveMatrizUnitId(client, environment);
    const idempotencyKey = buildOrderIdempotencyKey(conversationId, unitId, itens, modalidade);
    order = await insertCommerceOrderMirror(client, environment, {
      contactId,
      conversationId,
      totalAmount: totalAmount.toFixed(2),
      fulfillmentMode: modalidade,
      paymentMethod: formaPagamento,
      deliveryAddress,
      geoResolutionId,
      // customer_name: nome dado NA conversa (pode diferir de core.contacts.name).
      customerName,
      unitId,
      partnerOrderId: null,
      idempotencyKey,
      items: itens.map((i) => ({
        product_id: i.product_id,
        quantity: i.quantidade,
        unit_price: i.preco_unitario.toFixed(2),
      })),
    });

    respSubtotal = subtotal;
    respFrete = valorFrete;
    respTotal = totalAmount;

    logger.info(
      { environment, conversation_id: conversationId, order_id: order.id, order_number: order.order_number },
      'agent_v2: pedido criado',
    );
  }

  return JSON.stringify({
    ok: true,
    order_number: order.order_number,
    subtotal_itens: respSubtotal.toFixed(2),
    valor_frete: respFrete.toFixed(2),
    total: respTotal.toFixed(2),
    mensagem: `Pedido ${order.order_number} criado com sucesso.`,
    // Retirada: cartão da loja pro resumo "como chegar" (só no caminho parceiro+pickup).
    ...(retirada ? { retirada } : {}),
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
  // C6 (Tijolo 3.4): pedido de parceiro tem o status operacional REAL no dono
  // (partner_orders), não no espelho — o espelho fica eternamente 'open'.
  partner_order_id: string | null;
  partner_delivery_status: string | null;
  partner_status: string | null;
}

interface OrderItemRow {
  product_name: string;
  product_code: string;
  quantity: number;
  unit_price: string;
}

/**
 * C6 (Tijolo 3.4): situação de um pedido de PARCEIRO em linguagem de cliente,
 * derivada do DONO (`partner_orders`). O espelho `commerce.orders.status` fica
 * sempre 'open' pra pedido de parceiro (quem avança o estado é a máquina do
 * parceiro), então o bot tem que ler daqui pra responder "cadê meu pedido" certo.
 */
function situacaoParceiro(deliveryStatus: string | null, partnerStatus: string | null): string {
  if (partnerStatus === 'cancelled') return 'cancelado';
  switch (deliveryStatus) {
    case 'pending':
      return 'em separação';
    case 'dispatched':
      return 'saiu para entrega';
    case 'delivered':
      return 'entregue';
    case 'failed':
      return 'entrega não concluída';
    default:
      return 'em separação';
  }
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
    // SEC-001: busca por número SÓ retorna pedido do PRÓPRIO contato da conversa.
    // Sem esse vínculo, qualquer cliente lia pedido (nome/endereço/itens/valor) de
    // outro cliente só chutando o número. Segurança > conveniência de "outra conta dele".
    if (!contactId) {
      return JSON.stringify({
        encontrado: false,
        mensagem: 'Não consegui identificar seu contato pra localizar esse pedido. Me chama pelo mesmo número da compra?',
      });
    }
    const result = await client.query<OrderRow>(
      `SELECT o.id, o.order_number, o.status, o.total_amount, o.fulfillment_mode,
              o.payment_method, o.delivery_address, o.customer_name, o.created_at, o.closed_at,
              o.partner_order_id, po.delivery_status AS partner_delivery_status, po.status AS partner_status
       FROM commerce.orders o
       LEFT JOIN commerce.partner_orders po ON po.id = o.partner_order_id
       WHERE o.environment = $1
         AND o.order_number = $2
         AND o.contact_id = $3
       LIMIT 1`,
      [environment, orderNumber.toUpperCase().trim(), contactId],
    );
    orders = result.rows;

    if (orders.length === 0) {
      return JSON.stringify({
        encontrado: false,
        mensagem: `Não encontrei o pedido ${orderNumber} na sua conta. Confere o número?`,
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
      `SELECT o.id, o.order_number, o.status, o.total_amount, o.fulfillment_mode,
              o.payment_method, o.delivery_address, o.customer_name, o.created_at, o.closed_at,
              o.partner_order_id, po.delivery_status AS partner_delivery_status, po.status AS partner_status
       FROM commerce.orders o
       LEFT JOIN commerce.partner_orders po ON po.id = o.partner_order_id
       WHERE o.environment = $1
         AND o.contact_id = $2
       ORDER BY o.created_at DESC
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
        // C6: pedido de parceiro → situação REAL (em separação/saiu/entregue),
        // já em linguagem de cliente. O `status` do espelho fica sempre 'open'.
        ...(o.partner_order_id
          ? {
              eh_parceiro: true,
              situacao_parceiro: situacaoParceiro(o.partner_delivery_status, o.partner_status),
            }
          : {}),
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
    partner_order_id: string | null;
    partner_delivery_status: string | null;
    partner_status: string | null;
  }>(
    `SELECT o.id, o.status, o.total_amount, o.contact_id, o.partner_order_id,
            po.delivery_status AS partner_delivery_status, po.status AS partner_status,
            (SELECT contact_id FROM core.conversations WHERE id = $2) AS conv_contact_id
     FROM commerce.orders o
     LEFT JOIN commerce.partner_orders po ON po.id = o.partner_order_id
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

  // Tijolo 3.4: pedido roteado a parceiro → cancelamento REAL e propagado.
  // Dono (partner_orders) e espelho (commerce.orders) cancelados JUNTOS, atômico
  // (BEGIN/COMMIT próprio — cancelar_pedido roda FORA da transação do agent.ts,
  // que só envolve criar_pedido). cancel_partner_local_order libera a reserva +
  // estorna o recebível (0080); cancel_manual_order só marca o espelho (NÃO toca
  // estoque da matriz — 0032). A LEI: o dono cancela, o espelho segue.
  if (order.partner_order_id) {
    if (order.partner_status === 'cancelled') {
      return JSON.stringify({ erro: `Pedido ${orderNumber} já está cancelado.` });
    }
    // Bot só cancela enquanto EM SEPARAÇÃO (pending). Despachado/entregue/falhou =
    // mercadoria em trânsito ou em disputa → atendente humano.
    if (order.partner_delivery_status !== 'pending') {
      return JSON.stringify({
        erro: 'Pedido de parceiro já saiu pra entrega ou foi entregue: cancelamento precisa de atendente humano.',
        sugestao: 'Escalando pra humano.',
      });
    }
    const reason = detalhes ? `${motivo}: ${detalhes}` : motivo;
    try {
      await client.query('BEGIN');
      await client.query('SELECT commerce.cancel_partner_local_order($1, $2, $3)', [
        order.partner_order_id,
        'agent_v2_bot',
        reason,
      ]);
      await client.query('SELECT commerce.cancel_manual_order($1, $2, $3)', [order.id, 'agent_v2_bot', reason]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { environment, order_number: orderNumber, partner_order_id: order.partner_order_id, err: message },
        'agent_v2: erro ao cancelar pedido de parceiro',
      );
      return JSON.stringify({ erro: `Não foi possível cancelar: ${message}`, sugestao: 'Escalando pra humano.' });
    }
    logger.info(
      { environment, conversation_id: conversationId, order_number: orderNumber, partner_order_id: order.partner_order_id, motivo },
      'agent_v2: pedido de parceiro cancelado via bot (reserva liberada + recebível estornado + espelho)',
    );
    return JSON.stringify({ ok: true, order_number: orderNumber, motivo, mensagem: `Pedido ${orderNumber} cancelado.` });
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
    partner_order_id: string | null;
  }>(
    `SELECT o.id, o.status, o.contact_id, o.fulfillment_mode, o.partner_order_id,
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

  // Tijolo 3.4: edição de pedido de parceiro fica ADIADA de propósito (escala
  // humano — seguro, sem órfão). Não existe `edit_partner_local_order` (re-reserva
  // de estoque) na máquina do parceiro; editar só metade (endereço sim, itens não)
  // faria o espelho e o dono divergirem → viola a LEI ("um dono por número").
  // Propagação real de edição é follow-up (precisa da função de re-reserva).
  if (order.partner_order_id) {
    return JSON.stringify({
      erro: 'Pedido de parceiro: alteração precisa de atendente humano.',
      sugestao: 'Escalando pra humano (pedido roteado a parceiro).',
    });
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
