# Fase 2 — Motor de Distribuição: PROGRESSO (2026-06-06)

> Estado da implementação do motor multi-parceiro. Auto-contido.
> Spec do que fazer: `docs/FASE2_MOTOR_DISTRIBUICAO_2026-06-06.md`.
> Design/decisões: `docs/PLANO_CONFIG_LOJA_E_ROTEAMENTO_REDE_2026-06-05.md`.

## TL;DR

O **motor de distribuição** (escolher entre vários parceiros na mesma região, com
justiça) está **construído e plugado, atrás de flags DESLIGADAS**. Produção **intocada**:
com as flags off, o roteamento é byte a byte o de hoje (Itaboraí→Rio do Ouro,
Niterói→Anderson). **271 testes unit verdes, typecheck limpo.** O motor já foi
**provado no ambiente `test`** (6/6 casos com lojas fake — alternância A/B 10/10,
tenta-o-2º, filtro de modo, matriz, determinismo). Falta ligar em prod — e isso só
faz sentido quando houver 2 parceiros reais na mesma região.

Branch: `feat/config-loja-fase1`. **Commitado e empurrado** pro remoto `pneus`
(feature branch — **NÃO dispara deploy**; só `main` faz deploy automático no Coolify).
Mesmo se subir pra `main`: flags off → comportamento idêntico ao de hoje.

## Decisões travadas (2026-06-06)

| Decisão | Valor | Quem |
|---|---|---|
| 🔑 O que conta como "lead recebido" | **pedido criado** (`partner_orders` 2w, por `created_at`) — não a cotação | Claude recomendou, Wallace ok |
| Modalidade filtra | **sim** (quer retirar → loja só-entrega não atende, e vice-versa) | Claude |
| Distância entra | **depois** (lat/long quase tudo NULL) | Claude |
| Horário "aberto agora" filtra | **não** (texto livre, não calcula) | Claude |
| Teto do empurrão do novato | semente capada na **mediana** (`seedCapFactor=1.0`), calibrar no `test` | Claude |
| Janela | **7 dias** | Wallace (2026-06-05) |
| Empurrão do novato | **suave**, semente na mediana, `coldStartFactor=1.0` | Wallace (2026-06-05) |
| Tenta o 2º antes da matriz | **sim** | Wallace (2026-06-05) |

Consequência do keystone: a tabela `network.unit_leads` (migration 0089) que a spec
tinha cogitado **NÃO é necessária** — a contagem sai de `partner_orders` (que já existe).

## O que foi CONSTRUÍDO (3 tijolos)

Todo o código novo, com pointers:

### 1. Régua de justiça (pura) — `src/atendente-v2/fairness.ts`
`rankCandidatesByFairness(candidates, params)`: função **pura** (sem banco, sem
relógio — `now` injetado, sem random). Recebe candidatos já filtrados + quantos leads
cada um pegou, devolve a ordem: **quem recebeu menos vai primeiro**.
- Cold-start: novato (entrou dentro da janela) entra semeado em `seed = min(mediana_dos_veteranos × coldStartFactor, maxVeterano × seedCapFactor)`; `credit = seed + leadCount`. Veterano: `credit = leadCount`.
- Tie-break determinístico: `credit ASC → lastLeadAt ASC NULLS FIRST (anti-seca) → unitCreatedAt ASC → unitId`.
- **10 testes** em `tests/unit/atendente/fairness.test.ts`.

### 2. Fonte de contagem — `src/atendente-v2/fairness.ts`
`rankUnitsByFairnessFromDb(client, env, candidateUnitIds, opts)`: vai ao banco, conta o
LEAD de cada candidato e devolve a ordem da régua.
- LEAD = `commerce.partner_orders` com `source_tag='2w'`, `status<>'cancelled'`, `deleted_at IS NULL`, por **`created_at`** na janela (NÃO `delivered_at` — esse é a régua de venda realizada/comissão). Mede **oportunidade recebida**, não venda. Anti-trapaça.
- Mesma fatia "2w" que a cobrança da matriz usa (`getPainelRede`, `src/admin/painel/queries.ts`).
- `≤1` candidato → não vai ao banco. **4 testes** (client mockado).
- ⚠️ A query SQL só é exercida de verdade na **prova no env `test`** (testes unit mockam o client).

### 3. Motor multi-parceiro + flags — `src/atendente-v2/fulfillment.ts` + `src/shared/config/env.ts`
- `resolveUnitCandidates(client, env, municipio)`: lista **todos** os parceiros que cobrem o município (sem `LIMIT 1`), com `service_mode`. Dedup por unidade. v1 = por município (bairro é a flag `ROUTING_NEIGHBORHOOD`, peça separada).
- `decideStoreForItemsMulti(...)` (privada): filtra loja só-retirada (contexto entrega) → ordena pela régua (se `ROUTING_FAIRNESS`) → tenta o 1º com estoque, depois o 2º, **antes da matriz** → `null` (matriz) se ninguém tem o pedido completo. Reusa `mapProductToPartnerStock` (mesma régua de estoque de hoje).
- `decideStoreForItems` ramifica no topo: `if (env.ROUTING_MULTI_CANDIDATE) → motor novo; else → caminho de hoje INTOCADO`.
- Flags em `env.ts` (padrão `booleanStringSchema`, **default `false`**): `ROUTING_MULTI_CANDIDATE`, `ROUTING_FAIRNESS`.

## Estado / verificação

- `npm run typecheck` — limpo.
- `npm test` — **271/271 verdes** (44 arquivos). Como a flag é default-off, o caminho vivo não mudou; os testes existentes continuam passando.
- Produção: **nada deployado**, nada commitado. Flags off = comportamento de hoje.

## O que FALTA (pra ligar de verdade)

| # | Tijolo | Nota |
|---|---|---|
| A | **Fio `intent`** (entrega/retirada) de `calcular_frete`/`criar_pedido` (`tools.ts`) até `decideStoreForItems` | substitui o filtro pickup-only hardcoded pelo filtro de modo genérico + flag `ROUTING_MODE_FILTER` |
| B | **Gravar o "porquê"** (reason estruturado: quem filtrou quem, posição no ranking) | sustenta "por que não veio pra mim?" e o antifraude |
| C | **Fix do funil** `getRedeFunnel` (`src/admin/painel/queries.ts`) por `(municipio, unit_id)` | hoje colapsa 2 parceiros da mesma cidade numa linha; sobe junto com o multi-candidato |
| D | ✅ **Seed 4 fake + prova no `test`** | **FEITO** — `scripts/seed-fake-rede-test.cjs` (+ `limpar-fake-rede-test.cjs`) + `scripts/prova-regua-rede-test.ts`. 6/6 casos OK (alternância A/B 10/10, tenta-2º, filtro de modo, matriz, determinismo). Caso retirada pendente de (A). Fake persistidos no `test`, re-rodável |
| E | **Shadow → ligar flags 1 a 1 no `test` → prod** | só depois de provado |
| F | **Revisão `seguranca`** (ownership/roteamento; não reabrir SEC-001) | gate antes de prod |

Fora do escopo do motor (outras peças da Fase 2): retirada→parceiro (`PICKUP_TO_PARTNER`),
cobertura por bairro (`ROUTING_NEIGHBORHOOD`, tem 3 bugs), endereço por loja, SEC-002.

## COMO TESTAR (a prova já passou — isto é pra REPETIR quando quiser)

Tudo no env `test`: mesma base Supabase (Farejador), só linhas `environment='test'`.
**NÃO toca produção.** Pré-requisito no `.env`: `FAREJADOR_ENV=test` + `DATABASE_URL` do Farejador.
Os 3 scripts têm trava dura (`assertTest()`) e recusam rodar se o env não for `test`.

**1. Semear as 4 lojas fake** (idempotente — limpa e recria):
```
node --env-file=.env scripts/seed-fake-rede-test.cjs
```
Cria: A,B em `rio de janeiro` (both, estoque 10) · C em `sao goncalo` (só-entrega,
estoque 10) · D em `marica` (só-retirada, estoque 0) + 1 produto fake (preço central R$ 200).

**2. Rodar a prova** (liga as flags SÓ nesta execução, via env var):
```bash
# Linux/Mac/Git-bash:
ROUTING_MULTI_CANDIDATE=true ROUTING_FAIRNESS=true npx tsx --env-file=.env scripts/prova-regua-rede-test.ts
```
```powershell
# Windows PowerShell:
$env:ROUTING_MULTI_CANDIDATE='true'; $env:ROUTING_FAIRNESS='true'; npx tsx --env-file=.env scripts/prova-regua-rede-test.ts
```
Esperado: **`✅ TODOS OS CASOS PASSARAM`** (6/6). Roda em `BEGIN…ROLLBACK` — não persiste
lead nem mexe em estoque. (As flags têm precedência sobre o `.env`; sem elas, o script avisa que o motor está OFF.)

**3. Limpar as fake** (quando não precisar mais):
```
node --env-file=.env scripts/limpar-fake-rede-test.cjs
```

**Regressão do roteamento de hoje** (Itaboraí→Rio do Ouro, Niterói→Anderson) — roda
**SEM** `--env-file` (o `.env` tem `FAREJADOR_ENV=test` → senão olha a partição vazia e dá falso negativo):
```
node scripts/checar-naoregressao-roteamento.cjs
```

**Suite unit + typecheck** (não precisa de banco; valida que nada quebrou com a flag off):
```
npm run typecheck   # limpo
npx vitest run      # 271/271 verdes (inclui os 14 testes da régua)
```

## Precisa REDEPLOY agora? **NÃO** — e não muda nada se acontecer

- **Migration?** Nenhuma. O motor lê colunas que **já existem** (`partner_units.service_mode`
  veio da Fase 1; a contagem sai de `commerce.partner_orders`). A `unit_leads` (0089) que a
  spec cogitou foi **descartada** (keystone = contar pedido).
- **Deploy?** O commit está numa **feature branch** (`feat/config-loja-fase1`). Coolify só
  faz deploy automático no push pro **`main`** → feature branch **não dispara nada**.
- **E se subir pra `main`?** Produção continua igual: as flags nascem `false`. Com elas off,
  `decideStoreForItems` é byte a byte o de hoje (271 testes provam). O motor só "acende"
  quando alguém **setar as env vars no Coolify**.

## Quando for LIGAR de verdade (futuro — NÃO agora)

Só faz sentido quando houver **2 parceiros reais na mesma cidade** (hoje a Rede tem 1 por cidade).
1. Recrutar o 2º parceiro real numa cidade já coberta.
2. **Revisão `seguranca`** (gate — ownership/roteamento, não reabrir SEC-001).
3. No Coolify, ligar **`ROUTING_MULTI_CANDIDATE=true`** primeiro (multi-candidato + tenta-o-2º,
   ainda na ordem da query). Observar.
4. Depois **`ROUTING_FAIRNESS=true`** (régua de justiça). Observar a divisão dos leads.
5. Uma por vez. Desligar = voltar ao de hoje na hora (é só apagar a env var e redeployar).

## Guardrails

- Flag off = hoje. Liga-se **uma por vez**, no `test`, com prova, antes de prod.
- `scripts/checar-naoregressao-roteamento.cjs` (Itaboraí→Rio do Ouro, Niterói→Anderson) roda **SEM** `--env-file` (o `.env` tem `FAREJADOR_ENV=test` → falso "regressão").
- É contrato da Rede (dinheiro): Opus + revisão `seguranca` antes de prod.
- Migration: numeração do repo é a verdade. Keystone=pedido ⇒ a 0089/`unit_leads` foi descartada.

---

*Documentado por Claude (Opus 4.8), orquestrador — domínio matriz/bot.*
