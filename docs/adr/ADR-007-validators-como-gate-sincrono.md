# ADR-007 — SayValidator + ActionValidator como gate sincrono pre-envio

Data: 2026-05-10
Status: Aceita

## Contexto

Com o descarte de Critic em tempo real (ADR-005), precisava ficar formalmente registrado qual e o gate sincrono pre-envio Chatwoot. Sem registro formal, futuras sessoes podem reabrir a discussao "precisamos de Critic?" sem perceber que ja existe gate funcionando.

Durante Sprints 6.7 a 6.9 e PRs 1 a 5 (entre 2026-05-04 e 2026-05-10), foram implementados:

**SayValidator** (`src/atendente/validators/say-validator.ts`):
- `stock_claim_without_verificar_estoque`: bloqueia "tem em estoque" sem `verificarEstoque` ok.
- `brand_claim_without_buscar_produto`: bloqueia "Tem Pirelli sim" sem `buscarProduto` lastro.
- `delivery_claim_without_calcular_frete`: bloqueia "frete gratis", prazos sem `calcularFrete`.
- `compatibility_claim_without_buscar_compatibilidade`: bloqueia "serve pra sua moto" sem tool.
- `policy_claim_without_tool_result`: bloqueia parcelamento, brinde, garantia, troca, promocao sem `buscarPoliticaComercial`.
- `money_not_supported_by_tool_result`: extrai R$ do texto, bloqueia se valor nao bate com tool result (~0.01).
- `safe_fallback_not_allowed_for_pedir_dados_faltantes`: SAFE_FALLBACK proibido em skill que deveria perguntar.
- `mixed_safe_fallback_with_other_content`: fallback puro nao pode vir misturado com outras claims.
- `discount_claim_without_desconto_maximo`: desconto sem politica.
- `discount_above_desconto_maximo`: desconto acima do limite cadastrado.
- `gift_claim_without_promotion_policy`: brinde sem politica promocional.
- `custom_offer_without_commercial_policy`: "faco por R$ 200" sem politica comercial.

**ActionValidator** (`src/atendente/validators/action-validator.ts`):
- Scope global vs item-scoped slots.
- Source obrigatorio (`message_id` para confirmed; inferido OK para criticos).
- Maximo 5 open items.
- `record_offer`: produto deve existir em tool results, item aberto/ofertado.
- `add_to_cart`: product_id em last offer ou tool results.
- `remove_from_cart`/`update_cart_item`: item vivo no carrinho.
- `clear_cart`: bloqueado se ha pending_confirmation aberta.
- `update_draft delivery`: bloqueado sem endereco.
- `escalate ready_to_close`: exige carrinho confirmado.
- `order_confirmation`: medida_pneu + quantidade confirmed+fresh em todo item ofertado.

Validados em smoke LLM real em conversas Chatwoot `470`-`473` em 2026-05-10: 6 turnos `generated` seguros + 2 `blocked` (brinde por `policy_claim_without_tool_result`; oferta R$ 200 por `money_not_supported_by_tool_result:200`). Em ambos os casos `blocked_say_text` preservado em `agent.turns`.

## Decisao

**SayValidator + ActionValidator sao oficialmente o gate sincrono pre-envio Chatwoot.**

Quando Sprint 8 for ligado (envio efetivo), o fluxo sera:

1. Generator gera candidato.
2. SayValidator valida `say_text`.
3. ActionValidator valida `actions[]`.
4. Se ambos aprovarem: `agent.turns.status='generated'`, libera para envio.
5. Se algum bloquear: `agent.turns.status='blocked'`, candidato preservado em `blocked_say_text`/`blocked_actions`/`blocked_payload`, sem envio.

Nao havera segundo passe LLM (Critic) entre validators e envio. Nao havera Supervisora sincrona (ela e batch pos-fato, ADR-006).

## Razoes

1. **Validacao deterministica e mais confiavel que LLM para regras hard.** Regex + checagem contra tool result nao tem temperatura, nao alucina, nao varia.
2. **Latencia zero.** Validators rodam em microssegundos.
3. **Custo zero.** Sem chamada LLM adicional.
4. **Cobertura provada em prod.** Smoke real bloqueou exatamente o que deveria bloquear (turns 470-473).
5. **Auditavel.** Cada bloqueio gera razao especifica em `agent.turns.error_message` e preserva candidato em `blocked_say_text`.

## Limites conhecidos

SayValidator + ActionValidator NAO pegam:
- Preco errado (diz R$100, ferramenta retorna R$150) — proximidade ~0.01 cobre, mas nao mismatch grande.
- Prazo errado (diz "2 dias", ferramenta retorna "5 dias") — `mentionsDeliveryClaim` so detecta a frase, nao compara.
- Tom inadequado (agressivo, robotico, condescendente).
- Repeticao (perguntar mesma coisa que ja sabe).
- Resposta vaga quando dado existia.
- Playbook drift (foge do estilo da loja).
- Missed question (cliente perguntou X, bot respondeu Y).
- Hallucination que passa pelo SayValidator (resposta plausivel sem invencao detectavel).

Esses gaps qualitativos serao endereçados pela:
- Comparacao humano vs bot durante Fase D estendida (ADR-008) — mitigacao curto prazo.
- Supervisora batch pos-fato (ADR-006) — mitigacao longo prazo, Fase G futura.

## Consequencias

Positivas:
- Gate definitivo. Nao precisa esperar Critic.
- Sprint 8 (envio) nao depende de novo componente.
- Custo de inferencia menor.

Negativas:
- Gaps qualitativos (tom, repeticao) ficam sem gate sincrono. Mitigado por escopo restrito de Sprint 8 inicial (1 vendedor + fallback humano).

## Documentos atualizados

Todas as referencias a "Critic + SayValidator devem bloquear antes de envio" foram corrigidas para "SayValidator + ActionValidator sao o gate".

## Decisoes relacionadas

- ADR-005: Critic descartado
- ADR-006: Supervisora batch adiada
- ADR-008: Fase D estendida como proximo passo

## Validacao em prod

Smoke `pr5-commercial-20260510190449` (Chatwoot turns `470`-`473`):
- Brinde sem politica → bloqueado por `policy_claim_without_tool_result`.
- Oferta "faz por R$ 200" → bloqueado por `money_not_supported_by_tool_result:200`.
- `blocked_say_text` preservado em ambos os casos.
- 0 envios ao cliente.
