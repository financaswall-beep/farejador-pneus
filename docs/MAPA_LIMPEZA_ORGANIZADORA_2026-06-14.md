# Mapa de limpeza — Organizadora (V1) × Analytics que funciona

**Data:** 2026-06-14 · **Objetivo:** separar o peso morto do V1 (pode cortar) do analytics determinístico que funciona (NÃO tocar), pra limpar sem quebrar nada. Levantado por leitura de código + medição do banco de prod.

## TL;DR
- O analytics que **funciona** é um **motor de REGRAS determinístico** (`src/enrichment/`) — grava fatos/etiquetas/hints automático, em tempo real.
- A **Organizadora** (camada de IA do V1) está **morta**: a fila nem existe em prod, o código que a consome é órfão, e **zero** dados vieram dela.
- **Boa notícia:** vivo e morto estão em **arquivos diferentes** → corte limpo, sem desentrelaçar.

---

## 🟢 VIVO — NÃO TOCAR (é o analytics que funciona)

### Código — `src/enrichment/` (motor de regras determinístico)
| arquivo | papel |
|---|---|
| `cli.ts` | entry (`npm run enrich`), orquestra os 3 passos |
| `rules.engine.ts` · `rules.loader.ts` · `rules.types.ts` | o motor de regras |
| `facts.repository.ts` | grava `analytics.conversation_facts` |
| `classifications.repository.ts` · `classification.service.ts` | grava `analytics.conversation_classifications` |
| `hints.repository.ts` | grava `analytics.linguistic_hints` |
| `signals.service.ts` · `signals.repository.ts` | ⚠️ grava `conversation_signals` — ver zona cinzenta |
| `index.ts` | re-exports |

### Tabelas vivas (medido em prod 2026-06-14)
| tabela | linhas | source |
|---|---|---|
| `analytics.conversation_facts` | 87 | `tool_result_v2` |
| `analytics.conversation_classifications` | 43 | `sql_rule_v1` |
| `analytics.fact_evidence` | 87 | (acompanha os fatos) |
| `analytics.linguistic_hints` | 20 | regras |
| `analytics.customer_journey_mv` | (lida pelo `agent.ts` p/ "cliente recorrente") | viva |

### ⚠️ Gatilho (o ponto mais crítico do "não quebrar")
- **Nada no código do app chama o enrichment** — nem o servidor, nem o bot, nem a normalização; nem import, nem worker, nem trigger no banco.
- Logo, o analytics é gravado por um **processo EXTERNO** rodando `npm run enrich` (provável cron/serviço no **Coolify**, fora deste repositório).
- 🔴 **Confirmar com o dono onde isso roda.** Se cortar `src/enrichment/`, esse processo quebra e o analytics PARA.

---

## 🔴 MORTO — candidato a corte (a Organizadora / V1)

### Banco
| objeto | estado |
|---|---|
| `ops.enrichment_jobs` (fila da Organizadora) | **não existe em prod** (`relation does not exist`) |
| `analytics.conversation_signals` | **0 linhas** (mas código lê/escreve → zona cinzenta) |
| `analytics.customer_journey` (TABELA) | **0 linhas** (≠ `customer_journey_mv`, que é viva) |
| `ops.agent_incidents` | provável vazia (gravador órfão) |

### Código órfão (definido, NUNCA chamado)
| arquivo | o que tem |
|---|---|
| `src/shared/repositories/ops-phase3.repository.ts` | `pickEnrichmentJob`, `markJobRunning/Done/Failed`, `logIncident` — todos órfãos |
| `src/shared/types/ops-phase3.ts` | tipos da fila (`EnrichmentJobType/Status`) |
| `src/shared/llm-clients/openai.ts` | cabeçalho: "OpenAI client — **Organizadora worker**". O bot faz fetch OpenAI direto (não usa este) → provável morto |

---

## ⚠️ A CONFIRMAR antes de cortar (a lista do "não quebrar")
1. **Onde roda o `npm run enrich` em prod (Coolify)?** — é o coração do analytics vivo.
2. **`conversation_signals` vazia:** o passo de signals roda em prod? `classification.service.ts:214` LÊ dessa tabela → confirmar se cortar signals afeta as etiquetas, antes de mexer.
3. **`openai.ts` e `core-reader.repository.ts`:** confirmar que nenhum código vivo importa (só a Organizadora morta).
4. **`ops.agent_incidents`:** confirmar 0 linhas antes de dropar.

## Plano de corte sugerido (SÓ quando o dono aprovar)
1. Confirmar os 4 pontos acima (1 sessão de leitura + 2 queries).
2. Remover o código órfão: `ops-phase3.repository.ts`, `ops-phase3.ts`, e `openai.ts` (se confirmado morto).
3. Migration de limpeza (com agente `banco`): `DROP TABLE` em `conversation_signals`, `customer_journey`, `agent_incidents` — **se** confirmadas mortas e sem leitor vivo.
4. Provas: `typecheck` + `vitest` + rodar 1 `enrich` de teste (garantir que facts/classifications continuam saindo).
5. NÃO tocar `src/enrichment/` (motor de regras) nem as 4 tabelas vivas.
