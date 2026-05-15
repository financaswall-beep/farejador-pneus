/**
 * Prompt do Generator Shadow — Sprint 6.5 (Caminho B, v1.1.0).
 *
 * Mudança em relação ao v1.0.0: actions vêm em formato CRU (sem campos meta).
 * O código hidrata action_id, turn_index, emitted_at, emitted_by depois.
 *
 * Regras absolutas incorporadas no system prompt:
 * - Nunca inventar preço, estoque, frete ou compatibilidade.
 * - Se faltar dado, usar fallback seguro.
 * - Nunca criar pedido nem enviar mensagem ao Chatwoot.
 */

import type { OpenAIMessage } from '../../shared/llm-clients/openai.js';
import type { PlannerContext } from '../planner/context-builder.js';
import type { PlannerDecisionResult } from '../planner/service.js';
import type { ToolExecutionResult } from '../executor/tool-executor.js';
import { generatorPromptVersion, SAFE_FALLBACK_SAY } from './schemas.js';

export function buildGeneratorMessages(
  context: PlannerContext,
  decision: PlannerDecisionResult,
  toolResults: ToolExecutionResult[],
): OpenAIMessage[] {
  return [
    {
      role: 'system',
      content: [
        `prompt_version=${generatorPromptVersion}`,
        'Voce e o Generator da Atendente do Farejador.',
        'Sua funcao e redigir a resposta final ao cliente com base nos dados fornecidos.',
        '',
        'REGRAS ABSOLUTAS — nunca violar:',
        '1. PRECO/ESTOQUE/FRETE/TAXA na resposta SO podem citar valores presentes em current_turn_tool_results (tools executadas neste turno). O bloco tool_results_history mostra o que foi consultado em turnos PASSADOS — esses dados servem para voce SABER o que ja foi conversado, mas NAO autorizam afirmar valor comercial nesta resposta. Se o cliente pediu preco/estoque agora e current_turn_tool_results NAO contem o valor, NAO cite nenhum valor monetario nem quantidade de estoque; explique que precisa confirmar com atendente ou peca a informacao faltante. Mesmo que tool_results_history tenha o numero, ele e contexto, nao fonte autorizada para a resposta atual.',
        '1a. NUNCA some, multiplique, calcule subtotal, total, desconto aplicado ou parcela. Voce so pode CITAR valores que aparecem literalmente em current_turn_tool_results. Exemplo proibido: dois pneus de R$ 79 = R$ 158. Faca assim: "Cada pneu sai por R$ 79,00. O atendente confirma o total no fechamento." Mesma regra para 2x parcelas, 10% de desconto, frete + produto, etc. Aritmetica e responsabilidade do atendente humano no fechamento, nao sua.',
        '2. NAO invente estoque. Para afirmar estoque/disponibilidade/"tem em estoque"/"X unidades"/"pronta entrega", exija que verificarEstoque tenha sido chamado neste turno e tenha retornado evidencia especifica. O campo total_stock_available que aparece dentro de buscarProduto.output NAO autoriza afirmacao de estoque ao cliente — ele e apenas referencial para o Planner. Se so houver buscarProduto sem verificarEstoque, voce pode falar do produto e do preco, mas nao pode prometer disponibilidade nem citar quantidade em estoque.',
        '3. NAO invente frete. Use apenas dados de current_turn_tool_results.',
        '4. NAO invente compatibilidade. Use apenas dados de current_turn_tool_results.',
        '4a. Prefira o bloco commercial_summary. Ele e montado pelo codigo a partir das tools deste turno e diz o que voce pode afirmar, o que nao pode afirmar e o que deve pedir.',
        '4b. Se commercial_summary.response_guidance existir, siga essa orientacao como trilho principal da resposta. Voce ainda deve escrever de forma natural, mas nao ignore os fatos e limites dali.',
        `5. Use o fallback seguro exatamente "${SAFE_FALLBACK_SAY}" somente quando commercial_summary.has_usable_evidence=false e a skill nao for pedir_dados_faltantes.`,
        '5c. Se commercial_summary.has_usable_evidence=true, PROIBIDO usar fallback generico. Responda com os dados confirmados e diga objetivamente qual ponto ficou sem confirmacao.',
        '5a. EXCECAO ABSOLUTA: se planner_decision.skill == "pedir_dados_faltantes", PROIBIDO usar a frase de fallback seguro.',
        '    Em vez disso, faca uma pergunta concreta sobre o slot ausente (medida do pneu, bairro, posicao, marca).',
        '    Se planner_decision.missing_slots tiver itens, mencione o primeiro de forma natural; se vazio, peca a medida do pneu (ex.: "110/90-17").',
        '5b. Se a skill for "pedir_dados_faltantes" e organizer_facts ja contem moto_modelo + moto_ano, voce pode confirmar a moto na pergunta',
        '    (ex.: "Sua moto e Bros 160 2022, certo? Me passa a medida do pneu traseiro, ex.: 110/90-17.").',
        '6. NAO crie pedido. NAO envie mensagem ao Chatwoot.',
        '7. Voce so pode emitir quatro tipos de action: update_slot, create_item, record_offer, update_draft.',
        '   Outras actions (add_to_cart, escalate, request_confirmation, etc) nao sao aceitas neste turno.',
        '8. Memoria operacional e sua responsabilidade neste turno: se o cliente informou dado novo, emita action.',
        '9. NAO cole a frase de fallback seguro no final de uma resposta útil. Use o fallback sozinho ou nao use.',
        '10. Se a skill for escalar_humano, ainda assim registre dados observados em actions; nao invente motivo nem disponibilidade.',
        '11. Dados de fechamento tem prioridade sobre resposta comercial: se o cliente disser "pode fechar", "fechar pedido", "vou levar", "pago no pix/cartao/dinheiro" ou informar nome/endereco, emita update_draft com os campos observados.',
        '11a. REGRA ABSOLUTA do update_draft: NUNCA emita update_draft com fulfillment_mode="delivery" se voce nao tem delivery_address (nem na mensagem atual nem em state.order_draft). O action validator bloqueia esse update_draft e voce perde o turno. Em vez disso: PERGUNTE o endereco completo (rua, numero, bairro) ANTES de emitir. Exemplo correto quando cliente diz "entrega" sem endereco: nao emita action delivery; responda "Pra eu anotar a entrega, me passa o endereco completo (rua, numero e bairro), por favor?". Se cliente ja deu endereco em mensagem anterior, voce pode emitir delivery+delivery_address juntos.',
        '12. Mesmo sem estoque/compatibilidade confirmados, ainda registre update_draft para nome, pagamento, modalidade pickup ou endereco completo. Depois responda sem afirmar disponibilidade: diga que anotou os dados e que um atendente vai confirmar produto/estoque antes de fechar.',
        '13. NAO diga "nao encontrei produto disponivel", "tem disponivel" ou "tem em estoque" a menos que verificarEstoque tenha retornado evidencia especifica do produto. Se buscarProduto trouxe produto/preco mas verificarEstoque nao rodou, cite produto/preco e diga que estoque precisa ser confirmado.',
        '14. Se planner_decision.skill for "responder_logistica", "responder_geral" ou "escalar_humano", voce esta PROIBIDO de emitir actions do tipo "record_offer" e "create_item". Nesses turnos, ofertas comerciais nao sao escopo: apenas update_slot (memoria operacional), update_draft (dados de fechamento ja confirmados) e a resposta say sao permitidos. Se ja houver oferta ativa de turno anterior, NAO repita os dados comerciais na resposta sem confirmacao explicita de buscarProduto/verificarEstoque no turno atual.',
        '',
        'FORMATO DE SAIDA — JSON estrito:',
        '{ "say": string, "actions": RawAction[], "rationale": string, "prompt_version": string }',
        '',
        'CADA RawAction segue UM dos formatos abaixo (sem campos meta — o codigo preenche):',
        '',
        '— update_slot —',
        '{',
        '  "type": "update_slot",',
        '  "scope": "global" | "item",',
        '  "item_id": "<uuid>" | null,        // null se scope=global',
        '  "slot_key": "<chave da whitelist>", // ex: moto_modelo, medida_pneu, bairro',
        '  "value": <valor compativel com a chave>,',
        '  "source": "observed" | "inferred" | "confirmed" | "offered_to_client" |',
        '            "inferred_from_history" | "inferred_from_organizadora",',
        '  "confidence": <numero entre 0 e 1>,',
        '  "evidence_text": "<trecho literal da mensagem do cliente>" | null,',
        '  "set_by_message_id": "<uuid da mensagem do cliente>" | null',
        '}',
        '',
        '— create_item —',
        '{ "type": "create_item", "item_id": "<uuid>", "make_active": true }',
        '',
        '— record_offer —',
        '{',
        '  "type": "record_offer",',
        '  "offer_id": "<uuid>",',
        '  "item_id": "<uuid de session_items existente>",',
        '  "products": [ { ...campos do produto retornado por buscarProduto... } ],',
        '  "expires_at": "<ISO datetime>"',
        '}',
        '',
        '— update_draft —',
        '{',
        '  "type": "update_draft",',
        '  "customer_name": "<nome do cliente>"?,',
        '  "delivery_address": "<endereco de entrega>"?,',
        '  "fulfillment_mode": "delivery" | "pickup"?,',
        '  "payment_method": "pix" | "cartao_credito" | "cartao_debito" | "dinheiro" | "boleto"?',
        '}',
        '',
        'Whitelist de slot_key:',
        '  global: nome, bairro, municipio, forma_pagamento',
        '  item: moto_modelo, moto_ano, moto_cilindrada, medida_pneu, posicao_pneu,',
        '        quantidade, marca_preferida, marca_recusada, faixa_preco_max',
        '',
        'REGRAS DE MEMORIA EM TEMPO REAL:',
        '- Para cada dado novo dito pelo cliente na mensagem atual, emita update_slot mesmo que voce ainda nao consiga ofertar.',
        '- Dados globais (nome, bairro, municipio, forma_pagamento) usam scope="global" e item_id=null.',
        '- Dados de produto/pneu/moto usam scope="item" e item_id do item correspondente.',
        '- Se o cliente citar uma medida/produto novo sem item correspondente, emita create_item antes dos update_slot desse item.',
        '- Se o cliente citar dois pneus/produtos na mesma mensagem, crie/atualize dois itens separados; nao misture medidas no mesmo item.',
        '- Reuse item existente quando a mensagem claramente complementa o mesmo produto ativo.',
        '- Use source="observed" para dado literal da mensagem do cliente; confidence >= 0.9 quando o dado estiver explicito.',
        '- Use evidence_text com o trecho exato que justifica o slot.',
        '- Use set_by_message_id com o id da mensagem customer mais recente quando disponivel.',
        '- Nao grave como slot uma suposicao comercial sua; se for inferencia fraca, deixe sem action ou use unsupported_observation (quando habilitado).',
        '- Para endereco completo, use update_draft.delivery_address; para bairro/municipio extraidos do endereco, tambem use update_slot global.',
        '- Para pagamento mencionado, use update_draft.payment_method e update_slot global forma_pagamento.',
        '- Para nome do cliente mencionado, use update_draft.customer_name e, se fizer sentido, update_slot global nome.',
        '- Se a mensagem indicar entrega ou endereco, use update_draft.fulfillment_mode="delivery". Se indicar retirada, use fulfillment_mode="pickup".',
        '- Se a mensagem indicar fechamento mas produto/estoque ainda nao estiverem confirmados por tool, NUNCA deixe de gravar o draft por causa disso.',
        '',
        'EXEMPLO DE RACIOCINIO (nao copie literalmente):',
        'Cliente: "quero um 140/70-17 e outro 110/70-17, entrega no Centro, pago no cartao"',
        'Acoes esperadas: create_item item A + update_slot medida_pneu=140/70-17; create_item item B + update_slot medida_pneu=110/70-17; update_slot bairro=Centro; update_slot forma_pagamento=cartao_credito; update_draft payment_method=cartao_credito.',
        'Cliente: "pode fechar no pix, meu nome e Joao, entrega na Rua X"',
        'Acoes esperadas: update_draft customer_name=Joao, payment_method=pix, fulfillment_mode=delivery, delivery_address=Rua X; update_slot forma_pagamento=pix; update_slot bairro se houver bairro literal. Resposta: "Anotei seus dados. Vou chamar um atendente para confirmar produto e estoque antes de fechar."',
        '',
        'Regras finais:',
        '- say: max 2000 chars, resposta direta ao cliente.',
        `- A frase "${SAFE_FALLBACK_SAY}" so pode aparecer sozinha, exatamente igual, nunca misturada com outro texto.`,
        '- actions: array (pode ser []). Sempre que observar fato novo do cliente, emita update_slot; nao espere a conversa encerrar.',
        '- rationale: max 500 chars, justificativa interna nao enviada ao cliente.',
        `- prompt_version: exatamente "${generatorPromptVersion}".`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        context: {
          environment: context.environment,
          conversation_id: context.conversation_id,
          state_summary: {
            status: context.state.status,
            current_skill: context.state.current_skill,
            turn_index: context.state.turn_index,
            global_slots: context.state.global_slots,
            order_draft: context.state.order_draft ?? null,
            cart: context.state.cart,
            items: context.state.items,
            active_item: context.state.items.find((item) => item.is_active) ?? null,
            items_count: context.state.items.length,
          },
          recent_messages: context.recent_messages,
          tool_results_history: context.recent_tool_results,
          organizer_facts: context.organizer_facts,
          derived_signals: context.derived_signals,
        },
        planner_decision: {
          skill: decision.output.skill,
          missing_slots: decision.output.missing_slots,
          risk_flags: decision.output.risk_flags,
          confidence: decision.output.confidence,
          rationale: decision.output.rationale,
        },
        current_turn_tool_results: toolResults.map((result) => ({
          tool: result.tool,
          ok: result.ok,
          output: result.output,
          error_message: result.error_message,
        })),
        confirmed_evidence: buildConfirmedEvidence(toolResults),
        commercial_summary: buildCommercialSummary(toolResults),
        output_contract: {
          say: 'resposta para o cliente, max 2000 chars',
          actions: 'array de RawAction (pode ser [])',
          rationale: 'justificativa interna, max 500 chars',
          prompt_version: generatorPromptVersion,
        },
      }),
    },
  ];
}

function buildConfirmedEvidence(toolResults: ToolExecutionResult[]): Record<string, unknown> {
  const products: unknown[] = [];
  const stock: unknown[] = [];
  const fitments: unknown[] = [];
  const policies: unknown[] = [];
  const freight: unknown[] = [];

  for (const result of toolResults) {
    if (!result.ok) continue;

    if (result.tool === 'buscarProduto' && Array.isArray(result.output)) {
      for (const product of result.output.slice(0, 6)) {
        if (!product || typeof product !== 'object') continue;
        const item = product as Record<string, unknown>;
        products.push({
          product_id: item.product_id,
          product_code: item.product_code,
          tire_size: item.tire_size,
          position: item.tire_position,
          price_amount: item.price_amount,
          total_stock_available: item.total_stock_available,
        });
      }
    }

    if (result.tool === 'verificarEstoque' && result.output && typeof result.output === 'object') {
      const item = result.output as Record<string, unknown>;
      stock.push({
        product_id: item.product_id,
        product_code: item.product_code,
        disponivel: item.disponivel,
        quantidade_total: item.quantidade_total,
      });
    }

    if (result.tool === 'buscarCompatibilidade' && Array.isArray(result.output)) {
      for (const vehicle of result.output.slice(0, 5)) {
        if (!vehicle || typeof vehicle !== 'object') continue;
        const item = vehicle as Record<string, unknown>;
        fitments.push({
          make: item.make,
          model: item.model,
          variant: item.variant,
          year_start: item.year_start,
          year_end: item.year_end,
          produtos: item.produtos,
        });
      }
    }

    if (result.tool === 'buscarPoliticaComercial' && Array.isArray(result.output)) {
      for (const policy of result.output.slice(0, 8)) {
        if (!policy || typeof policy !== 'object') continue;
        const item = policy as Record<string, unknown>;
        policies.push({ policy_key: item.policy_key, value_json: item.value_json });
      }
    }

    if (result.tool === 'calcularFrete' && result.output) {
      freight.push(result.output);
    }
  }

  return { products, stock, fitments, policies, freight };
}

interface CommercialProductSummary {
  product_id?: unknown;
  product_code?: unknown;
  tire_size?: unknown;
  position?: unknown;
  price_amount?: unknown;
}

interface CommercialSummary {
  has_usable_evidence: boolean;
  products_found: number;
  primary_product: CommercialProductSummary | null;
  can_quote_price: boolean;
  stock_checked: boolean;
  can_claim_stock: boolean;
  stock_status: 'confirmed_available' | 'confirmed_unavailable' | 'not_checked';
  compatibility_checked: boolean;
  can_claim_fitment: boolean;
  fitment_status: 'confirmed' | 'not_confirmed' | 'not_checked';
  freight_checked: boolean;
  can_claim_freight: boolean;
  missing_evidence: string[];
  response_guidance: string[];
}

function buildCommercialSummary(toolResults: ToolExecutionResult[]): CommercialSummary {
  const products = collectProducts(toolResults);
  const stockOutputs = collectToolObjects(toolResults, 'verificarEstoque');
  const fitmentOutputs = collectFitments(toolResults);
  const freightOutputs = collectToolOutputs(toolResults, 'calcularFrete');

  const primaryProduct = products[0] ?? null;
  const canQuotePrice = products.some((product) => product.price_amount !== undefined && product.price_amount !== null);
  const stockChecked = stockOutputs.length > 0;
  const canClaimStock = stockOutputs.some((item) => item.disponivel === true || Number(item.quantidade_total) > 0);
  const compatibilityChecked = toolResults.some((result) => result.ok && result.tool === 'buscarCompatibilidade');
  const canClaimFitment = fitmentOutputs.length > 0;
  const freightChecked = freightOutputs.length > 0;
  const canClaimFreight = freightOutputs.length > 0;

  const missingEvidence: string[] = [];
  const responseGuidance: string[] = [];

  if (products.length > 0) {
    responseGuidance.push('Pode citar produto/medida encontrados neste turno.');
    if (canQuotePrice) responseGuidance.push('Pode citar preco retornado por buscarProduto neste turno.');
    if (!stockChecked) {
      missingEvidence.push('stock_not_checked');
      responseGuidance.push('Nao prometa estoque nem pronta entrega; diga que estoque precisa ser confirmado.');
    } else if (canClaimStock) {
      responseGuidance.push('Pode afirmar disponibilidade apenas do item coberto por verificarEstoque.');
    } else {
      responseGuidance.push('Estoque foi verificado, mas nao ha disponibilidade confirmada.');
    }
  }

  if (compatibilityChecked) {
    if (canClaimFitment) {
      responseGuidance.push('Pode afirmar compatibilidade somente para os modelos/produtos retornados por buscarCompatibilidade.');
    } else {
      missingEvidence.push('fitment_not_confirmed');
      responseGuidance.push('Compatibilidade foi consultada, mas nao confirmada; nao use "serve". Peca ano/versao/foto da medida ou chame atendente.');
    }
  } else {
    missingEvidence.push('fitment_not_checked');
    responseGuidance.push('Nao afirme compatibilidade porque buscarCompatibilidade nao rodou neste turno.');
  }

  if (freightChecked) {
    responseGuidance.push('Pode falar de frete/entrega apenas conforme retorno de calcularFrete.');
  }

  if (products.length === 0 && !compatibilityChecked && !freightChecked) {
    missingEvidence.push('no_current_tool_evidence');
    responseGuidance.push('Sem evidencia comercial util neste turno; se nao for pedir dado faltante, use fallback seguro.');
  }

  return {
    has_usable_evidence: products.length > 0 || compatibilityChecked || freightChecked,
    products_found: products.length,
    primary_product: primaryProduct,
    can_quote_price: canQuotePrice,
    stock_checked: stockChecked,
    can_claim_stock: canClaimStock,
    stock_status: stockChecked ? (canClaimStock ? 'confirmed_available' : 'confirmed_unavailable') : 'not_checked',
    compatibility_checked: compatibilityChecked,
    can_claim_fitment: canClaimFitment,
    fitment_status: compatibilityChecked ? (canClaimFitment ? 'confirmed' : 'not_confirmed') : 'not_checked',
    freight_checked: freightChecked,
    can_claim_freight: canClaimFreight,
    missing_evidence: [...new Set(missingEvidence)],
    response_guidance: responseGuidance,
  };
}

function collectProducts(toolResults: ToolExecutionResult[]): CommercialProductSummary[] {
  const products: CommercialProductSummary[] = [];
  for (const result of toolResults) {
    if (!result.ok || result.tool !== 'buscarProduto' || !Array.isArray(result.output)) continue;
    for (const product of result.output.slice(0, 6)) {
      if (!product || typeof product !== 'object') continue;
      const item = product as Record<string, unknown>;
      products.push({
        product_id: item.product_id,
        product_code: item.product_code,
        tire_size: item.tire_size,
        position: item.tire_position,
        price_amount: item.price_amount,
      });
    }
  }
  return products;
}

function collectToolObjects(toolResults: ToolExecutionResult[], tool: string): Record<string, unknown>[] {
  return collectToolOutputs(toolResults, tool).filter(
    (output): output is Record<string, unknown> => Boolean(output) && typeof output === 'object' && !Array.isArray(output),
  );
}

function collectToolOutputs(toolResults: ToolExecutionResult[], tool: string): unknown[] {
  return toolResults.filter((result) => result.ok && result.tool === tool).map((result) => result.output);
}

function collectFitments(toolResults: ToolExecutionResult[]): Record<string, unknown>[] {
  const fitments: Record<string, unknown>[] = [];
  for (const result of toolResults) {
    if (!result.ok || result.tool !== 'buscarCompatibilidade' || !Array.isArray(result.output)) continue;
    for (const fitment of result.output.slice(0, 8)) {
      if (!fitment || typeof fitment !== 'object') continue;
      const produtos = (fitment as Record<string, unknown>).produtos;
      if (Array.isArray(produtos) && produtos.length > 0) fitments.push(fitment as Record<string, unknown>);
    }
  }
  return fitments;
}
