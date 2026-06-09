# Handoff — Proximidade-primeiro FASE 3 (entrega pelo raio) + aba Área simplificada

> Data: 2026-06-09 (continuação). Orquestrador Fable (Claude) + dono (Wallace).
> Repo: github.com/financaswall-beep/farejador-pneus · **Coolify deploya automático no push pro `main`**.
> Supabase: projeto **Farejador** (`aoqtgwzeyznycuakrdhp`), env `prod` e `test` (banco único, coluna `environment`).
> **Construído na branch `feat/proximidade-primeiro` — NÃO deployado** (ver §4, gate do raio).

---

## 0. TL;DR — onde paramos
Construímos e PROVAMOS a **Fase 3 da Proximidade-primeiro**: a **ENTREGA passou a rotear pelo RAIO declarado** (`network.partner_units.delivery_radius_km`) — loja entra na entrega **só se preencheu o raio E a distância do cliente ≤ o raio**; quem não preencheu fica FORA da entrega (a retirada continua normal); matriz segue backstop. Junto, a **aba "Área de entrega" do painel do parceiro foi simplificada** (só município/plano B; a parte de bairros saiu — o raio aposentou). Tudo atrás da MESMA flag `ROUTING_PROXIMITY_FIRST` (que **já está ON em prod**). **⚠️ GATE DE DEPLOY: só 1 dos 7 parceiros tem raio preenchido em prod** — subir agora tira 6 lojas da entrega. O dono preenche os raios ANTES do push pro main (ou aceita que caiam na matriz até preencher).

---

## 1. O que mudou no MOTOR (`src/atendente-v2/`)

### 1.1 `fulfillment.ts`
- `UnitCandidate` ganhou `deliveryRadiusKm: number | null`; os DOIS resolvedores (`resolveUnitCandidates` por cidade e `resolveUnitCandidatesByProximity`) agora leem `pu.delivery_radius_km` (mapeado na fonte única `mapRowToUnitCandidate`, NUMERIC→Number).
- **`decideStoreForItemsGeo`**: `useProximity = env.ROUTING_PROXIMITY_FIRST` (antes era `&& modalidade==='pickup'` — a ENTREGA entrou). Com a flag on:
  - candidatos = pool por proximidade (sem muro de cidade) nas DUAS modalidades;
  - **②'** filtro barato: modo + (na entrega) **raio PREENCHIDO** (`filterByModeAndRadiusPresence`) — a cobertura de bairro (④a/`passesDeliveryCoverage`) NÃO se aplica no caminho por proximidade;
  - **④a'** corte fino pós-medição: na entrega, a loja só disputa (anel/estoque/only_far) se `distância ≤ raio` (`passesDeliveryRadius`, inclusivo, igual ao anel). Aplicado ANTES da checagem de estoque (corta query de quem está fora).
  - Anéis/régua/estoque IDÊNTICOS (entrega [10,20,30,40], retirada [5,10,15]); retirada NUNCA usa raio.
  - `only_far` na entrega agora só carrega loja que PASSOU no raio (raio é consentimento; além do maior anel = honestidade D3 como antes).
- **`resolveProductAvailabilityByProximity`** (a BUSCA): mesma régua do pedido — com a flag on, pool por proximidade + presença de raio + corte `dist ≤ raio` no inRange. A fala e o registro nunca divergem (decisão Wallace 2026-06-08).
- Sem a flag: caminho de cidade de HOJE, intocado (cobertura de bairro continua valendo) — rollback = flag off no Coolify (desliga retirada E entrega por proximidade juntas).

### 1.2 `geo-routing.ts` (filtros puros)
- `GeoRoutingCandidate` ganhou `deliveryRadiusKm: number | null`.
- Novas funções puras: `filterByModeAndRadiusPresence(candidates, modalidade)` (②') e `passesDeliveryRadius(raio, distKm)` (④a'). `filterByModeAndCoverage`/`passesDeliveryCoverage` intocadas (caminho por cidade).

## 2. Aba "Área de entrega" SIMPLIFICADA (painel do parceiro)
- `parceiro/public/index.html` (ABA 3): ficou SÓ o campo **Município** + botão salvar + nota explicando que a entrega agora é pelo raio (aba Atendimento) e o município é a referência quando o cliente não manda localização. Saíram: radio cidade/bairros, busca de bairro, chips.
- `parceiro/public/app.js`: `areaForm = { municipio }`; `saveArea` manda sempre `{ city_wide: true, neighborhoods: [] }`; removidos `searchBairros`/`addBairro`/`removeBairro` + estados `bairroQuery/bairroResults/bairroSearching`.
- **Backend INTACTO** (decisão de menor risco): `PUT /configuracoes/area` continua aceitando o formato antigo (schema com city_wide/neighborhoods); `GET /configuracoes/bairros` continua existindo (sem uso na UI). Cobertura antiga por bairros no banco fica como está até o dono salvar a área (aí vira 1 linha city) — e exibe no aside como "(modelo antigo — o raio substitui)".

## 3. Provas (tudo verde)
- `npm run typecheck` ✓ · `npm test` **337/337** (7 novos: `passesDeliveryRadius` + `filterByModeAndRadiusPresence` em `tests/unit/atendente/geo-routing.test.ts`).
- **`scripts/prova-proximidade-rede-test.ts` 11/11** (casos novos da Fase 3, env test, BEGIN/ROLLBACK, haversine):
  - 5: ninguém com raio → entrega vai pra MATRIZ (silêncio ≠ consentimento);
  - 6: raio 10 cobre ~8 km → prox-madureira ENTREGA pra Caxias (muro caiu na entrega);
  - 7: raio 5 < ~8 km → matriz (raio é o consentimento);
  - 8: retirada IGNORA o raio;
  - 9a/9b: a BUSCA segue a mesma régua (sem raio não promete; com raio mostra a MESMA loja do pedido).
- **Não-regressão**: `prova-geo-rede-test.ts` 9/9 (caminho por cidade, flag off) · `prova-busca-proximidade-test.ts` tudo verde · `node --check` no app.js.

## 4. ⚠️ GATE DE DEPLOY (decisão do dono — negócio)
A flag `ROUTING_PROXIMITY_FIRST` **já está ON no Coolify** (pela retirada da Fase 1). No instante em que a Fase 3 entrar no `main`, a ENTREGA passa a exigir raio. Estado de prod em 2026-06-09 (`node scripts/checar-raio-prod.cjs`, novo, só-leitura):
- **Só `zz-teste-copacabana` tem raio (12 km).** Os outros 6 (anderson-tavares, rio-do-ouro, zz-teste-barra/madureira/meier/tijuca) estão NULL → ficariam FORA da entrega (retirada segue normal; matriz pega as entregas).
**Sequência recomendada:** (1) dono preenche o raio dos 7 na matriz (Rede → parceiro → "Raio de entrega (Rede)") → (2) push pro main → deploy. Alternativa: subir mesmo assim e preencher em seguida (entregas caem na matriz nesse meio-tempo).

## 5. O que ficou de fora (próximos)
- **Alerta na matriz** quando um pedido sair acima do raio (decisão 2 do dono): com o motor barrando por raio, o caso só existe no caminho SEM coordenada (cidade/plano B), onde não há distância medida. Ficou pra depois (precisa medir distância no ato do pedido manual).
- Fase 2 menor: aviso forte no login do painel; cadastro "Novo parceiro" coletar o raio.
- Antigos: horário das 6 lojas; limpeza PED-0034/zz-teste-*; SEC-002 (sessão dedicada).

## 6. Mapa de código (Fase 3)
- Motor: `src/atendente-v2/fulfillment.ts` (decideStoreForItemsGeo, resolveProductAvailabilityByProximity, mapRowToUnitCandidate) · `src/atendente-v2/geo-routing.ts` (filterByModeAndRadiusPresence, passesDeliveryRadius).
- Painel: `parceiro/public/index.html` (ABA 3 'area') + `parceiro/public/app.js` (areaForm/saveArea).
- Provas: `scripts/prova-proximidade-rede-test.ts` (casos 5-9 novos) · `scripts/checar-raio-prod.cjs` (gate de deploy, só-leitura) · `tests/unit/atendente/geo-routing.test.ts`.

— Sessão 2026-06-09d, orquestrador (Claude Fable 5) — domínios `bot` + `parceiro`.
