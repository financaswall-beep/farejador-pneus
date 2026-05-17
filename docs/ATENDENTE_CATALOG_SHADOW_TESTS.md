# Testes Shadow Do Catalogo Da Atendente

Atualizado: 2026-05-14.

Este documento registra a primeira bateria de testes manuais/sinteticos do
catalogo `commerce.*` antes de ligar o modo shadow operacional da Atendente.

## Regra De Interpretacao

- Estoque zero e normal para pneu que a loja nao tem no momento.
- Produto sem preco ainda pode existir como cadastro tecnico.
- A Atendente so pode falar preco quando `buscarProduto` retornar preco ativo.
- A Atendente so pode falar estoque/pronta entrega quando `verificarEstoque`
  retornar disponibilidade.
- A Atendente so pode falar "serve" quando `buscarCompatibilidade` retornar
  fitment oficial de `commerce.vehicle_fitments`.
- Para `commerce.fitment_discoveries`, a resposta correta e cautelosa:
  "costuma servir, mas preciso confirmar ano, versao ou foto da medida atual".

## Pesquisa Usada Para Validacao Inicial

- Honda CG 160 Fan 2018/2019-2020: manual Honda confirma traseiro 90/90-18.
- Honda CG 160 Fan 2026: ficha Honda confirma traseiro 100/80-18.
- Honda CG 160 Cargo 2026: ficha Honda confirma traseiro 80/100-18, portanto
  nao pode receber 100/80-18 por engano.
- Zontes 310/350: materiais Zontes confirmam familia 160/60R17/ZR17 traseira.
- Dafra Citycom 300i: manual Dafra confirma familia aro 16.

## Correcoes Feitas Durante O Teste

1. `commerce.resolve_vehicle_model` foi corrigida pela migration
   `0030_vehicle_resolver_variant_precision.sql` para preferir modelo + versao
   antes de cair no modelo generico.
2. Isso evita que "CG 160 Cargo 2026" seja resolvida como CG 160 generica/Fan e
   receba oferta incorreta de 100/80-18.
3. Foi cadastrado em `prod` o fitment oficial:
   Honda CG 160 Fan 2016-2024, traseiro, 90/90-18, source `manual`,
   confidence `0.95`.

## Bateria 5

Rodada em `prod` em 2026-05-14:

| Cenario | Pergunta simulada | Resultado esperado | Status |
|---|---|---|---|
| S1 | Serve na CG 160 Fan 2019? | Pode afirmar 90/90-18 traseiro. | PASS |
| S2 | Serve na CG 160 Fan 2026? | Pode afirmar 100/80-18 traseiro. | PASS |
| S3 | Serve 100/80-18 na CG 160 Cargo 2026? | Nao pode oferecer 100/80-18. | PASS |
| S4 | Tem pneu para Suzuki Yes 125? | Tratar como discovery pending e pedir confirmacao. | PASS |
| S5 | Tem 90/90-18? Quanto custa? | Pode falar R$ 79 e estoque 10 somente apos tools retornarem esses dados. | PASS |

Resumo da execucao:

```text
passed: 5
total: 5
environment: prod
```

Testes unitarios relacionados rodados em seguida:

```text
tests/unit/atendente/tools/commerce-tools.test.ts: 9 passed
tests/unit/atendente/validators/say-validator.test.ts: 49 passed
total: 58 passed
```

## Proximos Testes Recomendados

- Factor 150 2019: deve responder com cautela se estiver apenas em discovery.
- XJ6: nao deve oferecer pneu fora da medida correta, especialmente traseiro
  esportivo/radial.
- Scooter por medida: NMAX, PCX, ADV e Citycom.
- Pedido so por medida sem moto: pode consultar produto, mas nao afirmar
  compatibilidade com veiculo.
- Pedido por marca: so afirmar marca se `buscarProduto` ou
  `buscarCompatibilidade` trouxer a marca.

## Rodada Chatwoot Catalog15

Rodada em `prod` em 2026-05-14 com run id
`catalog15-20260514125728`.

Objetivo: testar Organizadora, Planner e Atendente/Generator passando pelo
Chatwoot, webhook, `raw.*`, `core.*`, `analytics.*`, `ops.*` e `agent.*`.

Escopo:

- 15 conversas criadas no Chatwoot: conversas `486` a `500`.
- 45 mensagens incoming de cliente.
- Casos com preco + estoque, sem preco, estoque zero, dois pneus, mudanca de
  opiniao, compatibilidade oficial, discovery/pending e moto esportiva.

Resumo tecnico:

- Mensagens normalizadas em `core.*`: 45/45.
- Jobs da Atendente: 45/45 processados.
- Turns da Atendente: 45/45 finalizados.
- Respostas geradas: 32.
- Respostas bloqueadas por validator/action validator: 13.
- Skills escolhidas:
  - `buscar_e_ofertar`: 33.
  - `pedir_dados_faltantes`: 11.
  - `responder_logistica`: 1.
- Tools chamadas:
  - `buscarProduto`: 18.
  - `buscarCompatibilidade`: 17.
  - `verificarEstoque`: 3.
  - `buscarPoliticaComercial`: 1.
  - `calcularFrete`: 1.

Organizadora:

- 14/15 conversas processaram com status `done`.
- 1/15 falhou com `llm_response_schema_mismatch` na conversa `497`
  (`cliente_troca_para_130`), caso de mudanca de opiniao de 140/70-17 para
  130/70-17.
- Nas conversas com sucesso, extraiu fatos como `moto_modelo`, `moto_ano`,
  `medida_pneu`, `posicao_pneu`, `quantidade_pneus`, `forma_pagamento`,
  `bairro_mencionado` e `municipio_mencionado`.

Comportamentos bons observados:

- `CG 160 Cargo 2026` + `100/80-18` nao foi confirmado; a resposta ficou em
  fallback seguro.
- `Suzuki Yes 125` ficou em resposta cautelosa/fallback, sem afirmar "serve".
- Produtos sem preco/estoque, como `140/70-17`, `110/70-17` e `130/90-16`,
  nao tiveram preco inventado em respostas aprovadas.
- Estoque zero com preco, como `150/60R17`, foi tratado com cautela: informou
  preco quando havia lastro, mas nao prometeu disponibilidade.
- Troca de medida para `130/70-17` encontrou produto com preco/estoque.
- `190/50R17` e `190/55R17` foram reconhecidos como medidas distintas.

Bloqueios importantes:

- Varios bloqueios foram corretos: o Generator tentou mencionar estoque sem
  `verificarEstoque` ou valor sem a tool de preco disponivel no turno/contexto
  aceito pelo validator.
- Casos `XJ6`, `Fan 2019`, `Fan 2026`, `Zontes R310`, `130/70-17` e `190`
  expuseram que o Generator ainda tenta verbalizar preco/estoque antes de
  reunir exatamente as evidencias que o SayValidator exige.
- Houve bloqueios `action_blocked:item_not_found` quando o Generator tentou
  criar item e registrar oferta no mesmo turno de forma que o ActionValidator
  nao aceitou.
- Houve 2 falhas `generator_llm_failed:Unterminated string in JSON`, ambas
  bloqueadas sem envio ao cliente.

Conclusao da rodada:

- O pipeline ponta a ponta esta vivo: Chatwoot -> webhook -> Organizadora ->
  Planner -> Atendente/Generator.
- O catalogo ja serve para shadow, porque os guardrails seguraram respostas
  arriscadas.
- Ainda nao ligar envio real ao cliente antes de corrigir:
  1. Planner/Generator para estoque: quando cliente pergunta estoque, chamar
     `verificarEstoque` antes de qualquer frase de disponibilidade.
  2. Planner/Generator para preco: garantir `buscarProduto` recente quando a
     resposta menciona valor, especialmente apos `verificarEstoque`.
  3. Fluxo de actions: revisar `record_offer` no mesmo turno de `create_item`
     para nao cair em `action_blocked:item_not_found`.
  4. Organizadora: investigar o schema mismatch no caso de mudanca de opiniao
     `140/70-17` -> `130/70-17`.

## Re-run catalog15 pos-fixes do Generator/validator

Data: 2026-05-14.

Run: `catalog15-rerun-20260514160252`.

Escopo:

- 15 conversas criadas no Chatwoot: conversas `516` a `530`.
- 45 mensagens incoming de cliente.
- Mesma matriz de casos da rodada `catalog15-20260514125728`.

Resumo tecnico:

- Mensagens normalizadas em `core.*`: 45/45.
- Jobs da Atendente: 45/45 processados.
- Turns da Atendente: 45/45 finalizados.
- Organizadora: 15/15 jobs finalizados com sucesso.
- Incidentes da Organizadora: 0.
- Respostas geradas: 36.
- Respostas bloqueadas: 9.

Comparativo contra a rodada anterior:

- Bloqueios totais: 13 -> 9.
- Respostas geradas: 32 -> 36.
- Organizadora finalizada: 14/15 -> 15/15.
- `action_blocked:item_not_found`: 4 -> 0.
- `money_mentioned_without_tool_result`: 6 -> 0.
- Falhas `evidence_not_literal`/metadata da Organizadora: corrigidas na rodada.
- Falhas `generator_llm_failed:Unterminated string`: 2 -> 2, ainda abertas.

Bloqueios remanescentes:

- 1 `money_not_supported_by_tool_result:79`: resposta usou preco antigo depois
  de `verificarEstoque` + `buscarPoliticaComercial`, sem `buscarProduto` no
  turno corrente.
- 2 `fitment_claim_without_buscar_compatibilidade`: respostas cautelosas ainda
  acionaram o validator de compatibilidade.
- 2 `generator_llm_failed:Unterminated string`: o aumento para `maxTokens=1500`
  ainda nao eliminou truncamento/JSON invalido em caso com dois pneus.
- 1 `stock_claim_without_verificar_estoque`: resposta falou em pronta entrega
  ou disponibilidade sem `verificarEstoque`.
- 1 `generator_schema_failed` por `set_by_message_id` sem UUID valido.
- 1 `mixed_safe_fallback_with_other_content`: resposta misturou fallback seguro
  com conteudo adicional.
- 1 `policy_claim_without_tool_result`: resposta falou que aceita cartao sem
  `buscarPoliticaComercial` no turno.

Conclusao do re-run:

- Os fixes deterministas funcionaram: o problema de `item_not_found` no mesmo
  turno foi zerado.
- A Organizadora ficou estavel nesta bateria.
- O Generator ainda precisa de ajuste em evidencias frescas por tipo de frase:
  preco, estoque, politica comercial e compatibilidade.
- A proxima fase deve atacar primeiro os bloqueios simples de schema/fallback e
  depois os casos de evidencia historica vs evidencia do turno corrente.

## Re-run catalog15 com Planner 5.4

Data: 2026-05-14.

Run: `catalog15-rerun-20260514183715`.

Escopo:

- 15 conversas criadas no Chatwoot: conversas `531` a `545`.
- 45 mensagens incoming de cliente.
- Mesma matriz de casos das rodadas anteriores.
- Mudanca isolada esperada: Planner usando modelo 5.4 em vez de 5.4-mini.

Resumo tecnico:

- Mensagens normalizadas em `core.*`: 45/45.
- Jobs da Atendente: 45/45 processados.
- Turns da Atendente: 45/45 finalizados.
- Respostas geradas: 41.
- Respostas bloqueadas: 4.
- Organizadora: 15/15 finalizados.

Comparativo:

- Rodada original: 32 geradas / 13 bloqueadas.
- Pos-fixes com Planner anterior: 36 geradas / 9 bloqueadas.
- Planner 5.4: 41 geradas / 4 bloqueadas.

Ferramentas chamadas na rodada Planner 5.4:

- `buscarCompatibilidade`: 19.
- `buscarProduto`: 17.
- `verificarEstoque`: 9.
- `buscarPoliticaComercial`: 3.
- `calcularFrete`: 1.

Bloqueios remanescentes:

- 3 bloqueios ficaram concentrados no caso `dois_pneus_fan2019`, com duas
  medidas no mesmo atendimento. O Planner chamou ferramentas mais adequadas
  (`buscarProduto`, `buscarCompatibilidade`, `verificarEstoque`), mas o
  Generator ainda produziu JSON truncado ou actions demais.
- 1 bloqueio em `frete_pagamento_depois_produto`: resposta de entrega baseada
  em politica comercial foi barrada por `delivery_claim_without_calcular_frete`.

Leitura da rodada:

- A troca para Planner 5.4 melhorou fortemente a escolha de ferramentas.
- Os bloqueios de preco antigo, politica sem tool, estoque sem tool e
  compatibilidade sem tool praticamente sairam da rodada.
- O gargalo principal passou a ser o Generator: saida JSON longa, limite de
  actions e caso multi-item.
- O unico ponto ainda ambivalente no Planner e logistica: pergunta de entrega
  pode precisar decidir entre `calcularFrete` e politica comercial sem gerar
  claim de entrega concreta.

## Tentativa catalog15 com Generator 5.5

Data: 2026-05-14.

Run: `catalog15-rerun-20260514190355`.

Escopo:

- 15 conversas criadas no Chatwoot: conversas `546` a `560`.
- 45 mensagens incoming de cliente.
- Planner mantido em 5.4.
- Generator configurado para 5.5.

Resultado:

- Jobs da Atendente: 45/45 processados.
- Turns da Atendente: 45/45 bloqueados.
- Motivo unico dos 45 bloqueios: erro HTTP 400 da OpenAI.

Erro:

```text
Unsupported value: 'temperature' does not support 0.2 with this model.
Only the default (1) value is supported.
```

Leitura:

- Esta rodada nao mede qualidade do Generator 5.5.
- O teste revelou incompatibilidade de configuracao: o codigo/prompt client
  envia `temperature: 0.2`, mas o modelo 5.5 exige o valor padrao.
- Antes de comparar qualidade/custo do 5.5, ajustar o client para omitir
  `temperature` quando o modelo nao aceitar esse parametro, ou usar `1`.

## Segunda tentativa catalog15 com Generator 5.5

Data: 2026-05-14.

Run: `catalog15-rerun-20260514192442`.

Escopo:

- 15 conversas criadas no Chatwoot: conversas `561` a `575`.
- 45 mensagens incoming de cliente.
- Tentativa apos correcao local para omitir `temperature` em `gpt-5.5`.

Resultado:

- Jobs da Atendente: 45/45 processados.
- Organizadora: 15/15 finalizados.
- Turns da Atendente: 45/45 bloqueados.
- Motivo unico dos 45 bloqueios: mesmo erro HTTP 400 de `temperature: 0.2`.

Leitura:

- Esta segunda tentativa tambem nao mede qualidade do Generator 5.5.
- Como o mesmo erro persistiu, a infra que processou a bateria ainda estava
  rodando imagem/codigo antigo, ou o deploy nao incluiu a correcao local.
- Proximo passo: commitar/pushar/deployar a correcao de `temperature` e so
  depois repetir a bateria.

## Re-run catalog15 valido com Generator 5.5

Data: 2026-05-14.

Run: `catalog15-rerun-20260514195519`.

Escopo:

- 15 conversas criadas no Chatwoot: conversas `591` a `605`.
- 45 mensagens incoming de cliente.
- Deploy confirmado no commit `2b758f2`, com `temperature` omitido para
  `gpt-5.5`.

Resultado:

- Jobs da Atendente: 45/45 processados.
- Turns da Atendente: 45/45 finalizados.
- Organizadora: 14/15 finalizados no momento da auditoria.
- Respostas geradas: 28.
- Respostas bloqueadas: 17.

Comparativo direto:

- Planner 5.4 + Generator anterior: 41 geradas / 4 bloqueadas.
- Planner 5.4 + Generator 5.5 valido: 28 geradas / 17 bloqueadas.

Bloqueios do Generator 5.5:

- 13 `generator_llm_failed:openai: empty content in response`.
- 3 `stock_claim_without_verificar_estoque`.
- 1 `generator_schema_failed` por `set_by_message_id` sem UUID valido.

Tokens e tempo do Generator:

- Generator anterior: media ~5,3s por turno, ~4.532 input tokens e ~418 output
  tokens por turno.
- Generator 5.5: media ~16,2s por turno, ~3.134 input tokens e ~658 output
  tokens por turno.

Leitura:

- A integracao atual com 5.5 nao ficou melhor; ficou mais lenta e bloqueou
  mais.
- O erro de `temperature` foi corrigido, mas apareceu outro problema de
  integracao/compatibilidade: varias chamadas retornaram sem `message.content`.
- Nao recomendar Generator 5.5 como default neste momento.
- Manter Planner 5.4 e Generator anterior por enquanto. Se 5.5 voltar a ser
  avaliado, antes adaptar o client para o formato/resposta esperado pelo modelo
  e criar teste isolado de uma chamada simples.

---

## Atualizacao 2026-05-15 — Rerun pos-mudancas

Apos as 12 mudancas desta janela (commits `4963701` a `6f7e7c5`), incluindo
Planner-input fix, Etapa 2 structured claims, Etapa 3 limpeza de regex do
Planner, B4/B5 pre-shadow, e v1.5.0 few-shot atras de feature flag, uma nova
rodada do catalog15 mostrou recuperacao significativa.

### Com GENERATOR_PROMPT_FEW_SHOT_ENABLED=true (v1.5.0 ativo)

| Metrica | Antes (v1.4 pos-claims) | Agora (v1.5 few-shot) |
|---|---:|---:|
| Generated | 43/45 | 45/45 |
| Blocked | 2/45 | 0/45 |
| Safe fallback exato | 6 | 2 |
| buscarProduto -> produto | 100% (25/25) | 100% (25/25) |
| verificarEstoque chamadas | 34 | 39 |
| buscarCompatibilidade | 20 | 21 |
| Adocao de claims | 64.4% | 64.4% |
| Media claims/turn | 1.36 | 1.40 |
| Input medio Generator (tokens) | 7187 | 7068 |
| Output medio (tokens) | 402 | 347 |

Bateria custom 8 casos coloquiais (2026-05-15):
- 8/8 generated, 0 blocked
- Cobre: "tem ai?", "vc traz em Belford Roxo?", "pega na minha Bros?",
  "ta salgado?", "dois pneus, quanto cada e tem?", "ia querer X, mas e Y",
  "pode separar, pago pix, busco hoje"
- Falha residual em 1 caso ("ta salgado"): Planner falhou em rotear pra
  tratar_objecao; nao e bug do Generator

Notas pos-deploy:
- Planner: 9/10
- Generator: 9/10 provisorio
- Organizadora: 8.5/10 provisorio
- Sistema geral: 8.3/10

Sistema continua nao pronto para envio automatico. Proxima fase: coleta humana
(ADR-008).

> Nota: numeros de verificarEstoque/buscarCompatibilidade corrigidos em
> 2026-05-15 apos revisao final do Codex. Versao anterior do append tinha
> 38/18 (medicao intermediaria); medicao final consolidada eh 39/21.

