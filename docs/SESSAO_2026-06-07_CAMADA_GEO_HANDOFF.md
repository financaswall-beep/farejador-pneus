# HANDOFF — Camada GEO de Proximidade da Rede (sessão 2026-06-07)

> **Para a próxima LLM:** este documento é **auto-contido**. Leia inteiro antes de mexer.
> A camada de proximidade (escolher a borracharia por KM real, não por cidade inteira)
> está **construída, testada, deployada e sendo ligada em produção**. O que falta é
> **validação ao vivo + ajuste fino**, não construção.
>
> Spec/decisões: `docs/PLANO_CAMADA_GEO_PROXIMIDADE_REDE_2026-06-06.md` (LER §2 e §3).
> Dono: **Wallace** (leigo em código, decisões de negócio/dinheiro são dele).

---

## 1. TL;DR do que foi feito nesta sessão

1. **Construção (6 fases, test-first, atrás de flag OFF)** — camada geo completa.
2. **Deploy** — push pro `main`, Coolify deploya automático. Código no ar **dormente**
   (flag OFF = comportamento idêntico ao de hoje).
3. **Dados de prod** — coordenadas reais aplicadas nas borracharias; cenário de teste
   real montado (5 borracharias cobrindo o Rio).
4. **Google Maps Platform** — Wallace montou a API (Distance Matrix + Geocoding) e
   pôs a chave + flags no Coolify (redeploy feito) → camada **sendo ligada de fato**.
5. **Reset total de teste** em prod — banco limpo pra validar o geo do zero.

**Suíte:** 314 testes vitest + `npm run typecheck` **verdes** após cada fase.

---

## 2. Estado do Git / Deploy

- **Repo:** `financaswall-beep/farejador-pneus` (remote `origin`).
- **Branch de trabalho:** `feat/camada-geo-rede` (pushada). HEAD = `ebce0eb`.
- **`main` (= deployado em prod):** `f84069c`. Coolify faz **deploy automático no push pro main**.
- **Commits da camada geo** (em ordem): `ca6a459` (Fase 1) → `4cb0acb` (Fase 2) →
  `2652b52` (Fase 3) → `b15e64c` (Fase 4) → `f84069c` (Fase 5, = main). Depois:
  `be876b9` (script de coords), `ebce0eb` (scripts de limpeza) — **na branch, não no main**.
- O net-novo que foi pro prod = só os 5 commits geo, **todos flag OFF**.

⚠️ **Coolify** guarda as env vars (eu NÃO acesso o env/logs do Coolify). Flips de flag e
a chave do Google são ação do Wallace lá.

---

## 3. Arquitetura — onde está o código

**Puro (sem I/O, testável):**
- `src/shared/geo/haversine.ts` — distância em linha reta (grátis, rede de segurança).
- `src/shared/geo/ring.ts` — `selectWithinExpandingRing` (anel que cresce) + constantes
  `GEO_RING_KM=[10,20,30]` (entrega), `GEO_PICKUP_RADIUS_KM=15` (retirada).
- `src/atendente-v2/geo-routing.ts` — filtros puros: `servesModalidade` (②),
  `passesDeliveryCoverage` (④a, só entrega), `filterByModeAndCoverage`, `ringsForModalidade`.

**Google (opcional, atrás de chave):**
- `src/shared/geo/google-maps.ts` — `geocodeAddress` + `roadDistanceKm` (Distance Matrix).
  `fetch` nativo, timeout 3s, try/catch → cai no haversine. **`apiKey` vem por parâmetro**
  (não importa `env` de propósito → testável). Endpoint: `maps.googleapis.com/maps/api/distancematrix/json`.

**Integração (motor):**
- `src/atendente-v2/fulfillment.ts`:
  - `resolveUnitCandidates` — estendido: agrega cobertura (`has_city_coverage` +
    `neighborhoods`) e traz `latitude`/`longitude`. (DISTINCT ON → GROUP BY pelas PKs.)
  - `decideStoreForItemsGeo` — **o cérebro**. Pipeline: ②modo+④a (puro) → ③estoque
    completo (DB) → ④anel que cresce → ⑤régua de justiça (`rankUnitsByFairnessFromDb`,
    intocada). Retorna `partner` | `only_far` (caso E) | `matriz`. `resolveDistances`:
    haversine sempre + distância de rua do Google por cima se `ROUTING_GEO_ROAD_DISTANCE`+chave.
- `src/atendente-v2/customer-location.ts` — `getLatestCustomerLocation` (lê o pino mais
  recente da conversa; escopo por `environment`+`conversationId` — não vaza, não reabre SEC-001).
- `src/atendente-v2/history.ts` — marcador `[O cliente compartilhou a localização dele 📍]`
  (GATED por `includeLocationMarkers`; o pino chega sem texto e a query principal o descartava).
- `src/atendente-v2/tools.ts` — `decideStoreGeoOrFallback` (FONTE ÚNICA dos dois caminhos
  `calcular_frete` e `criar_pedido` → cotação e pedido escolhem a MESMA loja). Coordenada:
  pino → senão geocode do bairro → senão fallback por cidade. `criar_pedido` ganhou param `bairro`.
- `src/atendente-v2/prompt.ts` — `GEO_PROMPT_BLOCK` (pedir localização, honestidade no caso E).
- `src/atendente-v2/agent.ts` — anexa o `GEO_PROMPT_BLOCK` só com `ROUTING_GEO` on.

**Flags** (`src/shared/config/env.ts`): `ROUTING_GEO`, `ROUTING_GEO_ROAD_DISTANCE` (ambas
`booleanStringSchema` default false), `GOOGLE_MAPS_API_KEY` (`z.string().min(1).optional()`).

---

## 4. Decisões travadas pelo dono (não reabrir) — ver spec §2

D1 raio entrega 10→20→30km · D2 retirada 15km · D3 "só tem longe" = HONESTIDADE (bot avisa
+ oferece opções) · D4 dentro do anel a **justiça** decide (não a mais colada) · D5 distância
de rua do Google é o padrão, haversine é backup · D6 área de bairro vale só p/ ENTREGA · D7
frete continua fixo (R$ 9,90). Herdadas do motor de justiça: janela 7 dias, novato semeado na mediana.

---

## 5. Configuração em produção (06-07)

- **Cenário real:** 5 borracharias de teste cobrindo "rio de janeiro" (slugs
  `zz-teste-copacabana/meier/madureira/tijuca/barra`, modo `both`, cobertura cidade), +
  `anderson-tavares` (niteroi) + `borracharia-rio-do-ouro` (itaborai), 1 cada.
- **Coordenadas** aplicadas (`scripts/set-geo-coords-prod.cjs --commit`): as 7 com lat/long reais.
- **Estoque** das 5 do Rio: 90/90-18 e 140/70-17 (≈10 un. cada).
- **Google:** projeto `flowise`, **Distance Matrix API + Geocoding API ATIVADAS**, chave
  "Maps Platform API Key" **restrita às 2 APIs**, plano **pagamento-por-uso**.
- **Coolify (env vars setadas pelo Wallace + redeploy):** `GOOGLE_MAPS_API_KEY`,
  `ROUTING_GEO=true`, `ROUTING_GEO_ROAD_DISTANCE=true`, `ROUTING_MULTI_CANDIDATE=true`,
  `ROUTING_FAIRNESS=true`.
- **Reset total de teste** aplicado (`scripts/reset-teste-total-prod.cjs --commit`): zerou
  2 conversas, 4 pedidos, 4 leads, 2 reservas. **Preservou** catálogo + 5 borracharias +
  coords + 100 un. de estoque + payables/expenses. Justiça neutra, estoque cheio.

---

## 6. PRÓXIMOS PASSOS (o que a próxima LLM deve fazer)

1. **Validar ao vivo** (o que falta de verdade): Wallace conversa no WhatsApp pedindo um
   90/90-18 (ou 140/70-17), **entrega**, dando um bairro do Rio ou o pino. Então:
   - Ler no banco qual borracharia o pedido caiu + a distância (ver §8 "como provar").
   - Conferir em **Distance Matrix API → Métricas** (Google Cloud) se a chamada apareceu
     (prova de que a chave pegou no deploy).
2. **(Manual do Wallace)** apagar as 2 conversas antigas no **Chatwoot UI** (senão o webhook recria).
3. **Ajuste opcional:** se Wallace achar que está mandando pra loja "perto no mapa mas não a
   mais perto", encolher o **primeiro anel de 10km → 5km** (`GEO_RING_KM` em `ring.ts`). 1 linha.
4. **Segurança da chave:** adicionar restrição por **Endereços IP** (IP do servidor Coolify)
   na chave do Google — ficou deferida (precisa do IP do servidor).
5. **Portão FORMAL banco/seguranca** — Wallace **dispensou por ora** (auto-check inline passou).
   Reconsiderar antes de escalar pra muitos parceiros reais.

---

## 7. ARMADILHAS / GOTCHAS (não tropeçar)

- ⚠️ **`GOOGLE_MAPS_API_KEY` VAZIA no Coolify quebra o boot** — o schema é
  `z.string().min(1).optional()`: string vazia falha `min(1)` e `parseEnv` lança. Ou bota a
  chave real, ou **remove a variável** (não deixa `=` vazio).
- **D4 não é bug:** dentro de ~10km a justiça distribui (cliente de Méier pode cair em Tijuca).
  Foi decisão do dono (anti-monopólio da loja movimentada). Pro cliente o bot fala "a mais perto".
- **Limpeza usa TRUNCATE, não DELETE** — o `analytics.fact_evidence` tem trigger append-only
  que **bloqueia DELETE**; TRUNCATE passa por baixo. Os scripts de limpeza têm **guard** que dá
  ROLLBACK se o CASCADE encostar em tabela protegida (commerce/units).
- **`vitest` NÃO carrega `.env` nem tem setup** → um módulo testado **não pode importar `env`**
  (o boot do env quebra sem as vars). Por isso `google-maps.ts` recebe `apiKey` por parâmetro.
- **`checar-naoregressao-roteamento.cjs` roda SEM `--env-file`** (o `.env` tem
  `FAREJADOR_ENV=test` → daria falso negativo; sem --env-file vira `prod`).
- **Coolify deploya o `main` automático no push.** Cuidado com o que sobe pro main.
- **Geo só vale pra ENTREGA hoje.** `criar_pedido` só roteia geo em delivery (igual hoje);
  **pickup → matriz** (restrição H4: COD na retirada gera recebível fantasma). Caso C (retirada
  por 15km) está no motor mas **não plugado no `criar_pedido`** — follow-up se quiser.

---

## 8. Como provar/testar (comandos)

- **Unit:** `npm run typecheck` && `npx vitest run` (314 verdes). Testes geo em
  `tests/unit/geo/` e `tests/unit/atendente/`.
- **Prova no env `test` (DB real, BEGIN/ROLLBACK):**
  - `node --env-file=.env scripts/seed-fake-rede-test.cjs` (cria 4 fakes por município + 8
    geo-fakes em "zona-sul-geo" com as 7 coords).
  - `npx tsx --env-file=.env scripts/prova-geo-rede-test.ts` (7 casos: A feliz, I justiça,
    B expande, C retirada, D bairro não declarado, E só-longe, determinismo).
  - `ROUTING_MULTI_CANDIDATE=true ROUTING_FAIRNESS=true npx tsx --env-file=.env scripts/prova-regua-rede-test.ts`
    (não-regressão da justiça por cidade).
- **Decisão geo contra dados de PROD (read-only):** chamar `decideStoreForItemsGeo` com
  `environment='prod'`, `municipio='rio de janeiro'`, um `customerLocation`, em BEGIN/ROLLBACK.
  (Sem chave Google local = haversine; a decisão é a mesma lógica.)
- **Ler resultado de um pedido real:** `commerce.orders` (order_number, unit_id) +
  `commerce.partner_orders` (unit_id, status). O `unit_id` diz qual borracharia pegou.

---

## 9. Scripts operacionais (todos com DRY-RUN/guard)

- `scripts/set-geo-coords-prod.cjs` — popula lat/long dos parceiros (dry-run / `--commit`).
- `scripts/reset-teste-total-prod.cjs` — reset total de teste (dry-run / `COMMIT=1`). Guard
  aborta se cascade tocar protegida.
- `scripts/limpar-conversas-prod.cjs` — limpa só conversas/bot/analytics/raw (variante menor).
- `scripts/seed-fake-rede-test.cjs` / `scripts/limpar-fake-rede-test.cjs` — fakes do env `test`.

---

## 10. Memória persistente (contexto entre sessões)

Arquivo-índice: `MEMORY.md`. Relevantes: `project_camada_geo.md` (esta camada),
`project_fase2_motor_distribuicao.md` (régua de justiça), `project_regra_distribuicao_rede.md`
(as decisões da régua), `feedback_assinatura_agente.md` (assinar o especialista + modelo ao final),
`feedback_delega_arquitetura.md` (Wallace delega decisões técnicas; só traz opção quando é
decisão de negócio/dinheiro/irreversível, em linguagem de leigo).

*Fim do handoff. Dúvida de negócio → Wallace. Dúvida de arquitetura → ler a spec + este doc.*
