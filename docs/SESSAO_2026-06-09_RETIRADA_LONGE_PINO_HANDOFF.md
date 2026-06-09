# Handoff — Retirada longe (consentimento) + Pino + Tom carioca + BUG do pino

> Data: 2026-06-09. Sessão: orquestrador Opus 4.8 + dono (Wallace).
> Estado: **commit `0c7a6dc` DEPLOYADO em prod** (migration 0092 aplicada). Um teste ao vivo PASSOU,
> outro destampou um **bug do pino** (não quebra nada, mas precisa de conserto + redeploy).

---

## 0. TL;DR pra próxima IA
Hoje subimos 5 coisas (consentimento de retirada longe, gancho de instalação dormente, saudação
pedindo o **pino** primeiro, tom carioca "perto de **você**", e o `only_far` carregando a rota).
Testes ao vivo: ✅ **o bot lê o estoque do parceiro e respeita o apagado** (prova forte: loja do lado
apagada → mandou pra outra 6km); ⚠️ régua-vs-proximidade ficou ambíguo num teste; ⏳ consentimento
(Bangu) ainda não testado. **Bug aberto:** a saudação pede o pino, mas o pino **sozinho** não resolve
a CIDADE → o bot pede o bairro de novo (parece quebrado). **Fix definido, não implementado:**
`reverseGeocode(pino) → cidade`. É ADITIVO — **não toca** no caminho do bairro escrito.

---

## 1. O que foi implementado e DEPLOYADO (commit `0c7a6dc` → main)
Arquivos: `src/atendente-v2/fulfillment.ts`, `tools.ts`, `prompt.ts`,
`scripts/prova-geo-rede-test.ts`, `db/migrations/0092_partner_unit_installation_fee.sql`.

1. **Retirada longe com CONSENTIMENTO** (decisão Wallace): cliente fora do teto de retirada
   (faixas `[5,10,15]`km) que QUER retirar não trava mais. O teto só impede o bot de SUGERIR longe;
   se o cliente bancar ("eu passo aí e pego"), o bot reserva na loja mais perto que tem.
   - `fulfillment.ts`: `GeoStoreDecision.only_far` passou a **carregar a `routing`** (a loja mais
     perto dos longes, pronta pra reservar sem rebuscar).
   - `tools.ts criar_pedido`: arg novo `confirma_retirada_distante` (boolean). Só o bot marca, e
     SÓ depois que o cliente confirma. `only_far` + flag → reserva; sem flag → recusa como antes.
   - `tools.ts localizacao_loja`: `retirada_so_longe` agora devolve TAMBÉM o cartão da loja
     (nome/endereço/maps_url/taxa_instalacao) pro bot passar quando o cliente insiste.
   - **NÃO vira regra:** decisão por conversa, nada persistido sobre a região. Nasceu loja perto →
     ela ganha sozinha no anel e o caminho de consentimento nem é alcançado.

2. **Gancho de INSTALAÇÃO (dormente):** migration **0092** =
   `network.partner_units.installation_fee_brl NUMERIC(10,2) NULL`. **APLICADA em prod** (via
   apply_migration, ANTES do push). Nasceu NULL em todas as lojas. `getUnitDisplayById` lê a coluna;
   `localizacao_loja` expõe `taxa_instalacao`. NULL → bot diz "instala sim, à parte, confirmo o valor"
   (não inventa preço); preenchido → cota "instalação R$ X". NÃO entra no total do pedido (passo
   financeiro futuro). Decisão Wallace: instala = sim (cobra à parte); ele vai alinhar o valor com
   cada borracheiro e me passar pra preencher por loja.

3. **Saudação pede o PINO primeiro** (distância exata): "tem como você me mandar a sua localização 📍
   pra eu ver a unidade mais próxima de você?"; bairro vira reserva se o cliente não mandar o pino.
   (A plumbing do pino já existia: `core.message_attachments file_type='location'` →
   `getLatestCustomerLocation`.) **⚠️ Aqui mora o bug — ver §4.**

4. **Tom carioca:** "perto de **você**" no lugar de "pertinho/perto de ti" (~7 pontos no prompt).

5. **Prova:** typecheck + 322 testes + `prova-geo-rede` 9/9 (inclui o **E2** novo = only_far carrega
   a rota; e corrigi o caso **C** que estava defasado das faixas `[5,10,15]` desde o commit c31e436).

**Deploy:** push `89bab5f..0c7a6dc → main`. ⚠️ **O deploy do Coolify foi MANUAL** nesta sessão
(o dono clicou Deploy) — o push sozinho NÃO subiu na hora (a 1ª conversa de teste ainda rodou no
código velho, "perto de ti"). Confirmar o estado do auto-deploy do Coolify.

---

## 2. Testes ao vivo de hoje (tudo limpo depois — ver §5)
- **PED-0033** (Engenho Novo → **Méier**, pickup, reservado): a retirada-pro-parceiro + reserva
  funciona em prod (on_hand intacto, reservado +1, sem recebível). MAS **não prova a régua**: Engenho
  Novo é mais perto do Méier, então Méier ganhar pode ser proximidade OU régua (ambíguo).
- **Sonia (no Méier) → Tijuca**, com o 90/90-18 do Méier APAGADO: ✅ **PROVA FORTE** de que o bot
  lê o estoque do parceiro ao vivo e respeita o `deleted_at` — mandou 6km pra Tijuca mesmo com a loja
  do Méier "na porta". (Esse era *o* teste do "ele consulta o banco mesmo?". Cravado.)
- **Consentimento (Bangu): NÃO testado ainda.**

---

## 3. Auditoria régua-vs-proximidade (Wallace pediu "auditar com fatos")
Três níveis:
1. **Winner + placar de leads (grátis):** a régua NUNCA escolhe quem tem MAIS lead. Logo: caiu na
   loja de MAIS lead = proximidade provada; caiu na de MENOS lead = ambíguo (pode ser régua ou ser
   a mais perto).
2. **Distância de RUA (o fato que falta):** diz a faixa de cada loja → mesma faixa = régua, faixas
   diferentes = proximidade. **É efêmera** (não é salva). Recuperável só (a) remedindo com a chave do
   Google (que vive **só no Coolify**, não no `.env` local) ou (b) pela linha de log do Coolify:
   `decideStoreForItemsGeo` loga `pool` — `pool≥2` = régua escolheu entre 2+ na faixa; `pool=1` =
   proximidade.
3. **Nível 3 (recomendado, NÃO feito):** persistir `ring_km` + `pool` + distâncias no próprio pedido
   → "régua vs proximidade" vira coluna, auditável pra sempre. Wallace ainda não pediu pra incluir.

**Teste-contradição (pra flagrar a régua ao vivo):** com leads desiguais, achar um ponto onde a
régua manda pra a loja MAIS LONGE (a de menos lead) contra a proximidade. Se mandar pra a longe =
régua provada. (Régua já está provada em test pela `prova-geo-rede` caso **I**: "troca após lead, não
fixa na mais colada".)

---

## 4. 🐞 BUG ABERTO — o pino sozinho não resolve a CIDADE
**Sintoma:** a saudação nova pede o pino; o cliente manda; o bot pergunta o bairro **de novo**.
Parece quebrado e irrita. (Não trava: se o cliente digitar o bairro, fecha normal e a distância do
pino É usada — é só uma falha pela metade.)

**Causa-raiz:** em `tools.ts buscar_produto` (e espelhado em `buscar_compatibilidade`,
`calcular_frete`, `localizacao_loja`, `criar_pedido`), a CIDADE (`municipio`) é derivada do **bairro
digitado** (`resolveMunicipioFromBairro`). O `resolveCustomerLocation` (que lê o pino) só é chamado
**se já existe `municipio`** (`env.ROUTING_GEO && municipio ? ... : null`). Com só o pino,
`municipio = null` → o pino nem é usado → `precisa_localizacao=true` → o bot pede o bairro.
`src/shared/geo/google-maps.ts` só tem texto→coordenada; **falta coordenada→cidade**.

**FIX DEFINIDO (não implementado):**
1. Add `reverseGeocode(point, apiKey)` em `google-maps.ts` (mesma API do Google, parâmetro `latlng`;
   parsear `address_components`: `administrative_area_level_2` = município, `sublocality`/
   `neighborhood` = bairro). Mesmo padrão tolerante a falha (timeout/null → fallback).
2. Helper unificado (ex.: `resolveClientGeo(client, env, conversationId, bairro, municipioArg)`)
   que devolve `{ location, municipio, neighborhood }`:
   - cidade do **bairro digitado** tem PRIORIDADE (código de hoje, intocado);
   - **só se `!municipio` E há pino** → reverse-geocode do pino preenche cidade + bairro;
   - coordenada: pino (exato) > geocode do bairro.
3. Ligar o helper nos 5 pontos (busca, compatibilidade, frete, localização, pedido) pro pino bastar
   do começo ao fim (senão a busca passa mas `localizacao_loja`/`criar_pedido` re-perguntam o bairro).
4. Conferir que o município do Google ("Rio de Janeiro") casa com a cobertura (`normalizeRegion` já
   tira acento/caixa → "rio de janeiro"). Test-first no `reverseGeocode` (fetch mockado).
5. **1 redeploy** (prompt+código vão juntos no build — não há fix sem redeploy).

**⚠️ GARANTIA (Wallace perguntou):** o fix é ADITIVO e **NÃO quebra a proximidade por bairro escrito**.
O bairro digitado sempre vence (a cidade continua vindo dele); o reverse-geocode só roda no caso
"só pino" (`!municipio`). Bairro+pino juntos: cobertura do bairro, distância do pino.

**Alternativa (se não quiser o fix agora):** reverter a saudação pra pedir o **bairro** primeiro
(pino vira opcional) — também precisa de redeploy. Recomendação: fazer o fix certo de uma vez.

---

## 5. Estado do prod AGORA (reset feito)
Rodado `scripts/reset-teste-total-prod.cjs COMMIT=1` (TRUNCATE, não dispara o trigger append-only):
- **0 conversas, 0 mensagens, 0 contatos, 0 pedidos, 0 reservas.** Leads zerados → régua neutra.
- Estoque baseline: Méier `10/0`, Tijuca `10/0` (90/90-18). Reservas liberadas (on_hand intacto).
- **PRESERVADO:** catálogo (70 produtos), 7 lojas prod, coords, cobertura, estoque, políticas.
- ⚠️ **FALTA o passo manual do dono:** apagar as conversas no **Chatwoot (UI)** senão o webhook
  recria no banco.

---

## 6. Pendências / próximos passos
1. **Implementar o fix do pino** (§4) + redeploy. (Maior prioridade — é uma regressão de UX viva.)
2. **Testar o consentimento (Bangu)** ao vivo (round-trip só exercita ao vivo). Obs: via pino vai
   esbarrar no bug do pino; via bairro digitado deve funcionar.
3. **Teste-contradição da régua** (§3) pra flagrar a justiça ao vivo com fato.
4. Quando o dono alinhar com os borracheiros: **preencher `installation_fee_brl` por loja**.
5. (Opcional) **Nível 3** — persistir a decisão (ring/pool/distâncias) no pedido pra auditoria eterna.
6. Entrega longe tem o MESMO buraco do "insiste mesmo assim" (hoje recusa) — fora de escopo, gêmeo
   do consentimento de retirada; fazer se o dono quiser.

---

## 7. Gotchas / mapa rápido
- **Deploy do Coolify é MANUAL** (o dono clica) — confirmar se o auto-deploy no push está ligado.
- **Migration ANTES do push** (o código lê a coluna nova; aplicar via `apply_migration`).
- **Chatwoot UI:** apagar conversas após reset (webhook recria).
- **Chave do Google só no Coolify** — reverse-geocode/road-distance não roda no `.env` local.
- **Motor:** entrega `[10,20,30,40]`km, retirada faixas `[5,10,15]`km (banda mais perto ganha; mesma
  faixa reveza pela régua de menos-lead-7d). `only_far` acima do teto.
- **Arquivos-chave:** `fulfillment.ts` (motor/decisão), `tools.ts` (tools do bot + handlers),
  `prompt.ts` (atendente), `shared/geo/{ring,haversine,google-maps}.ts`, `geo-routing.ts` (filtros).
- **Prova de integração:** `npx tsx --env-file=.env scripts/prova-geo-rede-test.ts` (env `test`,
  BEGIN/ROLLBACK; precisa do seed `geo-*`).

— Sessão 2026-06-09, orquestrador (Claude Opus 4.8) + dono (Wallace).
