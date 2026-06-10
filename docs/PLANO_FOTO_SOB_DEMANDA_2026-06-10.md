# PLANO — Foto sob demanda de pneu usado (cards de foto no painel)

> **Data:** 2026-06-10 · **Status:** PLANO APROVADO PELO TIME, aguardando decisões do dono + ordem de construir.
> **Time que planejou:** Orquestrador (Claude Fable 5) + `banco`, `bot`, `parceiro`, `seguranca` (todos Opus 4.8).
> **Flag:** `PHOTO_REQUESTS` (default OFF). Tudo aditivo; rollback = flag off + DROP da migration.
> **NÃO encosta no contrato 0076/0077** (estoque/financeiro) — confirmado pelo `banco` contra `register_partner_local_order`.
> **📎 CÓDIGO PRONTO PRA COLAR (DDL final, sendAttachment, tool, E1–E20): [PLANO_FOTO_SOB_DEMANDA_2026-06-10_ANEXO_ARTEFATOS.md](PLANO_FOTO_SOB_DEMANDA_2026-06-10_ANEXO_ARTEFATOS.md)** — este doc é o mapa; o anexo é o material de obra revisado. Na hora de construir, usar o anexo (não regerar).

---

## 1. O que é (uma frase)

Cliente pede foto do pneu usado no WhatsApp → o bot cria um **pedido de foto** amarrado à conversa → vira um **card na aba Bate-papo do painel** (com alerta em qualquer tela) → o borracheiro toca no card, a câmera abre, tira a foto → o sistema manda a foto pro cliente **sozinho** (sem o borracheiro falar com cliente) → se ninguém responder em 10 min, o bot manda um fallback honesto. Quando o pedido fecha, a foto gruda no item e aparece no card **"Em separação"** (o separador pega o pneu CERTO).

**Princípio de correlação (o "5 clientes ao mesmo tempo"):** a foto NUNCA chega solta. Cada pedido de foto é um card com identidade (`photo_request_id`); o botão da câmera vive DENTRO do card; a foto sobe já grudada no id; o registro carrega o `conversation_id` do cliente (endereço de volta). O bot nunca adivinha o destino — ele lê.

---

## 2. ONDE ficam os cards (a pergunta do dono)

**Tela: aba Bate-papo, numa faixa fixa no TOPO** (acima dos KPIs do chat, `index.html:1643`). Some quando não há pedido (`x-show="photoRequests.length"`). NÃO é uma "conversa" na lista — card de foto é tarefa com prazo, não thread (e o item de conversa é construído em torno de nome/avatar do cliente, que o card NÃO pode mostrar — anti-bypass).

**Alerta global (o borracheiro pode estar em QUALQUER aba ou no caixa) — 4 camadas:**
1. **Badge** no menu Bate-papo (igual ao do chat) + badge no sino do topbar (hoje tem número fake hardcoded em `index.html:229-232` — trocar pelo real).
2. **Banner fixo** abaixo do topbar, visível em toda aba exceto Bate-papo: "📷 N pedido(s) de foto esperando — TOCA AQUI" → `goToSection('batepapo')`.
3. **Title flash** na aba do navegador: alterna `(N) 📷 FOTO` ↔ título normal (usa o `nowTick` que já existe, `app.js:28`).
4. **Som**: beep de 2 tons via `AudioContext` (sintetizado — sem asset novo), desbloqueado no clique do login + `pointerdown once` no documento (política de autoplay). Toggle on/off em `localStorage`. ⚠️ **iPhone com tela travada não toca som via web** — limitação do SO; banner+badge são o canal primário. Documentar pro dono.

**SSE global:** hoje o stream `/api/chat/stream` só conecta quando a aba Bate-papo abre (`app.js:2393`). Mudar: EventSource conecta no boot (após `/api/me`) e fica vivo o tempo todo; o `loadChat()` pesado continua só na aba. Poll de segurança da fila de fotos: 20-30s. O evento novo reusa o canal `pg_notify('partner_chat')` existente com `kind:'photo_request'` (payload SÓ `{unit_id, kind, photo_request_id}` — **sem conversation_id**, exigência E16).

### Mockup do card (mobile-first, mão suja, zero digitação)

```
┌─ PENDENTE ────────────────────────────────────┐
│  📷 PEDIDO DE FOTO                   ⏱ 9:32   │  countdown: verde >5min →
│      ┌───────────────────────────┐            │  laranja 2-5min → vermelho <2min
│      │     1 4 0 / 7 0 - 1 7     │            │  (sem amarelo puro — tema)
│      └───────────────────────────┘            │  ← MEDIDA GIGANTE
│  📍 Méier                                     │  ← só bairro. SEM nome/tel/cliente
│  ┌─────────────────────────────────────────┐  │
│  │        📷  T I R A R   F O T O          │  │  ← ≥56px, full-width, azul #1e40af
│  └─────────────────────────────────────────┘  │
└───────────────────────────────────────────────┘
PREVIEW: [miniatura] + [🔄 TIRAR OUTRA] [✅ ENVIAR]
ENVIANDO: spinner, botões travados · ENVIADA: ✅ verde, some em segundos
EXPIRADA: ⌛ cinza "o cliente já foi avisado" (pode anexar atrasado — vira "chegou!")
```

- Câmera: `<input type="file" accept="image/*" capture="environment">` (abre câmera traseira direto, Android+iOS).
- **Compressão client-side obrigatória**: canvas → JPEG q0.8, máx 1600px (4-12MB → ~150-400KB; 3G de loja).
- **EXIF orientation**: `createImageBitmap(file, {imageOrientation:'from-image'})` — senão pneu deitado (bug clássico).
- Tema claro E dark (o painel tem os dois; overrides em `.pos-shell[data-theme="light"]`).

### Card "Em separação" (fase 2 da feature)
Thumb 48-64px no header do card (`routeList`/`pickupAwaiting`, `app.js:1258+`), `object-fit:cover`, só quando o item tem foto. Clique → lightbox full-screen (padrão dos modais existentes). Endpoint: `GET /api/order-items/:id/photo` (resolve via `photo_requests.order_item_id`, RLS aplica).

---

## 3. Banco (migration 0094) — DDL do `banco`, com 1 arbitragem minha

**`commerce.photo_requests`** (schema `commerce` confirmado — dado transacional do silo do parceiro, padrão 0040/0070):

- Colunas: `id, environment, unit_id→core.units, conversation_id (endereço de volta), contact_id, tire_size, brand, note, status, was_late, photo_* (ver arbitragem), expires_at (default now()+10min), answered_at, sent_to_customer_at, order_item_id→partner_order_items, created_at, updated_at`.
- **Máquina de estados:** `pending → answered → sent`; `pending → expired → (foto atrasada) answered(was_late=true) → sent`; `answered → expired_after_answer` (cliente sumiu); `pending → cancelled` (pedido fechou sem foto / cliente desistiu). CHECK com os 6 estados.
- **Trava de duplo-clique:** function `commerce.attach_partner_photo` (SECURITY INVOKER, RLS aplica) com `SELECT ... FOR UPDATE` + só anexa se `pending/expired` E sem foto ainda; segundo upload = no-op idempotente.
- **RLS:** policy cópia da 0070 (`unit_id = network.current_partner_core_unit()`). Parceiro: **SELECT via VIEW** `commerce.partner_photo_queue` (security_invoker, **NÃO projeta conversation_id/contact_id** — exigência E2 do `seguranca`) + EXECUTE na function. **SEM INSERT/UPDATE direto** (INSERT só pelo bot-pool — E4: impede parceiro forjar pedido apontando pra conversa alheia).
- Triggers: `set_updated_at` + `validate_env_match('core','units','unit_id')` (invariante test/prod).
- Índices: fila parcial `(environment, unit_id, created_at DESC) WHERE status IN ('pending','answered')`; expirador parcial `(expires_at) WHERE status='pending'`; `(environment, conversation_id)` (limite anti-abuso); `(order_item_id) WHERE NOT NULL`.
- **Guard de migração da foto pro item** (bot-pool, pós-venda): UPDATE com `po.unit_id = pr.unit_id AND po.environment = pr.environment` — **re-roteou pra outra loja → foto NÃO migra** (é peça física de outra loja).
- Validação pós-migration (RLS ligado + policy count), padrão da casa. Rollback: DROP limpo.

**ARBITRAGEM DO ORQUESTRADOR — onde a foto mora: Postgres `BYTEA`, não Supabase Storage (no MVP).**
O time divergiu (`banco` 1ª rodada: bucket privado `partner-photos`; `parceiro`: bytea/infra própria; `bot`: "dá até pra não guardar"). Decisão: **BYTEA no Postgres**, não Storage. Razões: (1) primeira integração com Storage = service key nova no Coolify + policies de `storage.objects` + signed URLs = 3 superfícies novas de risco/config pra uma foto de ~300KB já comprimida no cliente; (2) bytea fica AUTOMATICAMENTE atrás do RLS + auth do painel (mata as exigências E13/E14/E15 por construção); (3) volume baixo (≈50 fotos/dia × 300KB ≈ 15MB/dia; com purga de 30 dias ≈ 450MB estável); (4) o cliente recebe a foto via CHATWOOT (buffer multipart — o Chatwoot hospeda a cópia dele), nossa cópia é só pro painel. **Guardar precisa** (não descartar como o `bot` cogitou): o card de separação é requisito do dono.
**REFINAMENTO (o `banco` me contestou e melhorou — 2026-06-10):** os bytes NÃO ficam inline na `photo_requests` — vão em **tabela SEPARADA `commerce.photo_request_blobs`** (1:1, PK=FK, ON DELETE CASCADE, RLS própria). Motivo: `photo_requests` é fila/máquina-de-estados lida o tempo todo (expirador varre `WHERE status='pending'`, view lista, bot-pool escreve); blob inline faz pg_dump/backup arrastar a foto e um `SELECT *`/`RETURNING *` distraído puxa 300KB por tick — separar torna o erro impossível por construção, não por disciplina. Custo: uma FK 1:1 + um JOIN só no endpoint de imagem (1 linha, raro). DDL final = §A do anexo.
Consequência: `partner_order_items` **NÃO ganha coluna** — o card de separação acha a foto via `photo_requests.order_item_id` (menos mexida ainda no snapshot imutável da venda). Migrar pro Storage quando volume/retenção longa justificar — `photo_request_blobs` vira `photo_storage_path`.

---

## 4. Bot (atendente-v2) — desenho do `bot`

**Tool nova `pedir_foto`** (tools.ts), args opcionais `product_id/bairro/municipio` (LLM esquece — a tool resolve via `getRecentProductIds` + pino, padrão `localizacao_loja`):
- Re-roda `decideStoreForItemsGeo` (a loja NÃO é persistida antes do pedido — ver FURO #1 abaixo) → grava `unit_id` no registro.
- **Guards por CÓDIGO** (E18): sem produto → `precisa_produto`; sem loja/matriz/only_far → `sem_loja` (bot pede bairro/pino — converte o atrito em gancho); **máx 2 ativos por conversa** (`pending`+`answered`); **dedup** mesmo produto+loja pending → devolve o existente (LLM chamou 2× ≠ 2 cards).
- Retorno feliz: `{status:'foto_solicitada', prazo_min:10, nome_pneu}` → LLM avisa "vou pedir pra loja, 1 minutinho 📸" e SEGUE a conversa.
- Após INSERT: `pg_notify('partner_chat', {unit_id, kind:'photo_request', photo_request_id})`.
- **Sem nudge novo** em agent.ts (o pedido vem em TEXTO do cliente — o LLM vê; diferente do pino). Prompt: bloco curto REATIVO (só quando o cliente pedir foto; NUNCA oferecer proativamente — senão cria promessa em escala que depende do borracheiro).

**Envio da foto (assíncrono — dispatcher determinístico, ZERO LLM):**
- Endpoint de upload, após gravar, chama `dispatchPhotoToCustomer(id, buffer)` → lê o registro → `conversation_id` → `ChatwootApiClient.sendAttachment(convId, buffer, legenda)`.
- **Método novo `sendAttachment`** no client: multipart `attachments[]` (colchetes — Rails), `content` = legenda, `message_type=outgoing`, SEM setar Content-Type manual (FormData/boundary do Node 18+; ⚠️ checar versão Node no Coolify). NÃO reusa `requestPost` (esse força JSON) — caminho próprio com o mesmo retry.
- **Legenda OBRIGATÓRIA** ("Ó ele aqui 📸 — [medida], confere o estado") — sem ela o eco entra com content vazio e o `history.ts` DESCARTA (filtro `content <> ''`) → o LLM não saberia que mandou e prometeria de novo. ⚠️ Legenda diz "esse é o tipo/estado do que temos" — NÃO "esse exato é seu" (estoque não é serializado; não prometer identidade que não se garante).
- **Sem insert otimista** — o eco do webhook é a única fonte (zero dedup).
- **Loop é impossível por construção:** `dispatcher.ts:216` só enfileira job se `sender_type === 'contact'`; foto outgoing nunca acorda o LLM (+ `reconcile-jobs.ts:48` idem).

**Expirador:** `setInterval` 60s no boot do worker (atrás da flag): `UPDATE ... SET status='expired' WHERE status='pending' AND expires_at<now() RETURNING` → fallback pro cliente por cada linha. Atômico (UPDATE...RETURNING) = multi-réplica e restart do Coolify seguros (o WHERE pega os vencidos da janela morta no boot). Foto atrasada: UPDATE atômico `CASE WHEN status='expired' THEN ...` → manda "chegou! 📸".

---

## 5. Backend do painel — desenho do `parceiro` + exigências do `seguranca`

```
GET  /parceiro/:slug/api/photo-requests      [requirePartnerAuth + requireScreen('batepapo')]
     → view partner_photo_queue (últimas ~2h). Payload WHITELIST (E16):
       { id, tire_size, bairro, status, expires_at, created_at } — NADA de conversa/contato.

POST /parceiro/:slug/api/photo-requests/:id/photo    (multipart)
     [requirePartnerAuth + requireScreen('batepapo')]
     - @fastify/multipart (DEP NOVA) limits { fileSize: 8MB, files: 1 }, aborta stream acima (E9)
     - magic bytes: SÓ JPEG/PNG/WebP; SVG REJEITADO explicitamente (E7 — stored XSS)
     - RE-ENCODE server-side com sharp (DEP NOVA): decode → resize máx 1600px → JPEG
       (mata polyglot + strippa EXIF de graça — E8/E12; fallback jimp se o build nativo brigar)
     - client_token (idempotência, padrão do chat) + rate limit por token/unit (helper existe) (E10)
     - valida :id pertence ao unit_id da sessão (E11) e chama attach_partner_photo (estado/trava)
     - sucesso → dispatchPhotoToCustomer(id, buffer)   ← buffer já em mãos, sem re-baixar

GET  /parceiro/:slug/api/photo-requests/:id/image    [auth idem]
     → SELECT photo_bytes/mime (RLS isola por unidade) → serve com cache curto.
GET  /parceiro/:slug/api/order-items/:id/photo       (fase 2, card separação → lightbox)
```

**Permissão:** funcionário responde foto SIM — colado na tela `batepapo` no MVP (é o borracheiro de mão suja quem fotografa). ⚠️ Furo documentado: funcionário SEM batepapo fica cego pros cards (decisão futura: 9ª permissão própria).

---

## 6. FUROS PREVISTOS (consolidado do time) + mitigação

| # | Furo | Mitigação | Dono do furo |
|---|------|-----------|--------------|
| 1 | **Loja da foto ≠ loja do pedido** (régua não-determinística entre a foto e o fechamento; a decisão de loja não é persistida pré-pedido) | Guard do banco: foto NÃO migra se unit divergiu. **Decisão do dono pendente: "sticky" — a loja que mandou a foto leva o pedido?** (recomendo SIM: o cliente aprovou peça física DAQUELA loja; senão a foto vira mentira de novo) | bot/negócio |
| 2 | Parceiro forja pedido de foto pra conversa alheia (SEC-001 ao contrário, na SAÍDA) | INSERT só bot-pool; upload referencia SÓ `photo_request_id`; destino lido do banco (E4/E5) | seguranca |
| 3 | Contato do cliente vaza pro parceiro (anti-bypass de comissão) | View sem conversation_id/contact_id (E2) + payload whitelist (E16) + SSE sem conversation_id | seguranca |
| 4 | SVG/polyglot upload = stored XSS no painel | magic bytes + allowlist + re-encode sharp (E7/E8) | seguranca |
| 5 | Duplo upload (2 aparelhos, mesmo card) | FOR UPDATE + estado na function (no-op idempotente) + SSE esconde card respondido | banco |
| 6 | Foto chega após fallback (race) | UPDATE atômico CASE → `was_late` → manda "chegou! 📸" contextual | bot |
| 7 | Legenda vazia = LLM esquece que mandou foto | legenda obrigatória no dispatcher (filtro do history.ts) | bot |
| 8 | Borracheiro com painel FECHADO não vê o card | banner+badge+title+som cobrem painel aberto; painel fechado = frente #1 (push/zap) — esta feature CONSTRÓI a fundação (SSE global+alerta) mas não fecha o caso | parceiro |
| 9 | Prompt injection "peça 50 fotos" = flood de cards | máx 2 ativos + dedup + cooldown NO CÓDIGO da tool (E18) | bot |
| 10 | test/prod cruzados | `environment` em tudo + env_match trigger + guard na migração da foto (E3/E14) | banco |
| 11 | Foto rotacionada (EXIF orientation) | createImageBitmap from-image no canvas client | parceiro |
| 12 | 3G da loja trava upload | compressão client-side (1600px/q0.8) ANTES do POST | parceiro |
| 13 | iPhone tela travada sem som | limitação do SO — alertas visuais primários; avisar o dono | parceiro |
| 14 | Banco incha com bytes | purga: apagar `photo_bytes` de expired/cancelled >30d; ligados a pedido >90d (decisão leve do dono) + LGPD: erasure do contato apaga a foto (backlog seguranca) | banco |
| 15 | "Equivalente ou melhor" no fallback = compromisso comercial automático | **Decisão do dono: suavizar o texto** (recomendo: "a loja não conseguiu mandar agora — tu vê o pneu e aprova antes de pagar") | negócio |
| 16 | 2 clientes pedem foto do MESMO pneu (estoque por medida, não serializado) | aceito no MVP (estoque trava na reserva; fallback cobre); legenda nunca promete unicidade; serialização = projeto futuro | produto |

---

## 7. Decisões do DONO (negócio — em linguagem de leigo)

1. **A loja que tirou a foto leva o pedido?** O cliente viu o pneu da loja A; se a régua mandar o pedido pra loja B, ele recebe outro pneu. Recomendo: **sim, quem mostrou leva** (se ainda tem estoque e atende o modo). Mexe na régua de justiça — por isso é tua.
2. **Texto quando a loja não responde a tempo:** prometer "equivalente ou melhor" (forte, mas é compromisso) ou só "tu vê e aprova antes de pagar" (recomendo)?
3. **Foto guardada por quanto tempo?** Proposta: 30 dias (não virou venda) / 90 dias (virou venda). 
4. **Quem pode responder foto:** qualquer um com a tela Bate-papo liberada (recomendo) — ou só o dono?

## 8. Ordem de construção (5 tijolos, cada um com prova)

| Tijolo | O quê | Prova | Deps novas |
|--------|-------|-------|------------|
| 1 ✅ **FEITO 2026-06-10** | Migration **0094** APLICADA EM PROD (dormente; 3 furos do rascunho consertados — ver anexo §A) | dry-run→commit + smoke 16/16 (RLS 2 sentidos, E2/E4 físicas, was_late, guard) + typecheck + 345/345 | — |
| 2 ✅ **FEITO 2026-06-10** | Backend painel: GET fila, POST foto (re-encode sharp), GET imagem — flag off. **DESVIO bom: upload = RAW IMAGE BODY (fetch+blob), NÃO multipart** → -1 dependência (@fastify/multipart cortada), bodyLimit nativo 8MB (E9), idempotência é do banco (FOR UPDATE; sem client_token). Flag PHOTO_REQUESTS no env (default false). | typecheck + 10 testes novos (sniff magic bytes, SVG/GIF/polyglot rejeitados, EXIF aplicado+strippado, resize 1600) + 355/355 total | sharp (só) |
| 3 ✅ **FEITO 2026-06-10** (código; ⚠️ smoke ao vivo PENDENTE) | Bot completo: tool `pedir_foto` (re-roda decideStoreForItemsGeo pickup, aceita partner E only_far; guards dedup+máx2 por código), `sendAttachment` multipart no sender do v2 (FormData recriado por tentativa), `dispatchPhotoToCustomer` (lê endereço de volta do registro — E5; legenda obrigatória, "do que temos" nunca unicidade) + fallback suave, expirador setInterval 60s flag-gated no server.ts, `PHOTO_PROMPT_BLOCK` condicional (padrão GEO_PROMPT_BLOCK) + `activeToolDefinitions()` (flag off = tool invisível ao LLM, prompt byte a byte igual = preserva caching). Dispatch ligado no POST do upload (fire-and-forget logado). | typecheck + 355/355 + **prova-foto-tijolo3.ts 6/6** (dedup, limite por conversa, pg_notify transacional, BEGIN/ROLLBACK env test). **GATE pra ligar a flag: rodar `scripts/smoke-send-attachment.ts <conv_id_de_teste>` (manda imagem REAL — esperando o dono indicar a conversa)** | — |
| 4 ✅ **FEITO 2026-06-10** | UI completa: cards no TOPO do Bate-papo (grid do .pos-chat ganhou linha 1 que colapsa a 0 quando vazia — layout do chat intacto), estados pendente/preview/enviando/enviada/expirada (expirado ainda aceita "TIRAR MESMO ASSIM" → was_late), countdown 1s verde→laranja→vermelho, câmera capture=environment + compressão canvas 1600px/q0.8 + EXIF via createImageBitmap, upload raw blob, banner GLOBAL pulsante (toda aba exceto Bate-papo), badge 📷 no menu + sino do topbar REAL (era número fake), title flash, beep 2 tons AudioContext (destrava no login/1º toque; toggle em localStorage), SSE GLOBAL desde o login (kind photo_request) + poll 25s. **BUG PRÉ-EXISTENTE ACHADO E CORRIGIDO: o SSE do chat NUNCA conectou (`this.token` não existia — era `apiToken`); o "tempo real" do chat sempre foi o poll de 5s.** | node --check + typecheck + 355/355 + **validação visual no preview (porta 4100): desktop dark, claro, mobile 375px — banner/cards/badges/countdown confirmados em screenshot**. Fluxo de upload completo + beep = teste ao vivo (gate da flag) | — |
| 5 ✅ **FEITO 2026-06-10** | Amarração completa: `linkPhotoRequestsToOrder` no criar_pedido (flag-gated) — foto answered/sent gruda no item via casamento por product_name do CATÁLOGO (stock→products join; mesmo campo que gerou o tire_size), guard `po.unit_id = pr.unit_id` (re-roteou → NÃO migra), **pending da conversa → cancelled ao fechar** (sem "loja não conseguiu" pós-compra); feed getPartnerVendas ganha `photo_request_id` por pedido (1 query, RLS isola); thumb 56px "📸 pneu da foto — conferir" nos cards de ENTREGA e RETIRADA (fetch+blob autenticado — img não manda Bearer) + lightbox fullscreen. **Sticky-loja NÃO implementado (decisão #1 do dono pendente).** | **prova-foto-tijolo5.ts 4/4** (pedido REAL via register_partner_local_order em BEGIN/ROLLBACK: gruda no item certo, outra loja não migra, pending cancelado, mapa do feed resolve) + node --check + typecheck + 355/355 | — |

**STATUS GERAL: os 5 tijolos CONSTRUÍDOS e PROVADOS em 2026-06-10 (dormentes — flag `PHOTO_REQUESTS` default off).**
Ligar a flag SÓ depois de: (1) **smoke do envio real**: `npx tsx --env-file=.env scripts/smoke-send-attachment.ts <chatwoot_conversation_id de TESTE>` (manda imagem REAL no WhatsApp — o dono indica a conversa); (2) passada do `seguranca` no código real (o parecer E1–E20 foi sobre o DESENHO); (3) decisões do dono §7 (sticky-loja, texto do fallback, retenção, permissão).

## 9. Fora do escopo (V2+)
Push com painel fechado / ping no zap da loja (frente #1 completa); permissão própria "foto" (9ª tela); estoque serializado (cada pneu = 1 registro com foto permanente); reuso de foto entre clientes; foto proativa (atrás de flag, medir); Supabase Storage (quando volume justificar).

## 10. Relação com a pauta (memória `project_roadmap_bot_entrega_proximo_encontro`)
Esta feature é a frente **#5**; os tijolos 4 (alerta global) constroem a fundação da frente **#1** (notificação); o furo #1 (sticky) conversa com a frente **#4** (régua); cards expirados viram sinal anti-preguiça pra régua (telemetria de graça).
