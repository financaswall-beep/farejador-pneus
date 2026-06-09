# CLAUDE.md — Memória do projeto Farejador

> Este arquivo é lido AUTOMATICAMENTE pelo Claude Code ao abrir o projeto (por qualquer conta/login).
> É a memória COMPARTILHADA do projeto. O detalhe histórico vive em `docs/SESSAO_*_HANDOFF.md`.
> Mantenha enxuto: só o durável. Atualize quando uma decisão grande mudar.

---

## 1. O que é
Rede de **borracharias** na região metropolitana do Rio. Um **bot no WhatsApp** (via Chatwoot) atende o cliente, descobre o pneu, e **roteia pra loja parceira mais perto** — pra **retirada** ou **entrega** (frete fixo R$9,90) — reservando o pneu. O dono (Wallace) é a **matriz**; as lojas são **parceiras** (pagam comissão).

- **Repo:** github.com/financaswall-beep/farejador-pneus
- **Supabase:** projeto **Farejador** (`aoqtgwzeyznycuakrdhp`), envs `prod` e `test`.
- **Deploy:** **push pro `main` → Coolify faz deploy automático** (~2-10 min). Não precisa redeploy manual.

## 2. Arquitetura (camadas)
- **Parceiro** — painel + banco do parceiro (vendas, estoque, clientes, financeiro/caixa, chat, entregas, retiradas). O DB é do PARCEIRO (tabelas próprias). `src/parceiro/`, `parceiro/public/`.
- **Matriz** — camada que AGREGA os parceiros: cobrança, comissão, funil da Rede, antifraude, candidaturas. `src/admin/`, `src/app/preview-matriz-server.ts`.
- **Bot / atendente-v2** — o agente conversacional (LLM via OpenAI) que atende no Chatwoot, busca produto/frete, cria/consulta pedido, e roteia bot→parceiro→matriz. `src/atendente-v2/`.
- **Ingestão** — Chatwoot → Supabase (webhooks, normalização, persistência). `src/webhooks/`, `src/normalization/`, `src/persistence/`.

## 3. Como mexer (convenções — IMPORTANTE)
- **Migration ANTES do push** (o código novo lê a coluna nova; aplicar via apply_migration). Migrations em `db/migrations/` (já aplicadas até 0092).
- **Test-first** em zona sensível. Provas: `npm run typecheck`, `npm test` (vitest, ~330 testes), e a integração do motor: `npx tsx --env-file=.env scripts/prova-geo-rede-test.ts` (env test, BEGIN/ROLLBACK).
- **Flags** pra mudança arriscada de roteamento (ex.: ROUTING_GEO, PICKUP_TO_PARTNER, ROUTING_GEO_ROAD_DISTANCE, ROUTING_MULTI_CANDIDATE, ROUTING_FAIRNESS). Sobe dormente, liga quando provar.
- **Chave do Google só vive no Coolify** (não no `.env` local) → reverse-geocode/distância de rua NÃO roda local; testar AO VIVO ou via `scripts/testar-geocode.cjs` (pode dar REQUEST_DENIED local se a chave for restrita por IP).
- **Comportamento crítico do bot se garante por CÓDIGO, não por prompt.** Pedir no prompt é probabilístico e falha; quando precisar garantir, force no código (ex.: o nudge determinístico do pino em `agent.ts`).
- `.env` tem FAREJADOR_ENV=test → `checar-naoregressao` SEM `--env-file` dá falso "regressão".
- **Dinheiro/estoque é contrato** (migrations 0076 reservado, 0077 financeiro): mexer com cuidado, snapshot de rollback, auditoria. Ver `SECOES/ESTOQUE.md`.

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
- `commerce.geo_resolutions` = dicionário bairro→cidade (624 bairros, 15 cidades; `resolve_neighborhood`). Cobertura: 7 lojas — rio(5)/niteroi(1)/itaborai(1), todas por cidade.
- Matriz = backstop universal quando nenhum parceiro atende.

## 7. Estado atual (LIVE em prod — main `b4cec2b`)
- **Pino-first** funciona ponta-a-ponta: cliente manda o pino → bot resolve cidade (reverseGeocode) → acha a loja → reserva. Validado ao vivo (PED-0034). O nudge determinístico (`agent.ts`) força o bot a usar a tool quando há pino.
- **Saudação-espelho:** só cumprimentou → "Como posso te ajudar?"; chegou com pedido → cumprimenta + pede localização. ("borracharia mais perto de você").
- **Gatilhos de conversão:** proximidade ("tá a ~X km", ≤5/5-10/>10), escassez (estoque 1-3 → reserva), imediatismo (horário se preenchido + "reservado").
- **Pickup-to-partner** (retirada reserva no parceiro), **camada GEO**, **consentimento de retirada longe**, **gancho de instalação** (taxa à parte) — tudo live. Migrations 0089-0093 aplicadas.
- **Proximidade-primeiro Fase 0-2 LIVE** (ver §8): retirada por distância (sem muro de cidade) ligada; raio de entrega coletado no painel do parceiro E na matriz (ainda NÃO usado no roteamento — isso é a Fase 3).
- **O QUE VAMOS FAZER (roadmap, do mais próximo ao maior):**
  1. Dono preencher o **raio dos 7 parceiros** na matriz (e validar que "Salvar raio" persiste).
  2. **Fase 3 — entrega por proximidade**: a entrega passa a usar o raio (loja entra só se raio preenchido E dist ≤ raio); **junto, simplificar a aba "Área de entrega"** (vira redundante com o raio). Atrás da flag `ROUTING_PROXIMITY_FIRST`.
  3. Fase 2 menor: aviso no login forte; cadastro "Novo parceiro" coletar o raio.
  4. Antigos: preencher **horário das 6 lojas** vazias; limpar dado de teste (PED-0034, zz-teste-*, trocar senha temp do zz-teste-copacabana); **SEC-002** (autorização sem RLS, sessão dedicada — §9).

## 8. Proximidade-primeiro (derruba o "muro da cidade") — Fase 0-2 FEITAS, Fase 3 aberta
**Furo:** o roteamento filtrava por CIDADE antes da distância → cliente de Caxias a 9 km de Madureira caía na matriz. **Virada:** com coordenada, rotear por DISTÂNCIA (anel+estoque+régua decidem); cidade vira plano B + teto de raio por loja. Tudo atrás da flag **`ROUTING_PROXIMITY_FIRST`** (default OFF no código; **o dono já ligou =true no Coolify**).
- **Fase 0+1 (fundação + RETIRADA) — LIVE em prod.** Migration 0093 `delivery_radius_km`; `resolveUnitCandidatesByProximity` (sem muro de cidade); retirada por proximidade ligada. Rollback = flag false no Coolify.
- **Fase 2 (coleta do raio) — FEITA e LIVE** (2026-06-09): campo "até quantos km você entrega?" no **painel do parceiro** (aba Atendimento) + editor "Raio de entrega (Rede)" na **matriz** (detalhe do parceiro, página 'unidade'). Os dois gravam `network.partner_units.delivery_radius_km` (fonte única; matriz só edita quem faz entrega — trava de autonomia). Provas: `scripts/prova-raio-entrega-test.ts` + `prova-raio-matriz-test.ts` (6/6 cada).
- **Fase 3 (ENTREGA por proximidade) — ABERTA:** entrega passa a usar o raio (loja entra só se `delivery_radius_km` preenchido E dist ≤ raio); hoje o raio só é COLETADO, o motor ainda NÃO lê — a entrega ainda usa cobertura de bairro (`passesDeliveryCoverage`). **Junto da Fase 3: simplificar a aba "Área de entrega"** (fica redundante com o raio).
**Detalhe:** `docs/SESSAO_2026-06-09c_FASE2_PAINEL_MATRIZ_HANDOFF.md` (Fase 2) + `..._09b_PROXIMIDADE_HANDOFF.md` (plano/Fase 0-1).

## 9. Segurança
- **SEC-001 RESOLVIDO** (bot não vaza pedido de outro cliente — amarra contact_id).
- Auditoria RLS: nada de cliente/financeiro vaza entre parceiros (partner_* têm RLS+policy).
- Aberto: SEC-002 (autorização sem RLS) — fix arriscado, sessão dedicada. Ver `docs/SEGURANCA.md`.
- Revisar caminho que expõe dado de cliente/parceiro ANTES de mexer (usar agente `seguranca`).

## 10. Onde achar mais
- **Handoffs de sessão:** `docs/SESSAO_*_HANDOFF.md` (no git — o histórico detalhado).
- **Manual de contratos por seção:** `SECOES/` (ex.: ESTOQUE.md).
- **Memória privada do orquestrador** (local, NÃO no git): `~/.claude/projects/C--Farejador-agente/memory/` — `project_*` (cada frente), `feedback_*` (estilo do dono), `parceiro_*`. É o detalhe vivo; este CLAUDE.md é a destilação compartilhada.
