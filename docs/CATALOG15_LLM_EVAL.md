# Avaliacao Catalog15 - Organizadora, Planner E Atendente

Atualizado: 2026-05-14.

Rodada: `catalog15-20260514125728`.

Escopo:

- Chatwoot real em `prod`.
- Conversas `486` a `500`.
- 15 atendimentos.
- 45 mensagens incoming de cliente.
- Atendente em shadow: nenhuma resposta enviada ao cliente.

## Resultado Geral

| Camada | Resultado | Nota |
|---|---:|---:|
| Captura Chatwoot -> raw/core | 45/45 mensagens normalizadas | 10 |
| Organizadora | 14/15 conversas `done`; 1 schema mismatch | 8 |
| Planner | Chamou tools certas em boa parte, mas perdeu contexto em alguns turns finais | 7 |
| Atendente/Generator | Boa intencao comercial, mas tentou falar preco/estoque sem lastro perfeito varias vezes | 6 |
| Guardrails | Bloquearam 13 respostas arriscadas | 9 |
| Sistema completo em shadow | Fluxo vivo, seguro para shadow, ainda nao pronto para envio automatico | 7 |

## Diagnostico Por Atendimento

### 486 - Fan 2019, preco e estoque

Cliente:

- "Oi, tenho uma CG 160 Fan 2019."
- "Quero o pneu traseiro dela, acho que e 90/90-18."
- "Tem em estoque e qual o valor?"

Organizadora: extraiu corretamente `CG 160 Fan`, ano `2019`, medida
`90/90-18`, posicao `traseiro`, intencoes de preco e estoque.

Planner: acertou ao chamar `buscarCompatibilidade` e depois `buscarProduto`.
No ultimo turno, porem, caiu em `pedir_dados_faltantes` sem chamar tools.

Atendente: tentou responder:

> "Para a sua CG 160 Fan 2019, tenho o pneu traseiro 90/90-18 diagonal por R$ 79,00. No momento, constam 10 unidades em estoque..."

Guardrail: bloqueou corretamente porque falou estoque sem `verificarEstoque`.

Nota: Organizadora 10, Planner 7, Atendente 6, Sistema 7.

### 487 - Fan 2026, preco e estoque

Cliente:

- "Minha moto e uma CG 160 Fan 2026."
- "Preciso do pneu traseiro."
- "Se tiver 100/80-18 me passa preco."

Organizadora: extraiu `CG 160 Fan`, ano `2026`, medida `100/80-18`,
posicao `traseiro`.

Planner: inicialmente pediu dado faltante; depois chamou `buscarProduto`.
No ultimo turno perdeu a necessidade de tool recente.

Atendente: respondeu que tinha `100/80-18` por `R$ 89,00`.

Problema: resposta final citou dinheiro sem tool no turno validado.

Nota: Organizadora 9, Planner 7, Atendente 6, Sistema 7.

### 488 - CG 160 Cargo 2026, nao confundir medida

Cliente:

- "Serve 100/80-18 na CG 160 Cargo 2026?"
- "E para usar atras."
- "Se nao servir me fala sem inventar."

Organizadora: extraiu `CG 160 Cargo`, ano `2026`, medida `100/80-18`,
traseiro.

Planner: chamou `buscarCompatibilidade`.

Atendente: respondeu fallback seguro, sem afirmar que serve.

Resultado: comportamento correto. Nao ofereceu medida errada para Cargo 2026.

Nota: Organizadora 10, Planner 10, Atendente 9, Sistema 10.

### 489 - Suzuki Yes 125 pendente

Cliente:

- "Tenho uma Suzuki Yes 125."
- "Queria saber se o 90/90-18 serve atras."
- "Nao sei o ano certinho."

Organizadora: extraiu marca, modelo, cilindrada, medida e posicao.

Planner: pediu medida no primeiro turno e depois chamou compatibilidade.

Atendente: usou fallback seguro, sem dizer "serve".

Resultado: seguro, mas poderia ser mais humano: "costuma servir, mas preciso
confirmar ano ou foto da medida atual".

Nota: Organizadora 9, Planner 8, Atendente 7, Sistema 8.

### 490 - Dois pneus Fan 2019

Cliente:

- "Tenho uma Fan 160 2019."
- "Quero dianteiro 80/100-18 e traseiro 90/90-18."
- "Quanto fica os dois e tem os dois ai?"

Organizadora: extraiu quantidade `2`, medidas, ano, modelo e posicao `ambos`.

Planner: chamou compatibilidade e depois duas buscas de produto.

Atendente: teve uma falha de JSON no segundo turno e fallback seguro no final.

Resultado: entendeu o caso, mas nao conseguiu entregar resposta comercial boa
para dois pneus.

Nota: Organizadora 9, Planner 8, Atendente 4, Sistema 6.

### 491 - Cliente muda de 90/90-18 para 100/80-18

Cliente:

- "Quero pneu traseiro 90/90-18."
- "Na verdade errei, minha moto e Fan 2026."
- "Entao acho que e 100/80-18, confirma pra mim."

Organizadora: registrou `90/90-18` e `100/80-18`, ano `2026`, modelo `Fan`.

Planner: chamou compatibilidade nos turns.

Atendente: ficou em fallback seguro nos tres turns.

Resultado: seguro, mas fraco comercialmente. O sistema nao conseguiu converter
a correcao do cliente em oferta clara.

Nota: Organizadora 8, Planner 7, Atendente 5, Sistema 6.

### 492 - 140/70-17 sem preco

Cliente:

- "Tem 140/70-17 traseiro?"
- "E para uma Twister antiga."
- "Qual o preco e tem pronta entrega?"

Organizadora: extraiu medida, Twister, preco, estoque e pronta entrega.

Planner: chamou `buscarProduto`, depois compatibilidade e estoque.

Atendente: corretamente nao inventou preco nem estoque.

Resultado: bom. Tratou produto tecnico sem preco/estoque com cautela.

Nota: Organizadora 9, Planner 8, Atendente 8, Sistema 8.

### 493 - 150/60R17 com preco e estoque zero

Cliente:

- "Estou procurando 150/60R17 traseiro."
- "Vi que e para CB 300F Twister nova."
- "Tem estoque ou so encomenda? Quanto custa?"

Organizadora: extraiu modelo, medida, preco/estoque.

Planner: chamou compatibilidade e produto, mas no ultimo turno nao chamou tool.

Atendente: informou `R$ 129,00` e disse que estoque retornou `0`, pedindo
confirmacao humana para encomenda.

Resultado: bom conceito, mas validator apontou dinheiro sem tool recente em
alguns turns.

Nota: Organizadora 8, Planner 6, Atendente 7, Sistema 7.

### 494 - XJ6 esportiva

Cliente:

- "Cliente aqui, tenho uma XJ6."
- "Quero pneu traseiro, pode ser 180/55R17?"
- "Tem valor e estoque?"

Organizadora: extraiu XJ6, medida e posicao.

Planner: chamou compatibilidade, produto e estoque.

Atendente: tentou oferecer `180/55R17` por `R$ 149,00` e estoque 10.

Guardrails: bloquearam tudo por fala de preco/estoque sem lastro perfeito e
por `action_blocked:item_not_found`.

Resultado: comercialmente promissor, mas ainda perigoso para envio real.

Nota: Organizadora 9, Planner 7, Atendente 5, Guardrails 10, Sistema 7.

### 495 - Zontes R310 160/60R17

Cliente:

- "Minha moto e Zontes R310 2024."
- "Preciso do traseiro 160/60R17."
- "Se tiver eu passo no pix hoje."

Organizadora: extraiu marca, modelo, ano, medida, posicao, pix e urgencia.

Planner: chamou compatibilidade e produto.

Atendente: primeiro fallback; depois tentou informar `R$ 120,00`.

Problema: citou preco em turno sem lastro aceito pelo validator.

Nota: Organizadora 10, Planner 7, Atendente 6, Sistema 7.

### 496 - 110/70-17 + 140/70-17 sem preco

Cliente:

- "Tem 110/70-17 dianteiro?"
- "E para montar junto com 140/70-17 traseiro."
- "Me passa valor dos dois."

Organizadora: extraiu duas medidas, dianteiro/traseiro e quantidade 2.

Planner: chamou `buscarProduto` e politica comercial.

Atendente: nao inventou preco; fallback seguro quando nao tinha valor.

Resultado: bom e seguro.

Nota: Organizadora 9, Planner 8, Atendente 8, Sistema 8.

### 497 - Mudanca 140/70-17 para 130/70-17

Cliente:

- "Eu ia querer 140/70-17."
- "Mas olhando aqui o meu pneu e 130/70-17."
- "Tem esse 130 com preco e estoque?"

Organizadora: falhou com `llm_response_schema_mismatch`.

Planner: mesmo sem facts da Organizadora, conseguiu chamar produto e estoque.

Atendente: acompanhou a mudanca e tentou responder `130/70-17`, `R$ 99,00`,
estoque 10; parte foi bloqueada por dinheiro sem tool no turno final.

Resultado: caso importante para corrigir Organizadora em mudanca de opiniao.

Nota: Organizadora 3, Planner 7, Atendente 6, Sistema 6.

### 498 - Intruder custom 130/90-16 sem preco

Cliente:

- "Tenho uma Intruder customizada que usa 130/90-16 atras."
- "Voce tem esse pneu?"
- "Se tiver me fala preco."

Organizadora: extraiu medida, modelo customizado, posicao, preco e estoque.

Planner: chamou compatibilidade e produto.

Atendente: respondeu corretamente que encontrou cadastro tecnico, mas estoque
0 e sem preco, pedindo confirmacao humana.

Resultado: um dos melhores comportamentos.

Nota: Organizadora 9, Planner 8, Atendente 9, Sistema 9.

### 499 - Comparacao 190/50R17 e 190/55R17

Cliente:

- "Tenho uma esportiva e quero pneu traseiro aro 17."
- "Estou em duvida entre 190/50R17 e 190/55R17."
- "Tem os dois? Qual preco?"

Organizadora: extraiu duas medidas, uso esportivo e quantidade 2.

Planner: pediu medida, depois buscou produto, mas no final nao buscou os dois.

Atendente: tentou falar apenas do `190/55R17` por `R$ 159,00`; bloqueado.

Resultado: precisa melhorar comparacao de dois produtos simultaneos.

Nota: Organizadora 9, Planner 6, Atendente 5, Sistema 6.

### 500 - Produto + frete + pagamento

Cliente:

- "Quero o 100/80-18 traseiro da Fan."
- "Entrega em Rio do Ouro, Sao Goncalo?"
- "Se aceitar cartao eu fecho duas unidades."

Organizadora: extraiu produto, bairro, municipio, cartao, quantidade 2 e aceite.

Planner: misturou produto/frete; chamou produto, compatibilidade e frete, mas
nao chamou politica comercial para cartao no ultimo turno.

Atendente: varios bloqueios por `action_blocked:item_not_found` e uma falha de
JSON.

Resultado: caso realista e ainda fraco; precisa melhorar multi-intencao.

Nota: Organizadora 10, Planner 6, Atendente 4, Sistema 6.

## Conclusao

O sistema esta bom para continuar em shadow porque:

- Captura e normalizacao funcionaram.
- Organizadora acertou a maioria dos fatos.
- Planner geralmente escolheu a familia certa de tool.
- Guardrails impediram respostas perigosas.

Ainda nao esta pronto para envio automatico porque:

- Atendente ainda tenta verbalizar preco/estoque sem tool recente suficiente.
- Planner perde contexto em alguns turns finais e cai em `pedir_dados_faltantes`
  mesmo quando ja ha medida/produto no estado.
- Dois produtos no mesmo atendimento ainda sao instaveis.
- `record_offer` no mesmo turno de `create_item` gerou `item_not_found`.
- Organizadora falhou em um caso de mudanca de opiniao.

---

## Atualizacao 2026-05-15 — Rerun pos-mudancas

Apos as 12 mudancas desta janela (commits `4963701` a `6f7e7c5`), uma nova
rodada do catalog15 com `GENERATOR_PROMPT_FEW_SHOT_ENABLED=true` mostrou:

| Métrica | Catalog15 inicial (2026-05-14) | Catalog15-rerun com v1.5.0 (2026-05-15) |
|---|---:|---:|
| Generated | 32/45 | **45/45** |
| Blocked | 13/45 | **0/45** |
| Safe fallback exato | n/a | 2 |
| buscarProduto retornando produto | ~3% | **100% (25/25 calls)** |
| Adoção de claims (turnos com >=1 claim) | n/a | 64.4% |
| Média de claims/turn | n/a | 1.40 |
| `claim_invalid:*` blocks | n/a | 0 |

**5 dos failure modes detectados nesta rodada base ja foram resolvidos:**

1. **Citação de turn passado bloqueada** (cases 486, 487, 495, 497): resolvido por
   `regra 1` clarificada + auto-chain `verificarEstoque` + structured claims que
   validam contra `current_turn_tool_results`.
2. **Multi-produto vira fallback** (cases 490, 496, 499, 500): resolvido por
   Exemplo 4 no v1.5.0 few-shot ("Cada um sai por R$ 79,00, sem somar").
3. **Pivot/mudança congela** (cases 491, 497): resolvido por Exemplo 5 mostrando
   sobrescrita de slot.
4. **`item_not_found` em record_offer** (case 494): resolvido por
   `incoming_item_ids` no ActionValidator (já estava antes desta janela, mas
   continua estável).
5. **`Planner` alucinando marca/product_code** (case 495 Zontes): resolvido por
   Planner v1.2.7 + sanitize defensivo no executor.

**Failure modes residuais (continuam):**

1. **Objeção de preço informal** ("tá salgado"): Planner não roteia para
   `tratar_objecao` com confiabilidade. Não é bug do Generator, é do Planner.
2. **Organizadora em mudança de opinião** (case 497): `llm_response_schema_mismatch`
   pontual. Não impactou esta rodada.

**Notas finais:**

| Camada | Inicial (2026-05-14) | Rerun (2026-05-15) |
|---|---:|---:|
| Captura Chatwoot | 10 | 10 |
| Organizadora | 8 | 8.5 (provisório) |
| Planner | 7 | **9** |
| Atendente/Generator | 6 | **9** (provisório) |
| Guardrails | 9 | 9 (ClaimValidator novo + SayValidator rede) |
| Sistema completo em shadow | 7 | **8.3** |

Sistema continua não pronto para envio automático. Próxima fase é coleta humana
(ADR-008), não mais tunning.
