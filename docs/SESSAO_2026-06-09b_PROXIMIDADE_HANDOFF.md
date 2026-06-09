# Handoff — Pino end-to-end + Gatilhos de conversão + Plano da Proximidade-primeiro

> Data: 2026-06-09 (sessão continuação). Orquestrador Opus 4.8 + dono (Wallace).
> Repo: github.com/financaswall-beep/farejador-pneus · **Coolify faz deploy automático no push pro `main`**.
> Supabase: projeto **Farejador** (`aoqtgwzeyznycuakrdhp`), env `prod` e `test`.
> **main HEAD = `0e621b2`** (tudo abaixo já DEPLOYADO, menos a Proximidade-primeiro que é PLANO).

---

## 0. TL;DR — onde paramos
Subimos e VALIDAMOS AO VIVO o **pino-first end-to-end** (PED-0034: pino em Niterói → bot achou a loja Anderson sozinho → reservou). Subimos **gatilhos de conversão** (proximidade/escassez/horário). E **fechamos o desenho + o plano** da grande mudança que falta construir: **Proximidade-primeiro** (derrubar o "muro da cidade" no roteamento). **As decisões estão travadas e o plano em 4 fases está pronto — falta só o dono dar o "começa a Fase 0" e implementar.**

---

## 1. O que subiu nesta sessão (DEPLOYADO em prod)

### 1.1 Fix do pino — `reverseGeocode` (commit `84b5072`)
- **Bug:** o bot pedia o bairro mesmo depois do cliente mandar o pino — o pino sozinho não resolvia a CIDADE.
- **Fix (aditivo):** `src/shared/geo/google-maps.ts` ganhou `reverseGeocode(point, apiKey) → { municipio, neighborhood }` (mesma API Google, parâmetro `latlng`, parseia `address_components`; tolerante a falha → null). `src/atendente-v2/tools.ts` ganhou `fillCityFromPin` que **só age quando `municipio==null` E há pino** (early-return quando o bairro já resolveu → caminho do bairro escrito intocado). Ligado nos 5 handlers (buscar_produto, buscar_compatibilidade, calcular_frete, localizacao_loja, criar_pedido entrega+retirada). O município do Google casa com `unit_coverage` via `normalizeRegion`.

### 1.2 Saudação-espelho (commit `9d6b0a5`)
- A saudação não abre mais SEMPRE pedindo localização (parecia inquisição). Agora **espelha**: só cumprimentou → "Como posso te ajudar?"; já chegou com pedido → cumprimenta + pede localização. Voz: "unidade"→"borracharia mais perto de você"; "de onde tu fala"→"de onde você fala". (em `prompt.ts`)

### 1.3 Pino ainda pedia bairro → NUDGE DETERMINÍSTICO (commits `08f7a1a` depois `bdc04ee`)
- **Causa-raiz (provada via `agent.turns`):** mesmo com a regra "pino=re-busca" no prompt, o LLM **não chamava a ferramenta** quando havia pino (re-perguntava o bairro). Pedir no prompt NÃO bastou (2 deploys).
- **Fix definitivo (`agent.ts`):** quando `getLatestCustomerLocation` acha um pino na conversa, injeta um **nudge forte e contextual** no system prompt (só quando há pino — alta autoridade, sem diluir) mandando CHAMAR a ferramenta sem pedir bairro. **LIÇÃO: comportamento crítico do bot se garante por CÓDIGO, não por pedido educado no prompt.**
- **✅ VALIDADO AO VIVO — PED-0034:** pino em Niterói → `buscar_compatibilidade` → `localizacao_loja` devolveu Anderson SEM pedir bairro → `criar_pedido` → pedido pickup, reservado (on_hand 5 / reservado 1). **Prova tripla:** nudge funciona + reverse-geocode do Google funciona em prod + caminho do dinheiro fecha inteiro.

### 1.4 Gatilhos de conversão (commit `0e621b2`)
- **Proximidade 2 níveis:** `agent.ts` calcula a loja ativa mais perto (haversine, OFFLINE, sem chamar Google) quando há pino e injeta no nudge: ≤5km "colado/pertíssimo", 5-10km "pertinho (uns X km)", >10km NÃO cita o km (longe=atrito). Sempre "~". `localizacao_loja` passou a devolver `distancia_km` (rua, preciso).
- **Escassez:** estoque 1-3 → gancho ("só restam 2 — quer que eu reserve?") com número REAL; nunca inventar.
- **Imediatismo:** mostra o horário da loja quando preenchido (texto livre, só EXIBE — nunca afirma "aberto agora") + enquadra retirada como "reservado pra ti".

**Prova de cada commit:** typecheck + 330 testes unit + `prova-geo-rede` 9/9 (motor intacto).

---

## 2. A GRANDE MUDANÇA QUE FALTA: Proximidade-primeiro (PLANO, NÃO implementado)

### 2.1 O furo
O roteamento (`decideStoreForItemsGeo` em `fulfillment.ts`) filtra as lojas pela **CIDADE** do cliente ANTES da distância (`resolveUnitCandidates(municipio)`). Resultado: cliente em **Duque de Caxias a 9 km da loja de Madureira** é RECUSADO porque Caxias não está na cobertura → cai na matriz. Repete em TODA divisa (Nova Iguaçu, São João de Meriti, Itaipuaçu/Maricá). Adicionar cidade a cidade = enxugar gelo.

### 2.2 A virada
Quando há coordenada (pino ou bairro geocodado), **derrubar o muro da cidade** e montar as lojas candidatas por **DISTÂNCIA** (todas as ativas dentro do maior anel), deixando anel+estoque+régua (que já existem) decidirem. A cidade vira: (a) plano B quando NÃO há coordenada; (b) "teto de raio" por loja na entrega.

### 2.3 Decisões TRAVADAS (debatidas por mesa de 4 especialistas: logística/vendas/planejamento/regras)
- **Retirada:** mantém a lógica de hoje (faixa 5/10/15 km + régua + só loja com estoque — INTOCADA); remove o muro da cidade; liga **pra todos**, **sem teto** (o cliente vai à loja).
- **Entrega — Decisão 1 (dono):** borracheiro que **não preenche o raio = FORA da entrega** (a retirada dele continua). Silêncio ≠ consentimento (ele dirige na entrega).
- **Entrega — Decisão 2 (dono):** raio = **número livre** (km que o borracheiro quiser) **+ alerta na matriz** se um pedido sair acima do raio dele.
- **Régua de justiça:** INTOCADA — decide DENTRO da faixa mais perto que tem candidato; **nunca pula pra faixa mais longe** (protege o frete). Já é assim.
- **Matriz:** backstop universal — só quando NENHUM parceiro alcança; não compete no pool.

### 2.4 Como perguntar o raio ao borracheiro
- Campo novo no banco: `network.partner_units.delivery_radius_km` (nasce NULL).
- Seção "Entrega" no **painel do parceiro** (Configurações da loja): "Você entrega? Sim/Não" + "Até quantos km você entrega? [__] km" + nota ("a Rede só manda entrega dentro desse raio; retirada não tem limite; pode mudar quando quiser").
- **Coleta dos 7 atuais:** aviso de uma vez no login do painel ("falta o raio pra receber entrega") OU Wallace preenche pelos 7 na matriz.
- **Parceiro novo:** o raio entra no cadastro "Novo parceiro".

### 2.5 O PLANO DE OBRA (faseado, atrás de flag `ROUTING_PROXIMITY_FIRST` off)
- **Fase 0 — Fundação (dormente, não muda prod):** migration do `delivery_radius_km`; nova função `resolveUnitCandidatesByProximity` (todas as lojas ativas com coord, SEM gate de cidade — usada só com flag on + coordenada); flag off; **teste de divisa + cenário de 30 lojas fake** na `prova-geo-rede` (a prova que o dono pediu de que o motor escala/decide certo com ~30 parceiros).
- **Fase 1 — Retirada por proximidade (liga 1º):** `decideStoreForItemsGeo(pickup)` usa o pool por proximidade quando flag on + coordenada; faixa+régua+estoque IDÊNTICOS. Prova: Caxias→Madureira OK; cliente dentro da cidade IGUAL a hoje (não-regressão). Liga e observa.
- **Fase 2 — Coleta do raio (painel):** campo "Entrega" + aviso no login + endpoint de salvar + alerta na matriz. Os 7 preenchem.
- **Fase 3 — Entrega por proximidade (liga por último):** pool por distância, mas **só entram lojas com `delivery_radius_km` preenchido E distância ≤ o raio dela**. Quem não preencheu = fora da entrega. Régua/faixa/estoque idênticos. Matriz backstop.
- **Trava:** cada fase atrás da flag; sem coordenada = caminho de cidade de hoje (plano B); rollback = desliga a flag.

### 2.6 Por que o dono pode confiar (a preocupação dele: "funciona com 30 borracheiros?")
A decisão de "qual loja" é **código determinístico** (mede distância + estoque + faixa + régua + ordena), NÃO o LLM adivinhando. 7, 30 ou 300 lojas = a MESMA conta, sem "muro de complexidade". O que deu trabalho nesta sessão foi o **atendente (LLM) ACIONAR** o motor — não o motor errar a escolha (PED-0034 escolheu certo). O risco real a 30 é **qualidade do dado** (coordenada/estoque/raio) → guardas + alerta. **A Fase 0 PROVA isso com 30 lojas fake antes de ligar.** Custo/latência a 30: filtro barato (haversine) antes da chamada cara de rua do Google.

---

## 3. Estado do prod AGORA
- **main = `0e621b2`**; branch `feat/pickup-to-partner` = main (sincronizada).
- Flags no Coolify: ROUTING_GEO on, PICKUP_TO_PARTNER on, ROUTING_GEO_ROAD_DISTANCE on (confirmar). GOOGLE_MAPS_API_KEY preenchida + billing/Geocoding ligados (provado pelo PED-0034).
- Cobertura (prod): 7 lojas — `rio de janeiro` (5), `niteroi` (1), `itaborai` (1), todas coverage_kind='city'.
- Dicionário `commerce.geo_resolutions`: 624 bairros, 15 cidades (inclui Duque de Caxias com 29 bairros; **Caluge NÃO está lá** — exemplo de bairro que só o Google pega).

## 4. Pendências / ações do DONO
1. **Confirmar "começa a Fase 0"** da Proximidade-primeiro (§2.5).
2. **Preencher o horário das lojas** no painel — só 1 de 7 tem (Rio do Ouro); as outras 6 NULL → o gancho de horário não aparece pra elas.
3. **Limpar dado de teste:** PED-0034 (1× 90/90-18 reservado na Anderson) + conversas de teste, quando quiser.
4. Decidir se quer aceitar **link do Google Maps colado** como pino no futuro (hoje só o pino nativo do WhatsApp funciona).

## 5. Mapa de código (pra próxima IA)
- `src/atendente-v2/agent.ts` — monta o prompt + loop do LLM; **nudge do pino + nearestStoreKm** ficam aqui.
- `src/atendente-v2/tools.ts` — handlers das tools do bot; `fillCityFromPin`, `resolveCustomerLocation`, `decideStoreGeoOrFallback`.
- `src/atendente-v2/fulfillment.ts` — **motor de roteamento** (`decideStoreForItemsGeo`, `resolveUnitCandidates` ← o gate de cidade a mudar, `resolveProductAvailabilityByProximity`, rings, régua via `rankUnitsByFairnessFromDb`).
- `src/atendente-v2/geo-routing.ts` — filtros puros (modo + cobertura de bairro), `ringsForModalidade`, `selectWithinExpandingRing`.
- `src/atendente-v2/prompt.ts` — `SYSTEM_PROMPT` + `GEO_PROMPT_BLOCK` (regras do pino/distância/horário).
- `src/shared/geo/google-maps.ts` — `geocodeAddress`, `reverseGeocode`, `roadDistanceKm`.
- `src/shared/geo/haversine.ts` — `haversineKm` (linha reta, offline).
- Prova de integração: `npx tsx --env-file=.env scripts/prova-geo-rede-test.ts` (env test, BEGIN/ROLLBACK).
- Painel do parceiro: `src/parceiro/` (queries, rotas) + `parceiro/public/` (app.js, index.html) — onde entra o campo "Entrega".

## 6. Gotchas / lições
- **Comportamento de bot se garante por CÓDIGO, não por prompt** (o nudge determinístico foi o que resolveu o pino, depois de 2 deploys de prompt falharem).
- **Fix do pino ≠ fix do muro da cidade** — são problemas diferentes. O pino já funciona; o muro (Caxias) AINDA bloqueia.
- Rings: retirada [5,10,15] km, entrega [10,20,30,40] km. Banda mais perto ganha; régua reveza dentro da banda.
- Chave do Google só no Coolify (não no `.env` local) → reverse-geocode/distância de rua não roda local; testar AO VIVO ou com `scripts/testar-geocode.cjs` (pode dar REQUEST_DENIED local se a chave for restrita por IP).
- `checar-naoregressao` roda SEM `--env-file` (o `.env` tem FAREJADOR_ENV=test → falso "regressão").

— Sessão 2026-06-09b, orquestrador (Claude Opus 4.8) + dono (Wallace).
