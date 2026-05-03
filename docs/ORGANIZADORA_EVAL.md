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
