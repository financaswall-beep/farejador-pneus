# Avaliacao da Organizadora

Este documento define como medir a qualidade da Organizadora antes de alterar o prompt.

## Objetivo

Medir o prompt atual contra uma matriz fixa de conversas sinteticas e registrar:

- status do job;
- fatos obrigatorios extraidos;
- fatos obrigatorios ausentes;
- fatos opcionais extraidos;
- fatos proibidos extraidos;
- casos em que zero facts e correto;
- estimativa aproximada de tokens do prompt por conversa.

## Matriz

A matriz viva fica em:

- `scripts/organizadora-eval-cases.cjs`

Cada cenario tem:

- `messages`: mensagens enviadas como cliente;
- `required`: fatos que devem ser extraidos;
- `optional`: fatos aceitaveis, mas nao obrigatorios;
- `forbidden`: fatos que indicam inferencia errada;
- `allowZeroFacts`: quando `true`, zero facts e resultado correto.

## Runner

Executar baseline:

```powershell
node --env-file=.env scripts\rodar-baseline-organizadora.cjs --limit=32 --force-ready
```

Rodar amostra pequena:

```powershell
node --env-file=.env scripts\rodar-baseline-organizadora.cjs --limit=3 --force-ready
```

## Interpretacao

Um caso passa quando:

- o job termina `done`;
- todos os `required` aparecem;
- nenhum `forbidden` aparece;
- zero facts aparece apenas quando `allowZeroFacts=true`.

`optional` nao reprova. Ele serve para ver ganhos ou perdas finas entre versoes de prompt.

## Proxima etapa

Depois do baseline, criar prompt v2 enxuto com foco em:

- tabela curta de `intencao_cliente`;
- localizacao RJ: bairro vs municipio;
- garantia e reclamacao;
- correcoes do cliente;
- quando zero facts e correto.

## Baseline 2026-05-03

Runner:

```powershell
$env:FAREJADOR_ENV='prod'
node --env-file=.env scripts\rodar-baseline-organizadora.cjs --limit=32 --force-ready --jobTimeoutMs=360000
```

Resumo:

- Casos avaliados: 32.
- Passaram: 10.
- Falharam: 22.
- Jobs `done`: 31.
- Jobs ausentes/timeout: 1.
- Jobs `failed`: 0.
- Casos com zero facts: 5.
- Zero facts correto: 2.
- Estimativa media de prompt por conversa: 557 tokens.

Principais fatos obrigatorios ausentes:

| fact_key | ausencias |
| --- | ---: |
| `intencao_cliente` | 13 |
| `motivo_compra` | 2 |
| `urgencia` | 2 |
| `produto_recusado_motivo` | 2 |
| `nome_cliente` | 1 |
| `moto_modelo` | 1 |
| `posicao_pneu` | 1 |
| `medida_pneu` | 1 |
| `bairro_mencionado` | 1 |
| `modalidade_entrega` | 1 |
| `preferencia_principal` | 1 |
| `produto_aceito` | 1 |
| `moto_uso` | 1 |
| `forma_pagamento` | 1 |

Achados:

- O maior buraco do prompt atual e `intencao_cliente`.
- Os casos de zero facts correto (`S31`, `S32`) passaram.
- O caso vago comercial `S23` falhou corretamente na avaliacao: zero facts foi considerado erro porque havia intencao comercial.
- `S03` classificou `Campo Grande` como `municipio_mencionado`; esperado no contexto RJ era `bairro_mencionado`.
- `S13` garantia gerou zero facts, mas deveria extrair `intencao_cliente`.
- `S14` reclamacao extraiu `urgencia`, mas nao `intencao_cliente`.
- `S17`, `S18` e `S19` mostram fragilidade em aceite/recusa/desfecho.
- `S01` foi capturado em `core.*`, mas nao teve job criado em `ops.enrichment_jobs`; precisa investigacao operacional separada do prompt.

Implicacao para prompt v2:

- Nao precisa de prompt enorme.
- Adicionar uma tabela curta de mapeamento para `intencao_cliente`.
- Explicitar garantia/reclamacao.
- Explicitar bairro vs municipio no RJ.
- Explicitar quando zero facts e correto.
- Explicitar desfechos: aceite, recusa por preco, comprou concorrente.

## Prompt v2

Implementado em `src/organizadora/prompt.ts`.

Decisao de versao:

- `schema_version` continua `moto-pneus-v1`, porque a whitelist e o formato dos facts nao mudaram.
- `extractor_version` passa a ser `moto-pneus-prompt-v2`, para separar resultados do prompt antigo e do novo no ledger.

Mudancas do prompt:

- tabela curta para `intencao_cliente`;
- regra de localizacao RJ para bairro vs municipio;
- garantia e reclamacao explicitas;
- desfecho comercial: aceite, recusa por preco, comprou concorrente;
- correcoes com `truth_type="corrected"`;
- regra de quando zero facts e correto;
- normalizacao tolerante de medida de pneu.

Estimativa de custo:

- baseline v1 registrado: media aproximada de 557 tokens de prompt por conversa;
- runner atualizado para v2: estimativa fixa aproximada de 1350 tokens + transcricao.

## Resultado v2 2026-05-03

Deploy usado:

- Commit: `54d8886 feat: add organizadora prompt v2 eval`.
- `extractor_version` confirmado no banco: `moto-pneus-prompt-v2`.

Runner:

```powershell
$env:FAREJADOR_ENV='prod'
node --env-file=.env scripts\rodar-baseline-organizadora.cjs --limit=32 --force-ready --jobTimeoutMs=360000
```

Resumo v2:

- Casos avaliados: 32.
- Passaram: 20.
- Falharam: 12.
- Jobs `done`: 30.
- Jobs ausentes/timeout: 2.
- Jobs `failed`: 0.
- Casos com zero facts: 5.
- Zero facts correto: 2.
- Estimativa media de prompt por conversa: 1382 tokens.
- Facts gravados: 100, todos com `extractor_version='moto-pneus-prompt-v2'`.

Comparativo v1 -> v2:

| metrica | v1 | v2 | delta |
| --- | ---: | ---: | ---: |
| casos aprovados | 10 | 20 | +10 |
| casos reprovados | 22 | 12 | -10 |
| jobs `done` | 31 | 30 | -1 |
| jobs ausentes/timeout | 1 | 2 | +1 |
| zero facts correto | 2 | 2 | 0 |
| media estimada de tokens | 557 | 1382 | +825 |
| ausencias de `intencao_cliente` | 13 | 1 | -12 |

Principais fatos obrigatorios ausentes no v2:

| fact_key | ausencias |
| --- | ---: |
| `modalidade_entrega` | 3 |
| `urgencia` | 3 |
| `moto_uso` | 2 |
| `faixa_preco_desejada` | 2 |
| `forma_pagamento` | 2 |
| `perguntou_entrega_hoje` | 2 |
| `motivo_compra` | 1 |
| `preferencia_principal` | 1 |
| `produto_recusado_motivo` | 1 |
| `nome_cliente` | 1 |
| `bairro_mencionado` | 1 |
| `medida_pneu` | 1 |
| `moto_modelo` | 1 |
| `posicao_pneu` | 1 |
| `intencao_cliente` | 1 |

Leitura:

- O prompt v2 resolveu quase todo o problema de `intencao_cliente`.
- Garantia, reclamacao, compatibilidade, pedido vago comercial e municipio passaram a se comportar melhor.
- O custo estimado subiu de ~557 para ~1382 tokens por conversa.
- Os novos gargalos sao `modalidade_entrega`, `urgencia`, `moto_uso`, `faixa_preco_desejada` e pagamento misto.
- Dois casos (`S08`, `S24`) foram capturados em `core.*`, mas nao tiveram job em `ops.enrichment_jobs`; isso deve ser investigado como problema operacional de enfileiramento, separado do prompt.

## Hibrido v3

Implementado depois do resultado v2.

Decisao:

- `schema_version` continua `moto-pneus-v1`.
- `extractor_version` passa a ser `moto-pneus-hybrid-v3`.
- Facts gerados por regra literal usam `source='deterministic_literal_organizadora_v1'`.
- Facts gerados pela LLM continuam usando `source='llm_openai_organizadora_v1'`.

Regras deterministicas adicionadas:

- `forma_pagamento`:
  - `pix` -> `pix`;
  - `dinheiro` -> `dinheiro`;
  - `boleto` -> `boleto`;
  - `credito/credito com acento` -> `cartao_credito`;
  - `debito/debito com acento` -> `cartao_debito`;
  - `cartao/cartao com acento` sem tipo claro -> `indefinido`;
  - pagamento misto, como `pix` + `cartao`, -> `indefinido`.
- `modalidade_entrega`:
  - `entrega`, `entregar`, `frete` -> `entrega`;
  - `retirar`, `retirada`, `buscar na loja`, `pegar na loja` -> `retirada`.

Exclusoes intencionais:

- `motoboy` nao gera `modalidade_entrega`, porque pode significar uso/profissao do cliente.
- `delivery` tambem nao gera `modalidade_entrega`, pelo mesmo motivo.

Comportamento conservador:

- As regras so complementam facts ausentes; se a LLM ja extraiu a chave, o codigo nao duplica.
- As regras usam apenas mensagens do cliente (`sender_type='contact'`).

Prompt ajustado no v3:

- removeu o peso de pagamento/entrega da tarefa principal;
- deixou claro que pagamento e entrega literais sao complementados em codigo;
- adicionou poucas linhas para `faixa_preco_desejada`, `urgencia`, `moto_uso` e recusa por preco.

Estimativa:

- runner atualizado para v3: estimativa fixa aproximada de 1460 tokens + transcricao.

## Resultado v3 2026-05-03

Deploy usado:

- Commit: `8e4c886 feat: add organizadora hybrid literals`.
- `extractor_version` confirmado no banco: `moto-pneus-hybrid-v3`.

Resumo v3:

- Casos avaliados: 32.
- Passaram: 25.
- Falharam: 7.
- Jobs `done`: 31.
- Jobs com timeout/ausentes: 1.
- Jobs `failed`: 0.
- Zero facts: 3.
- Zero facts correto: 2.
- Estimativa media de prompt por conversa: 1492 tokens.

Comparativo v2 -> v3:

| metrica | v2 | v3 | delta |
| --- | ---: | ---: | ---: |
| casos aprovados | 20 | 25 | +5 |
| casos reprovados | 12 | 7 | -5 |
| jobs `done` | 30 | 31 | +1 |
| jobs ausentes/timeout | 2 | 1 | -1 |
| zero facts correto | 2 | 2 | 0 |
| media estimada de tokens | 1382 | 1492 | +110 |

Principais fatos obrigatorios ausentes no v3:

| fact_key | ausencias |
| --- | ---: |
| `motivo_compra` | 2 |
| `moto_modelo` | 1 |
| `modalidade_entrega` | 1 |
| `preferencia_principal` | 1 |
| `perguntou_entrega_hoje` | 1 |
| `forma_pagamento` | 1 |

Leitura:

- O hibrido melhorou a matriz sem transformar o prompt em um texto gigante.
- `forma_pagamento` e `modalidade_entrega` melhoraram, mas duas falhas revelaram um bug de ordem: quando a LLM retornava a chave com valor invalido, o codigo deterministico pulava a complementacao.
- Exemplo: LLM retornou `modalidade_entrega="retirar na loja"`; o schema aceita apenas `retirada`, entao o fact era rejeitado.
- Exemplo: LLM retornou `forma_pagamento="metade pix metade cartao"`; o schema aceita `indefinido`, entao o fact era rejeitado.

## Hibrido v3.1

Correcoes implementadas depois da rodada v3:

- `extractor_version` passa a ser `moto-pneus-hybrid-v3-1`.
- O codigo deterministico agora so considera uma chave "ja existente" se o valor da LLM tambem for valido no schema.
- Se a LLM trouxer `modalidade_entrega` ou `forma_pagamento` com valor invalido, a regra literal ainda pode complementar com valor valido.
- Mantida a restricao: hibrido somente para `forma_pagamento` e `modalidade_entrega`.

## Resultado v3.1 2026-05-03

Deploy usado:

- Commit: `f838881 fix: complement invalid organizadora literals`.
- `extractor_version` confirmado no banco: `moto-pneus-hybrid-v3-1`.

Resumo bruto da rodada:

- Casos avaliados: 32.
- Passaram: 25.
- Falharam: 7.
- Jobs `done`: 30.
- Jobs com timeout/ausentes: 2.
- Jobs `failed`: 0.
- Estimativa media de prompt por conversa: 1492 tokens.

Observacao operacional:

- Dois casos foram capturados em `core.*`, mas nao tiveram job criado inicialmente em `ops.enrichment_jobs`.
- Esses dois foram re-enfileirados manualmente com `ops.enqueue_enrichment_job` para medir a Organizadora sem misturar falha operacional de fila.

Resumo apos re-enfileirar os 2 jobs ausentes:

- Casos com job `done`: 32.
- Passaram: 27.
- Falharam: 5.

Comparativo v2 -> v3 -> v3.1:

| metrica | v2 | v3 | v3.1 apos reenqueue |
| --- | ---: | ---: | ---: |
| casos aprovados | 20 | 25 | 27 |
| casos reprovados | 12 | 7 | 5 |
| jobs `done` finais | 30 | 31 | 32 |
| media estimada de tokens | 1382 | 1492 | 1492 |

Falhas restantes da extracao:

| caso | faltou |
| --- | --- |
| `S08-uso-delivery-urgente` | `motivo_compra` |
| `S14-reclamacao` | `urgencia` |
| `S16-preco-alvo` | `preferencia_principal` |
| `S22-viagem-seguranca` | `motivo_compra` |
| `S25-erros-digitacao` | `perguntou_entrega_hoje` |

Leitura:

- A correcao v3.1 resolveu os casos de `retirada` e `pagamento misto` sem aumentar o prompt.
- As 5 falhas restantes sao mais de interpretacao semantica do prompt/schema, nao das regras deterministicas de pagamento/entrega.
- Ainda existe um problema separado de enfileiramento: algumas conversas sao capturadas em `core.*`, mas nao geram job da Organizadora.

## Auditoria do enfileiramento 2026-05-03

Commit de auditoria:

- `87e1a88 test: audit organizadora enqueue path`.

Mudancas:

- `message_created` agora registra log quando enfileira job da Organizadora, incluindo `raw_event_id`, `conversation_id`, `message_id` e `enrichment_job_id`.
- Se `ORGANIZADORA_ENABLED=false`, o normalizador registra aviso explicito em vez de pular silenciosamente.
- Testes unitarios cobrem os dois caminhos: enfileira quando ligado, pula com aviso quando desligado.

Validacao local:

- `npm run typecheck`: passou.
- `npm run build`: passou.
- `npm test`: 267 testes passaram.

Rodada curta apos deploy:

- 8 casos avaliados.
- Jobs `done`: 8.
- Jobs ausentes/timeout: 0.
- Passaram: 7.
- Falha restante: `S08`, faltando `motivo_compra`.

Rodada completa apos deploy:

- 32 casos avaliados.
- Jobs `done`: 32.
- Jobs ausentes/timeout: 0.
- Jobs `failed`: 0.
- Passaram: 28.
- Falharam: 4.
- Zero facts: 2.
- Zero facts correto: 2.
- Estimativa media de prompt por conversa: 1492 tokens.

Falhas restantes:

| caso | faltou |
| --- | --- |
| `S08-uso-delivery-urgente` | `motivo_compra` |
| `S16-preco-alvo` | `preferencia_principal` |
| `S22-viagem-seguranca` | `motivo_compra` |
| `S25-erros-digitacao` | `perguntou_entrega_hoje` |

Leitura:

- O problema operacional de job ausente nao apareceu na rodada completa apos a auditoria: 32/32 jobs foram criados e concluidos.
- O gargalo atual voltou a ser somente semantico, concentrado em 4 padroes.
- A proxima melhoria deve ser pequena e focada: `motivo_compra`, `preferencia_principal` e `perguntou_entrega_hoje`.

## Prompt v3.2 enxuto

Implementado para atacar somente as 4 falhas semanticas restantes da rodada 28/32.

Decisao:

- `schema_version` continua `moto-pneus-v1`.
- `extractor_version` passa a ser `moto-pneus-hybrid-v3-2`.
- O prompt principal subiu de 69 para 73 linhas.
- O arquivo `src/organizadora/prompt.ts` subiu de 142 para 146 linhas.

Regras adicionadas:

- `pneu furou` / `furou agora` -> `motivo_compra = "pneu_furou"`.
- `pneu careca` -> `motivo_compra = "pneu_careca"`.
- `vou viajar` / `viajar sexta` -> `motivo_compra = "viagem_proxima"`.
- `delivery` como uso do cliente -> `motivo_compra = "delivery_app"`.
- `barato` / `bom mas barato` -> `preferencia_principal = "preco"`.
- `qualidade` -> `preferencia_principal = "qualidade"`.
- `tem hj?`, `tem hoje?`, `entrega hj?`, `chega hoje?` -> `perguntou_entrega_hoje = true`.

Validacao local:

- `npm run typecheck`: passou.
- `npm run build`: passou.
- `npm test`: 267 testes passaram.

## Resultado v3.2 2026-05-03

Deploy usado:

- Commit: `6a36aee feat: tune organizadora prompt v3.2`.
- `extractor_version` confirmado no banco: `moto-pneus-hybrid-v3-2`.

Resumo bruto da rodada:

- Casos avaliados: 32.
- Passaram: 29.
- Falharam: 3.
- Jobs `done`: 31.
- Jobs ausentes/timeout: 1.
- Jobs `failed`: 0.
- Zero facts: 3.
- Zero facts correto: 2.
- Estimativa media de prompt por conversa: 1492 tokens.

Observacao operacional:

- `S24-mensagem-unica-densa` foi capturado em `core.*`, mas nao teve job inicial em `ops.enrichment_jobs`.
- O caso foi re-enfileirado manualmente com `ops.enqueue_enrichment_job` para medir a extracao sem misturar falha operacional.

Resumo apos re-enfileirar o job ausente:

- Casos com job `done`: 32.
- Passaram: 30.
- Falharam: 2.

Comparativo recente:

| metrica | v3.1 apos reenqueue | pos-auditoria | v3.2 apos reenqueue |
| --- | ---: | ---: | ---: |
| casos aprovados | 27 | 28 | 30 |
| casos reprovados | 5 | 4 | 2 |
| jobs `done` finais | 32 | 32 | 32 |
| media estimada de tokens | 1492 | 1492 | 1492 |

Falhas restantes:

| caso | faltou | fatos extraidos |
| --- | --- | --- |
| `S08-uso-delivery-urgente` | `moto_uso` | `motivo_compra`, `urgencia` |
| `S22-viagem-seguranca` | `urgencia` | `motivo_compra`, `preferencia_principal` |

Leitura:

- O v3.2 corrigiu `S16-preco-alvo` e `S25-erros-digitacao`.
- O v3.2 tambem corrigiu `motivo_compra` em `S08` e `S22`.
- Restam 2 ajustes semanticos pequenos: `delivery` como `moto_uso = "trabalho"` e `vou viajar sexta` como `urgencia = "media"` ou `alta`, conforme regra escolhida.
- Ainda apareceu 1 caso operacional sem job inicial, entao a auditoria de enfileiramento continua util para diagnosticar recorrencia.

## Matriz expandida 48 casos 2026-05-03

Foram adicionados 16 novos cenarios (`S33` a `S48`) para testar generalizacao sem mexer no prompt v3.2:

- uso por app/trabalho;
- retirada com debito;
- compra sem modelo;
- correcao de posicao;
- garantia com marca;
- reclamacao de entrega atrasada;
- credito/parcelamento;
- municipio com bairro;
- audio sem transcricao seguido de texto util;
- zero facts por agradecimento;
- recusa e preferencia de marca;
- preco de concorrente sem recusa final;
- urgencia para amanha;
- par de pneus;
- cartao generico;
- marca e medida sem moto.

Resultado bruto:

- Casos avaliados: 48.
- Passaram: 39.
- Falharam: 9.
- Jobs `done`: 48.
- Jobs ausentes/timeout: 0.
- Jobs `failed`: 0.
- Zero facts: 3.
- Zero facts correto: 3.
- Estimativa media de prompt por conversa: 1491 tokens.

Comparativo de aproveitamento:

| matriz | passaram | total | aproveitamento |
| --- | ---: | ---: | ---: |
| v3.2 original | 30 | 32 | 93.75% |
| v3.2 expandida | 39 | 48 | 81.25% |
| apenas novos casos | 9 | 16 | 56.25% |

Falhas da matriz expandida:

| caso | faltou | observacao |
| --- | --- | --- |
| `S08-uso-delivery-urgente` | `moto_uso` | ja era falha conhecida; extraiu `motivo_compra` e `urgencia`. |
| `S09-parcelamento` | `intencao_cliente` | extraiu pagamento, parcelamento e desconto; faltou intencao comercial. |
| `S11-ano-cilindrada` | `moto_ano` | extraiu modelo e posicao; perdeu ano `2020`. |
| `S22-viagem-seguranca` | `urgencia` | ja era falha conhecida; extraiu motivo e preferencia. |
| `S37-garantia-com-marca` | `marca_pneu_preferida` | extraiu `produto_oferecido=Technic`; expectativa pode ser discutivel porque marca foi citada em garantia, nao como preferencia. |
| `S38-reclamacao-atraso-entrega` | `modalidade_entrega` | extraiu reclamacao, urgencia e entrega hoje; perdeu modalidade. |
| `S39-pagamento-credito-parcelado` | `produto_aceito` | extraiu pagamento, parcelamento e intencao; aceite era condicional. |
| `S44-preco-concorrente-sem-recusa` | `produto_aceito` | extraiu preco concorrente, desconto e intencao; aceite era condicional. |
| `S46-quantidade-casal` | `posicao_pneu` | extraiu quantidade, modelo e cilindrada; nao gerou posicao para dianteiro+traseiro. |

Leitura:

- A Organizadora segue estavel operacionalmente: 48/48 jobs concluidos.
- A qualidade nao se manteve no mesmo patamar quando a matriz ficou mais diversa.
- Parte das falhas e prompt/schema; parte sao expectativas de avaliador que podem estar rigorosas demais, principalmente `S37`, `S39` e `S44`.
- Proximo passo recomendado: antes de mexer no prompt, revisar se os `required` desses novos casos representam fatos obrigatorios mesmo ou se alguns devem virar opcionais.

## Prompt v3.3 enxuto

Implementado depois da matriz expandida de 48 casos.

Decisao:

- `schema_version` continua `moto-pneus-v1`.
- `extractor_version` passa a ser `moto-pneus-hybrid-v3-3`.
- A mudanca segue enxuta: poucas linhas de prompt, sem exemplos longos.
- A matriz tambem foi ajustada onde o avaliador estava exigindo fato discutivel.

Ajustes de avaliador:

- `S37-garantia-com-marca`: `marca_pneu_preferida` virou opcional, porque a marca citada em garantia nao significa preferencia de compra.
- `S39-pagamento-credito-parcelado`: `produto_aceito` virou opcional, porque o aceite depende da condicao de parcelar.
- `S44-preco-concorrente-sem-recusa`: `produto_aceito` virou opcional, porque o aceite depende de cobrir o preco concorrente.

Regras adicionadas ao prompt:

- `delivery`, `ifood` e uso por app como `moto_uso`;
- viagem/estrada/amanha como `urgencia` media;
- pagamento, desconto e parcelamento como indicio de `intencao_cliente`;
- modelo seguido de ano como `moto_ano`;
- `par`, `os dois pneus`, `dianteiro e traseiro` como `quantidade_pneus=2` e `posicao_pneu=ambos`.

Objetivo:

- Atacar casos comuns e faceis (`S08`, `S09`, `S11`, `S22`, `S46`);
- Deixar casos raros ou semanticamente discutiveis fora da cobranca dura;
- Manter o prompt pequeno para nao inflar custo de tokens.

## Resultado v3.3 2026-05-03

Deploy usado:

- Commit: `7beb37c feat: tune organizadora prompt v3.3`.
- `extractor_version` observado nos facts: `moto-pneus-hybrid-v3-3`.

Rodada:

```powershell
$env:FAREJADOR_ENV='prod'
node --env-file=.env scripts\rodar-baseline-organizadora.cjs --limit=48 --force-ready --jobTimeoutMs=360000
```

Observacao operacional:

- A injecao dos 48 casos ocorreu, mas a primeira espera estourou antes da fila drenar.
- Foi necessario criar 1 job ausente (`S24`) e liberar pendentes do mesmo batch de teste para medir qualidade da Organizadora sem misturar problema de fila.
- Resultado final apos a fila drenar: 48/48 jobs `done`, 0 jobs `failed`.

Resumo final:

- Casos avaliados: 48.
- Passaram: 46.
- Falharam: 2.
- Jobs `done`: 48.
- Jobs ausentes/timeout: 0.
- Jobs `failed`: 0.

Comparativo:

| matriz | passaram | total | aproveitamento |
| --- | ---: | ---: | ---: |
| v3.2 expandida | 39 | 48 | 81.25% |
| v3.3 expandida | 46 | 48 | 95.83% |

Falhas restantes:

| caso | faltou | leitura |
| --- | --- | --- |
| `S14-reclamacao` | `urgencia` | Extraiu `intencao_cliente`; "preciso resolver isso" ficou fraco para urgencia. |
| `S38-reclamacao-atraso-entrega` | `modalidade_entrega` | Extraiu `intencao_cliente` e `urgencia`; nao marcou entrega em "falaram que entregava ontem". |

Leitura:

- O v3.3 recuperou a generalizacao da matriz expandida sem inflar muito o prompt.
- As falhas restantes sao pequenas e podem ser tratadas depois com regra enxuta ou ajuste da regua, se forem frequentes em conversa real.
- A parte operacional ainda merece observacao: apareceu novamente 1 conversa capturada sem job inicial.
