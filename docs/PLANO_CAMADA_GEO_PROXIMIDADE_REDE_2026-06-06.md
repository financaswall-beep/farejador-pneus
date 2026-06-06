# PLANO — Camada de Proximidade (GEO) do Motor de Distribuição da Rede

> **Versão:** 2026-06-06 · **Autor:** Claude Opus 4.8 (orquestrador, domínio matriz/bot), a pedido do Wallace.
> **Status:** spec aprovada pelo dono nas decisões-chave; pronta pra implementar **test-first, atrás de flag**.
> **Para quem implementa:** este documento é **auto-contido**. Leia inteiro antes de codar. Tudo que é
> decisão de negócio já está travado (§2). Tudo que é código tem pointer de arquivo/linha (§5).
> **NÃO** ligar nada em produção sem passar pelos portões do §9.

Documentos irmãos (contexto, não obrigatórios):
- `docs/FASE2_MOTOR_DISTRIBUICAO_2026-06-06.md` — o motor de justiça (camada que ESTA spec estende).
- `docs/SESSAO_2026-06-06_FASE2_MOTOR_PROGRESSO.md` — o que já foi construído (régua de justiça).
- `docs/PLANO_CONFIG_LOJA_E_ROTEAMENTO_REDE_2026-06-05.md` — a fundação (Configurações da loja).

---

## 1. O QUE É ISSO (em uma frase)

Hoje o motor escolhe a loja **por cidade inteira** (Rio de Janeiro = um balaio só). Numa cidade
gigante isso é furado: manda um cliente de Copacabana pra uma loja em Campo Grande a 40km. Esta
camada faz o motor escolher **por PROXIMIDADE real (km)** — anel ao redor do cliente que **cresce
quando ninguém perto tem o pneu** — respeitando entrega/retirada e a **área de bairros que cada
borracheiro declara atender**. A régua de justiça (quem recebeu menos lead) continua decidindo,
mas só **entre as lojas que passaram nos filtros de proximidade**.

Princípio que rege tudo: **proximidade FILTRA quem pode disputar; a justiça DECIDE quem ganha.**
Loja longe nunca é escolhida, por mais "faminta" que esteja — ela é eliminada antes da justiça rodar.

---

## 2. DECISÕES TRAVADAS PELO DONO (não reabrir)

| # | Decisão | Valor |
|---|---|---|
| D1 | Raio inicial de **entrega** | **10 km** (anel cresce: 10 → 20 → 30…) |
| D2 | Raio de **retirada** | **15 km** (cliente vai até a loja; régua própria, separada da entrega) |
| D3 | Quando **só tem longe** | **HONESTIDADE** — o bot não esconde nem finge normal; avisa e oferece opções (§4, caso E) |
| D4 | "Mais próxima" vs justiça | Entre as que estão **perto o bastante** (no anel), **a justiça decide** (não a mais colada — senão a loja da esquina movimentada seca as outras). Pro cliente o bot fala "a mais perto de você". |
| D5 | Precisão da distância | **Distância de RUA do Google é o padrão** (mata a pegadinha da baía/morro do Rio). **Linha reta (haversine)** fica como (a) rede de segurança quando o Google falha e (b) pré-filtro quando houver muitas lojas. |
| D6 | Área declarada (bairros) | Vale **só pra ENTREGA** (a loja vai até o cliente). Na **retirada NÃO filtra** por bairro declarado (o cliente é que vai à loja) — filtra só o raio de 15 km. |
| D7 | Frete | Continua **fixo** (`FRETE_PADRAO_BRL`) nesta camada. Frete por distância é decisão futura, FORA do escopo. |

Decisões herdadas do motor de justiça (já em código, não mexer): janela de lead = **7 dias**;
empurrão do novato **suave** (semente na mediana); tenta o 2º antes da matriz = **sim**.

---

## 3. A LÓGICA COMPLETA (pipeline determinístico)

Entrada: `pneu X` (1+ itens) · `modalidade` (entrega | retirada) · `localização do cliente`
(pino → coordenada exata; OU endereço digitado → geocodar; OU nada → fallback por cidade).

```
① EXISTE O PNEU EM ALGUÉM DA REDE?  (check barato, ANTES de pedir localização)
      não → bot diz "esse a gente não tem hoje" e oferece alternativa. FIM. ✋

② MODALIDADE — a loja faz o que o cliente quer?
      entrega  → service_mode ∈ {delivery, both}
      retirada → service_mode ∈ {pickup,  both}

③ ESTOQUE — a loja tem o(s) item(ns) DISPONÍVEL agora? (on_hand − reservado ≥ qtd)
      (carrinho multi-item: a MESMA loja tem que ter TODOS — invariante oneUnit de hoje)

④ PROXIMIDADE — o caminho RACHA por modalidade:
   ┌─ ENTREGA:
   │     4a · bairro do cliente ∈ ÁREA DECLARADA da loja      (trava DURA de negócio)
   │           (loja com cobertura por CIDADE inteira passa sempre; ver §6 regra de cobertura)
   │     4b · distância(cliente, loja) ≤ raio do anel (começa 10 km)
   └─ RETIRADA:
         4c · distância(cliente, loja) ≤ 15 km
              (NÃO usa área declarada — a loja não vai entregar)

   POOL = lojas que passaram em ②③④.
      POOL vazio?  → EXPANDE o anel: 10 → 20 → 30 km e repete ②③④.
      Anel no teto (ex. 30 km) e ainda vazio?
          → se EXISTE o pneu longe: caso E (HONESTIDADE, §4) — NÃO joga a venda fora calado.
          → se não existe em lugar nenhum: já barrou no ①.
          → backstop final: MATRIZ.

⑤ RÉGUA DE JUSTIÇA — entre o POOL, quem recebeu MENOS lead (7d) leva.
      (função pura já pronta: rankCandidatesByFairness; fonte: rankUnitsByFairnessFromDb)

SAÍDA: loja escolhida + frete (fixo) → segue pro criar_pedido normal.
```

**Por que essa ordem:** os filtros baratos e que mais cortam vêm primeiro (existe? modo? estoque?),
e a distância (que pode custar chamada de Google) vem por último, só sobre os poucos que sobraram.
A justiça é o último passo — nunca pesca quem caiu num filtro anterior.

---

## 4. CASOS CONCRETOS (exemplo do dono: 4 borracharias na Zona Sul do Rio)

Cenário base: cliente em **Copacabana**. 4 borracharias na Zona Sul, todas **≤ 10 km** dele.

- **Caso A — feliz (entrega):** cliente quer 140/70-17, entrega. As 4 estão no anel de 10 km.
  Filtra: fazem entrega? têm o pneu? Copacabana ∈ área declarada delas? Sobram (digamos) 3 →
  **justiça** escolhe a que recebeu menos lead → pedido criado, frete fixo.

- **Caso B — expande o anel (o exemplo que o dono deu):** nenhuma das 4 (≤10 km) tem o 140/70-17.
  → anel abre pra **20 km** → entram mais lojas → entre as de ≤20 km que têm o pneu + passam nos
  filtros → **justiça** decide. (Se ainda nada: 30 km, depois caso E ou matriz.)

- **Caso C — retirada perto:** cliente quer **retirar**. Filtra `service_mode ∈ {pickup,both}` +
  tem o pneu + **≤ 15 km**. Justiça escolhe entre as próximas. Bot manda o `maps_url` da loja.

- **Caso D — bairro não declarado (entrega):** cliente num bairro que **nenhuma loja declarou
  atender por entrega**, mesmo estando no raio. → trava 4a elimina todas → expande/ caso E/ matriz.
  (Evita prometer entrega onde o borracheiro disse que não vai.)

- **Caso E — só tem LONGE (a decisão D3 = honestidade):** cliente quer 140/70-17; ninguém no raio
  (entrega) ou ≤15 km (retirada) tem; só a loja de Campo Grande (~40 km) tem. O bot **NÃO** finge
  que é normal nem some com a venda. Ele fala a real e dá opções:
  > "esse pneu só tem numa unidade mais longe (Campo Grande, ~40 km). Posso: **te entregar** em casa
  >  (se houver loja que entrega aí), te mostrar uma **medida equivalente perto**, ou **reservar e
  >  avisar** quando chegar perto de você."
  O **cliente decide**. ("Reservar e avisar" pode ser stub na v1 — ver §10.)

- **Caso F — sem coordenada:** cliente não manda pino e digita endereço vago/não-geocodável.
  → fallback: roteia por **bairro/cidade declarada** (caminho de hoje + bairro), sem distância.
  Se nem isso resolver → matriz. **Nunca trava a venda por falta de coordenada.**

- **Caso G — nada na Rede:** o pneu não existe em nenhuma loja → barra no ① ("não temos hoje"),
  **antes** de pedir localização (não enche o saco do cliente à toa).

- **Caso H — Google fora do ar / sem chave:** usa **linha reta (haversine)** como rede de segurança.
  Degrada elegante, não trava. (D5.)

- **Caso I — empate de perto (#1 vs #2):** duas lojas ≤10 km, ambas com o pneu. Diferença 3 km vs
  4 km → a **justiça** decide (não a mais colada). Cliente sente "a mais perto"; sistema mantém a
  Rede honesta (D4).

---

## 5. O QUE CONSTRUIR (com pointers de código)

> Nada disso liga em produção sozinho: tudo atrás de flag `ROUTING_GEO` (default OFF) — flag OFF =
> comportamento de hoje, byte a byte.

### 5.1 Config / flags — `src/shared/config/env.ts`
Adicionar (mesmo padrão `booleanStringSchema` / `z.string()`):
- `ROUTING_GEO` (boolean, default false) — liga esta camada.
- `ROUTING_GEO_ROAD_DISTANCE` (boolean, default false) — usa distância de RUA do Google; OFF = só linha reta.
- `GOOGLE_MAPS_API_KEY` (string, optional) — chave do Google Maps Platform. Sem ela, força linha reta.
- Raios como constantes nomeadas (não mágicos): `GEO_RING_KM = [10, 20, 30]` (entrega), `GEO_PICKUP_RADIUS_KM = 15`. Deixar fácil de virar config depois.

### 5.2 Utilitário de distância (PURO) — novo `src/shared/geo/haversine.ts`
- `haversineKm(a: {lat,lng}, b: {lat,lng}): number` — distância em linha reta. Sem I/O, sem relógio.
- **Testes unit** (`tests/unit/geo/haversine.test.ts`): pares conhecidos (ex.: Copacabana↔Barra ≈ 10-12 km).

### 5.3 Cliente Google Maps — novo `src/shared/geo/google-maps.ts`
- **NÃO há cliente Google no projeto hoje** (só OpenAI em `src/shared/llm-clients/openai.ts`). Criar do zero usando `fetch` nativo (sem dependência nova).
- `geocodeAddress(text): Promise<{lat,lng,confidence} | null>` — Geocoding API. Retorna o `location_type`
  (ROOFTOP/APPROXIMATE) como `confidence`; se vier fraco, o chamador decide cair no fallback.
- `roadDistanceKm(origin, destinations[]): Promise<number[]>` — Distance Matrix API (ou Routes
  `computeRouteMatrix`). 1 origem (cliente) × N lojas. **Timeout curto** (ex. 3s) e **try/catch →
  retorna null/lança** pra o chamador cair no haversine (caso H). Logar custo/uso.
- **Cache opcional** (geocoding de endereço repetido): tabela `commerce.geocode_cache` (key=texto
  normalizado → lat/lng) OU memória LRU. Opcional na v1 (otimização de custo), não bloqueia.

### 5.4 Coordenada do CLIENTE — o ponto mais delicado
A coordenada do pino **já é capturada** na normalização (`src/normalization/attachment.mapper.ts`
→ `coordinatesLat/Lng`; persistida em `src/persistence/attachments.repository.ts` →
`coordinates_lat/lng`). **MAS o agente v2 NÃO vê isso hoje** (a montagem do histórico do agente
não está em `src/atendente-v2/`). Duas peças:
1. **Awareness (o bot saber que veio um pino):** onde o histórico do agente é montado (IMPLEMENTER:
   localizar — provavelmente no worker que chama `runAgentV2` ou num builder de mensagens), injetar
   um marcador textual quando a última mensagem for localização, ex.: `"[cliente compartilhou a
   localização]"`. Sem isso o LLM não sabe que pode prosseguir pela proximidade.
2. **Retrieval (pegar a coordenada server-side):** helper `getLatestCustomerLocation(client,
   environment, conversationId): Promise<{lat,lng} | null>` que lê o ATTACHMENT de localização mais
   recente da conversa. O LLM **nunca** manipula lat/lng cru — a tool resolve por `conversationId`
   (que as tools já recebem).
3. **Precedência:** pino (retrieval) → senão geocodar endereço digitado (`bairro`+`municipio`(+rua/nº
   se houver)) → senão fallback por cidade/bairro declarado (caso F).

### 5.5 Candidatos com geo — `src/atendente-v2/fulfillment.ts`
- `resolveUnitCandidates` (hoje em **fulfillment.ts:173**) já lista por município com `service_mode`.
  Estender o SELECT pra trazer **`latitude`/`longitude`** (de `network.partner_units`, migration 0088)
  e a **cobertura declarada** (linhas de `network.unit_coverage` com `coverage_kind`/`neighborhood_canonical`).
- Novo passo de filtro geo (função pura sobre os candidatos + coordenada do cliente + modalidade):
  aplica 4a/4b/4c e a **expansão de anel**. Devolve o POOL ordenável.

### 5.6 Motor — `src/atendente-v2/fulfillment.ts:decideStoreForItems` (linha 544)
- Hoje ramifica em `if (env.ROUTING_MULTI_CANDIDATE)` → `decideStoreForItemsMulti` (linha 597).
- Adicionar ramo geo: quando `env.ROUTING_GEO` **e** houver coordenada do cliente → usar o caminho
  com filtro de proximidade (anel) **antes** da régua `rankUnitsByFairnessFromDb` (fairness.ts, NÃO
  mudar a régua). Sem coordenada → cai no caminho atual (multi-candidato por cidade) = caso F.
- **Assinatura:** `decideStoreForItems` vai precisar receber `modalidade` e a `coordenada do cliente`
  (hoje recebe só `municipio` + `items`). Propagar dos callers (§5.7). Manter a versão sem geo intacta.

### 5.7 Tools do bot — `src/atendente-v2/tools.ts`
- **`calcular_frete`** (handler em **tools.ts:341**): hoje chama `decideStoreForItems({municipio, items})`.
  Passar também `modalidade` + coordenada (via `getLatestCustomerLocation(conversationId)` ou geocode).
- **`criar_pedido`** (handler em **tools.ts:397** → `criarPedido`): MESMA decisão; passar os mesmos dados.
  ⚠️ **Invariante crítico:** a loja decidida no `calcular_frete` tem que ser a MESMA do `criar_pedido`
  (a cotação tem que bater com o pedido). `decideStoreForItems` é a fonte única — garantir que recebe
  as mesmas entradas nos dois.
- (Opcional) nova tool `calcular_unidade_mais_proxima` se ficar mais limpo que sobrecarregar
  `calcular_frete` — decisão do implementer; o efeito é o mesmo.
- **Resposta do caso E (só tem longe):** a tool retorna um shape tipo `{ encontrado:true,
  apenas_longe:true, distancia_km, bairro_loja, alternativas:[...] }` pra o prompt saber dar a
  resposta honesta (D3). NÃO criar o pedido nesse caso sem o cliente confirmar.

### 5.8 Prompt do bot — `src/atendente-v2/prompt.ts`
- Fluxo da conversa (a parte nova): depois de identificar o pneu e ANTES de cotar entrega, **pedir a
  localização**: "me manda tua localização 📍 (ou rua, número e bairro)". Reaproveita o estilo do
  bloco de pickup já existente (prompt.ts:82) e do `localizacao_loja` (prompt.ts:104).
- **Pino é de ONDE O CLIENTE ESTÁ** → pedir "a localização de **onde você quer receber**".
- Endereço digitado → pedir **rua + número + bairro** (geocoding precisa); se vier vago, confirmar.
- **Caso E (honestidade):** quando a tool devolver `apenas_longe`, falar a real e oferecer as 3 opções.
- Manter as CRITICAL RULES de hoje (não prometer prazo/horário sem `buscar_politica`).

---

## 6. MODELO DE DADOS — **nenhuma migration nova é necessária**

Tudo já existe em produção:

| Dado | Onde | Migration |
|---|---|---|
| Modo da loja (entrega/retirada) | `network.partner_units.service_mode` ('delivery'\|'pickup'\|'both') | 0087 |
| Coordenada da loja | `network.partner_units.latitude` / `longitude` NUMERIC(9,6) | 0088 (**NULL hoje → POPULAR**) |
| Link Maps da loja | `network.partner_units.maps_url` | 0088 |
| **Bairros declarados (entrega)** | `network.unit_coverage.neighborhood_canonical` + `coverage_kind` ('city'\|'neighborhood') | 0083 + 0087 |
| Estoque disponível | `commerce.partner_stock_levels` (on_hand − reserved) | existente |
| Lead recebido (justiça) | `commerce.partner_orders` (source_tag='2w', created_at, 7d) | existente |
| Coordenada do cliente (pino) | `*.attachments.coordinates_lat/lng` | existente |

**Regra de cobertura (city vs neighborhood)** — como ler `unit_coverage`:
- `coverage_kind='city'` (neighborhood_canonical NULL) = a loja cobre a **cidade inteira** → passa no
  4a sempre (cidade pequena com 1 parceiro, ex. Niterói/Itaboraí).
- `coverage_kind='neighborhood'` = a loja **só atende os bairros listados** → no 4a, o bairro do
  cliente (resolvido por `commerce.resolve_neighborhood`) **tem que estar** entre eles.
- Cidade pode ser MISTA (umas lojas city, outras por bairro). O 4a respeita cada linha.

**Único trabalho de dado:** popular `latitude`/`longitude` de 2-3 lojas reais (pino/Maps) pra testar,
e das fake no `test`. (UI pro dono soltar o pino é peça da Configurações da loja — pode ser manual no começo.)

**Opcional:** `commerce.geocode_cache` (se for cachear geocoding). Se criar, usar
`scripts/apply-migration-file.cjs` (numeração do repo é a verdade; próxima = 0089).

---

## 7. FERRAMENTAS / DEPENDÊNCIAS QUE O PLANO USA

**Externas (novas):**
- **Google Maps Platform** — Geocoding API (endereço→coordenada) e **Distance Matrix API** (ou Routes
  `computeRouteMatrix`) pra distância de rua. Exige `GOOGLE_MAPS_API_KEY` + billing ligado no Google
  Cloud. ⚠️ **Confirmar preço e franquia grátis no painel** (mudou em 2025; ordem de ~US$5/1.000
  chamadas, com cota grátis mensal por API). Custo por conversa ~R$0 (pino) a alguns centavos (geocode/rua).
- **`fetch` nativo do Node** pras chamadas HTTP ao Google — **sem nova lib** (o projeto já usa fetch).

**Internas (já existem, reutilizar):**
- `commerce.resolve_neighborhood` (SQL) — traduz o bairro digitado pro canônico (pro 4a).
- `rankCandidatesByFairness` / `rankUnitsByFairnessFromDb` (fairness.ts) — a régua, **não mexer**.
- `mapProductToPartnerStock` / `getPartnerStockMap` (fulfillment.ts) — checagem de estoque (③).
- `getUnitMapsUrl` (fulfillment.ts) — link da loja pro caso retirada.
- `FRETE_PADRAO_BRL` (fulfillment.ts) — frete fixo (D7).

**Dev / verificação (a LLM implementadora vai usar):**
- `vitest` — `npm run typecheck` e `npx vitest run` (suite unit; hoje 271 verdes; adicionar os testes novos).
- `scripts/seed-fake-rede-test.cjs` / `scripts/limpar-fake-rede-test.cjs` — **estender** pra dar
  `latitude`/`longitude` + linhas de `unit_coverage` por bairro nas lojas fake do `test`.
- `scripts/prova-regua-rede-test.ts` — **estender** com casos geo (anel, expansão, retirada 15km, caso E).
- `scripts/checar-naoregressao-roteamento.cjs` — rodar **SEM** `--env-file` (o `.env` tem
  `FAREJADOR_ENV=test`); confirma Itaboraí→Rio do Ouro, Niterói→Anderson intactos com flag OFF.
- `scripts/apply-migration-file.cjs` — só se criar a tabela opcional de cache (DRY-RUN por padrão, `--commit`).

---

## 8. FLAGS E ROLLOUT (test-first, uma de cada vez)

1. Construir tudo com `ROUTING_GEO=false`. **Flag OFF = roteamento de hoje, intocado** (typecheck + 271 testes têm que continuar verdes).
2. No `test`: semear fake **com coordenada e bairros declarados**; rodar a prova estendida (anel,
   expansão, retirada, caso E, determinismo). Tudo verde.
3. **Shadow** (recomendado): logar a decisão geo SEM aplicar, comparar com a decisão atual, observar.
4. Em prod, ligar **`ROUTING_GEO=true`** só quando: (a) houver 2+ parceiros reais na mesma cidade
   grande com coordenada preenchida; (b) `ROUTING_GEO_ROAD_DISTANCE` começa **false** (linha reta);
   observar; depois `true` (rua). Uma flag por vez.
5. Desligar = apagar a env var + redeploy → volta ao de hoje na hora.

---

## 9. PORTÕES (obrigatórios antes de prod)

- **`banco`** — sanity do schema (confirmar que `unit_coverage`/`partner_units`/0088 cobrem tudo sem
  migration nova; revisar a tabela de cache se existir). *(Spec já confirmou: nenhuma migration nova.)*
- **`seguranca`** — gate de ownership/roteamento: a coordenada do cliente e a decisão **não podem
  vazar pedido/loja entre parceiros nem reabrir SEC-001** (amarra `contact_id`). Revisar o
  `getLatestCustomerLocation` (escopo por conversa/contato).
- **Opus + dono** — é contrato (dinheiro): a decisão de ligar em prod é do dono, com revisão Opus.

---

## 10. FORA DE ESCOPO (não fazer agora; anotado pra não esquecer)

- **Frete por distância** (hoje fixo — D7).
- **"Reservar e avisar quando chegar perto"** (caso E, 3ª opção): pode ser **stub** que escala pra
  humano na v1; fila de notificação é peça futura.
- **Pino no mapa / UI do dono soltar coordenada** na Configurações da loja (popular lat/long pode ser
  manual no começo).
- **Geo no painel/funil da matriz** (a matriz tem o bug do funil que junta lojas da mesma cidade —
  separado, ver FASE2 doc).
- **Distância intra-anel pra ranquear metros exatos** — a justiça já faz o papel; não precisa.

---

## 11. CRITÉRIOS DE ACEITE (como provar que tá pronto)

- [ ] `npm run typecheck` limpo e `npx vitest run` verde (271 + novos), com `ROUTING_GEO=false`.
- [ ] Testes unit de `haversine` (pares conhecidos) e do filtro de anel/expansão (função pura).
- [ ] Prova no `test` (fake com coord + bairros): caso A (feliz), B (expande anel), C (retirada 15km),
      D (bairro não declarado), E (só longe → honestidade), F (sem coord → fallback), H (Google off → haversine), I (empate → justiça).
- [ ] `checar-naoregressao-roteamento.cjs` (SEM --env-file): Itaboraí→Rio do Ouro, Niterói→Anderson — idênticos com flag OFF.
- [ ] Cotação (`calcular_frete`) e pedido (`criar_pedido`) escolhem a **MESMA** loja (invariante §5.7).
- [ ] Portões `banco` e `seguranca` PASS.

---

*Fim. Dúvida de negócio → Wallace. Dúvida de arquitetura → o orquestrador (Opus, domínio matriz/bot).*
