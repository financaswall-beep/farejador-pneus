# CLAUDE.md — Memória do projeto Farejador

> Este arquivo é lido AUTOMATICAMENTE pelo Claude Code ao abrir o projeto (por qualquer conta/login).
> É a memória COMPARTILHADA do projeto. O detalhe histórico vive em `docs/SESSAO_*_HANDOFF.md`.
> Mantenha enxuto: só o durável. Atualize quando uma decisão grande mudar.

---

## 1. O que é
Rede de **borracharias** na região metropolitana do Rio. Um **bot no WhatsApp** (via Chatwoot) atende o cliente, descobre o pneu, e **roteia pra loja parceira mais perto** — pra **retirada** ou **entrega** (frete fixo R$9,90) — reservando o pneu. O dono (Wallace) é a **matriz**; as lojas são **parceiras** (pagam comissão).

- **Repo:** github.com/financaswall-beep/farejador-pneus
- **Supabase:** projeto **Farejador** (`aoqtgwzeyznycuakrdhp`), envs `prod` e `test`.
- **Deploy:** push pro `main` → **Wallace aperta Deploy no Coolify** (palavra do dono 06-11: NÃO sobe sozinho; registros antigos diziam "automático" — não confiar). Pós-deploy, conferir DE FORA que subiu: `curl` no painel (`farejador.smarttecsolutions.com.br/parceiro/<slug>/`) e comparar etiqueta `?v=`/hash com o main (provado 06-11: prod == main byte a byte).

## 2. Arquitetura (camadas)
- **Parceiro** — painel + banco do parceiro (vendas, estoque, clientes, financeiro/caixa, chat, entregas, retiradas). O DB é do PARCEIRO (tabelas próprias). `src/parceiro/`, `parceiro/public/`.
- **Matriz** — camada que AGREGA os parceiros: cobrança, comissão, funil da Rede, antifraude, candidaturas. `src/admin/`, `src/app/preview-matriz-server.ts`.
- **Bot / atendente-v2** — o agente conversacional (LLM via OpenAI) que atende no Chatwoot, busca produto/frete, cria/consulta pedido, e roteia bot→parceiro→matriz. `src/atendente-v2/`.
- **Ingestão** — Chatwoot → Supabase (webhooks, normalização, persistência). `src/webhooks/`, `src/normalization/`, `src/persistence/`.

## 3. Como mexer (convenções — IMPORTANTE)
- **Migration ANTES do push** (o código novo lê a coluna nova; aplicar via apply_migration). Migrations em `db/migrations/` (já aplicadas até 0098).
- **Test-first** em zona sensível. Provas: `npm run typecheck`, `npm test` (vitest, ~400 testes), e a integração do motor: `npx tsx --env-file=.env scripts/prova-geo-rede-test.ts` (env test, BEGIN/ROLLBACK). Banco direto dá ENOTFOUND em rede sem IPv6 → usar `--env-file=.env.pooler` (pooler IPv4).
- **Flags** pra mudança arriscada de roteamento (ex.: ROUTING_GEO, PICKUP_TO_PARTNER, ROUTING_GEO_ROAD_DISTANCE, ROUTING_MULTI_CANDIDATE, ROUTING_FAIRNESS). Sobe dormente, liga quando provar.
- **Chave do Google só vive no Coolify** (não no `.env` local) → reverse-geocode/distância de rua NÃO roda local; testar AO VIVO ou via `scripts/testar-geocode.cjs` (pode dar REQUEST_DENIED local se a chave for restrita por IP).
- **Comportamento crítico do bot se garante por CÓDIGO, não por prompt.** Pedir no prompt é probabilístico e falha; quando precisar garantir, force no código (ex.: o nudge determinístico do pino em `agent.ts`).
- `.env` tem FAREJADOR_ENV=test → `checar-naoregressao` SEM `--env-file` dá falso "regressão".
- **Dinheiro/estoque é contrato** (migrations 0076 reservado, 0077 financeiro): mexer com cuidado, snapshot de rollback, auditoria. Ver `SECOES/ESTOQUE.md`.
- **Painel do parceiro: teto de 300 linhas por arquivo** (`parceiro/public/app*.js`). A obra 2026-06 fatiou o `app.js` (4.755→263) em 24 módulos (fábricas em `window.PARCEIRO_MODULES`, montadas via `getOwnPropertyDescriptors` — NUNCA spread, que congela getter). Fiscal: `npm run checar-tamanho` (falha >300). Ao tocar o painel: manter ≤300 e rodar `npm run prova-painel` (paridade de interface + contratos de rede + tamanho). Plano/handoffs: `docs/PLANO_REFATORACAO_PAINEL_300_2026-06-10.md`.

## 4. Como trabalhar com o Wallace (estilo — SEGUIR)
- Fala **pt-BR carioca**, direto. Ele é dono de loja, visão arquitetural clara, mas **leigo em código**.
- Seja **crítico e direto, não concordância automática** — ele quer que eu discorde quando tenho razão, e compara conselhos entre IAs. Aponte riscos, não só elogie.
- **Decisões técnicas ele delega a mim** (posso recrutar agentes). Só trago OPÇÃO quando é decisão DELE: **negócio, dinheiro, irreversível** — e em **linguagem de leigo**.
- Ao fim de cada resolução, **assinar** qual especialista do time fez + o modelo (ex.: "— Orquestrador (Claude Opus 4.8) — domínio `bot`").
- **Não derrubar** preview/recursos em execução por conta própria; deixar de pé e avisar (porta/id).
- Vocabulário: falar **"motor por cidade / por bairro"**, nunca "motor v1/v2" (v2 é a geração atual do atendente).
- Delegar ao Sonnet só se eu julgar que dá conta; zona sensível/dúvida fica no Opus.

## 5. Time de agentes (`.claude/agents/` — LOCAL, gitignored)
`bot` e `parceiro` e `matriz` e `banco` e `seguranca` rodam em Opus (zona sensível); `coletor`/`escriba`/`executor`/`front` em Sonnet (tarefas mecânicas). Use o especialista do domínio. ⚠️ Essa pasta NÃO está no git — não viaja pra outra máquina (só pro mesmo PC).

## 6. O motor de roteamento (o coração)
`src/atendente-v2/fulfillment.ts` → `decideStoreForItemsGeo`:
1. **Candidatos** (`resolveUnitCandidates(municipio)`) ← hoje filtra por CIDADE (o "muro" — ver §8).
2. **Modo + cobertura** (`geo-routing.ts`: pickup ignora cobertura de bairro; entrega respeita).
3. **Estoque** (só loja que TEM o pneu, respeita `deleted_at`).
4. **Anel que cresce** (`ring.ts`): retirada FAIXAS [5,10,15] km, entrega [10,20,30,40] km. Banda mais perto ganha.
5. **Régua de justiça** (`rankUnitsByFairnessFromDb`): entre os do anel, ganha quem recebeu MENOS leads (anti-favorecimento). Nunca pula de banda.
- Coordenada do cliente: pino do WhatsApp (`getLatestCustomerLocation`) ou bairro geocodado (Google). Distância de RUA (Distance Matrix) com haversine de fallback.
- **Escala 100 lojas (obra 2026-06-12):** chamadas ao Google passam pelo cache `commerce.geo_cache` (0098; `geo-cache.ts`, read-through FAIL-OPEN, flag `GEO_CACHE` default on); Distance Matrix mede só as `GEO_ROAD_TOPK` (12) mais próximas em linha reta; partições mensais se criam SOZINHAS (0096, pg_cron dia 20) — julho/2026 não derruba mais a ingestão; 24 índices de FK (0097).
- `commerce.geo_resolutions` = dicionário bairro→cidade (624 bairros, 15 cidades; `resolve_neighborhood`). Cobertura: 7 lojas — rio(5)/niteroi(1)/itaborai(1), todas por cidade.
- Matriz = backstop universal quando nenhum parceiro atende. **✅ Decisão 06-27 ENTREGUE 06-29 — a matriz é "MAIS UMA LOJA"** (concorre IGUAL aos parceiros por proximidade+régua, retirada+entrega; anel entrega 40 km / retirada 15 km, Maps Petiti/SG). 3 tijolos FEITOS, atrás da flag `ROUTING_MATRIZ_AS_STORE` (exige `WHOLESALE_UNIFIED_STOCK` on, ambas ligadas no Coolify): **tijolo 1** = matriz entra no fim do `decideStoreForItemsGeo` SÓ quando nenhum parceiro está no pool (nunca fura a régua), estoque do GALPÃO via `getMatrizWholesaleStockQty`, dist por haversine ≤ maior anel; **tijolo 2** = baixa do galpão na venda; **tijolo 3** = retirada no galpão (`MATRIZ_MAPS_URL`). `buscar_produto` e `localizacao_loja` também enxergam a matriz como loja perto (≤15 km retirada normal; 15-40 km vira `retirada_so_longe` com distância+minutos de carro via Google — cliente decide). Prova de integração: `npx tsx --env-file=.env.pooler scripts/prova-matriz-loja-test.ts` (6/6; prova-geo 9/9 com flag off = não-regressão). ⚠️ Falta validar ENTREGA pela matriz ao vivo (frete escalonado 9,90/13/19). Ver memória `project_matriz_como_loja`.

## 7. Estado atual (LIVE em prod — main `036497a`)
- **Matriz como loja LIVE** (sessão 06-29, ver §6 + handoff `docs/SESSAO_2026-06-29_MATRIZ_COMO_LOJA_E_FIXES_BOT_HANDOFF.md`). Banco de teste ZERADO 06-29 (conversas+pedidos+analytics limpos; estoque/cadastros/galpão preservados) — pronto pra cliente real após a faxina do go-live.
- **Fixes do bot 06-29 (todos LIVE):** (1) `productNudge` em `agent.ts` força `buscar_produto` quando o cliente manda uma medida (regex) — matava o "Tenho sim" de cabeça; (2) nome do cliente só na saudação (não em todo turno — soava robótico); (3) anti-eco em `agent.ts` descarta resposta idêntica ao turno anterior (cliente manda 2 msgs seguidas → não duplica); (4) `localizacao_loja`/`buscar_produto` mostram distância + minutos de carro da matriz (Google Distance Matrix, `matrizRoadInfo`/`cachedMatrizRoadInfo`, cache invalida entradas sem `durationMinutes`).
- **Pino-first** funciona ponta-a-ponta: cliente manda o pino → bot resolve cidade (reverseGeocode) → acha a loja → reserva. Validado ao vivo (PED-0034). O nudge determinístico (`agent.ts`) força o bot a usar a tool quando há pino.
- **Saudação-espelho:** só cumprimentou → "Como posso te ajudar?"; chegou com pedido → cumprimenta + pede localização. ("borracharia mais perto de você").
- **Bot não engole a 2ª mensagem** (06-27, main `d6aaa93`, aguarda Deploy/teste): a trava anti-requentado (`stale-trigger.ts` + `worker.ts`) olha QUAL mensagem já foi respondida (`agent.turns.status='delivered'` — `delivered_message_id` é coluna MORTA), não o relógio da última resposta. Cliente manda "oi"+"tem pneu?" e o bot responde o pneu (antes engolia quando a saudação saía atrasada). Conserto por CÓDIGO, prompt intocado.
- **Gatilhos de conversão:** proximidade ("tá a ~X km", ≤5/5-10/>10), escassez (estoque 1-3 → reserva), imediatismo (horário se preenchido + "reservado").
- **Pickup-to-partner** (retirada reserva no parceiro), **camada GEO**, **consentimento de retirada longe**, **gancho de instalação** (taxa à parte) — tudo live. Migrations 0089-0093 aplicadas.
- **Proximidade-primeiro COMPLETA — Fases 0/1/2/3 TODAS LIVE em prod** (commit `554b6d2`, 2026-06-09; ver §8): retirada E entrega por distância ligadas; entrega entra só se raio preenchido E dist ≤ raio. Os 7 raios foram preenchidos com valores de **TESTE** (pra induzir o bot ao erro) — trocar pelos reais depois dos testes. Dados de teste do bot LIMPOS (PED-0034 etc.).
- **O QUE VAMOS FAZER (roadmap, do mais próximo ao maior):**
  1. **Validar a Fase 3 ao vivo:** apagar as conversas no Chatwoot (senão o webhook recria) → rodar o roteiro de 6 pinos que estressa o raio (Centro→Méier, Barra→matriz, Barra retirada→atende, Caxias→entrega fora da cidade, etc.) → depois **trocar os raios de teste pelos REAIS** de cada parceiro.
  2. Fase 2 menor: aviso no login forte; cadastro "Novo parceiro" coletar o raio.
  3. Alerta na matriz pra pedido acima do raio no caminho SEM coordenada (decisão 2 do dono — ficou de fora da Fase 3).
  4. Antigos: preencher **horário das 6 lojas** vazias; **SEC-002** (autorização sem RLS, sessão dedicada — §9). (Senha temp da zz-teste-copacabana: trocada em 06-10, com o dono; resetar = `scripts/resetar-senha-parceiro.cjs`.)

## 8. Proximidade-primeiro (derruba o "muro da cidade") — COMPLETA, Fases 0/1/2/3 LIVE
**Furo:** o roteamento filtrava por CIDADE antes da distância → cliente de Caxias a 9 km de Madureira caía na matriz. **Virada:** com coordenada, rotear por DISTÂNCIA (anel+estoque+régua decidem); cidade vira plano B; na entrega, o RAIO declarado por loja é o teto. Tudo atrás da flag **`ROUTING_PROXIMITY_FIRST`** (default OFF no código; **o dono ligou =true no Coolify**). Rollback = flag false (desliga entrega+retirada por proximidade juntas).
- **Fase 0+1 (fundação + RETIRADA) — LIVE.** Migration 0093 `delivery_radius_km`; `resolveUnitCandidatesByProximity` (sem muro de cidade); retirada por proximidade ligada.
- **Fase 2 (coleta do raio) — LIVE** (2026-06-09): campo "até quantos km você entrega?" no **painel** (aba Atendimento) + editor "Raio de entrega (Rede)" na **matriz** (página 'unidade'). Gravam `network.partner_units.delivery_radius_km` (fonte única; matriz só edita quem faz entrega — trava de autonomia).
- **Fase 3 (ENTREGA por proximidade) — LIVE** (commit `554b6d2`, 2026-06-09): com a flag on, a entrega usa o pool por proximidade e a loja só entra se `delivery_radius_km` preenchido E dist ≤ raio (`filterByModeAndRadiusPresence` + `passesDeliveryRadius` em `geo-routing.ts`); a cobertura de bairro só vale no caminho por cidade (flag off). A BUSCA segue a mesma régua (nunca diverge do pedido). Aba "Área de entrega" do painel SIMPLIFICADA (só município/plano B; bairros saíram). Provas: prova-proximidade 11/11, prova-geo 9/9, 337 unit. **Os 7 raios estão com valores de TESTE** (induzir erro) — trocar pelos reais após validar ao vivo.
**Detalhe:** `docs/SESSAO_2026-06-09d_FASE3_ENTREGA_RAIO_HANDOFF.md` (Fase 3) + `..._09c_FASE2_PAINEL_MATRIZ_HANDOFF.md` (Fase 2) + `..._09b_PROXIMIDADE_HANDOFF.md` (plano/Fase 0-1).

## 9. Segurança
- **SEC-001 RESOLVIDO** (bot não vaza pedido de outro cliente — amarra contact_id).
- Auditoria RLS: nada de cliente/financeiro vaza entre parceiros (partner_* têm RLS+policy).
- Aberto: SEC-002 (autorização sem RLS) — fix arriscado, sessão dedicada. Ver `docs/SEGURANCA.md`.
- Revisar caminho que expõe dado de cliente/parceiro ANTES de mexer (usar agente `seguranca`).

## 10. Onde achar mais
- **Handoffs de sessão:** `docs/SESSAO_*_HANDOFF.md` (no git — o histórico detalhado).
- **Manual de contratos por seção:** `SECOES/` (ex.: ESTOQUE.md).
- **Memória privada do orquestrador** (local, NÃO no git): `~/.claude/projects/C--Farejador-agente/memory/` — `project_*` (cada frente), `feedback_*` (estilo do dono), `parceiro_*`. É o detalhe vivo; este CLAUDE.md é a destilação compartilhada.

## 11. Atacado da Matriz (o "filé" do dono — LIVE)
O dono é **atacadista de pneu usado**: vende pros borracheiros (o Farejador é o pump pra eles venderem e RECOMPRAREM dele). A matriz tem o ciclo de atacado em `commerce.wholesale_*` — dado **SÓ da matriz, ZERO grant pro parceiro** (regra de ouro provada nas migrations). UI na aba **Vendas → Atacado** do painel da matriz (`painel/public/`).
- **No main `d6aaa93`:** **Fase 1** (venda pro borracheiro + ranking de recompra), **Fase 2** (estoque do galpão por MEDIDA + busca + baixa do ATACADO atrás de `WHOLESALE_STOCK_DECREMENT` OFF), **Fase 3** (custo + lucro), **custo médio** (entrada ponderada), **Fase 4** (06-27 — galpão no padrão do parceiro: medida em NÚMEROS larg/alt/aro `0113` + cadastro valida contra o catálogo, endireita formato e barra fantasma via `tireSizeKey`; `wholesale-catalog.ts`), e a **BAIXA do galpão no VAREJO da matriz** (06-27 — bot+balcão abatem `wholesale_stock` por produto→tireSizeKey, SÓ-matriz, `applyMatrizGalpaoDecrement`, flag `WHOLESALE_MATRIZ_DECREMENT` ON; aguarda Deploy).
- **Modelo:** estoque por **MEDIDA simples** (sem dianteiro/traseiro — decisão do dono); custo **MÉDIO ponderado** (botão "+ Entrada" soma a compra e recalcula a média; "Definir" grava direto). A venda **congela o custo** (snapshot) e o lucro = (preço−custo)×qtd; card Faturamento/Custo/Lucro.
- Migrations **0110/0111/0112/0113**. Detalhe: `docs/SESSAO_2026-06-27_GALPAO_BOT_BAIXA_E_O_QUE_FALTA_HANDOFF.md` (Fase 4 + bot + baixa + **o que falta**) + `..._2026-06-22_ATACADO_*`.
- ⚠️ Lição: subquery no INSERT reusando `$1` env_t dá **42P08** (text vs env_t) → buscar à parte. Ao mexer no `app.js`/`css` do painel: **bumpar o `?v=`** no `index.html` (cache-bust).
- **Roadmap (quando a dor aparecer):** rastrear compras **por FORNECEDOR (PEPS)** p/ "quem pesa na média" e "qual encalha" — adiado de propósito (operar o médio primeiro).
