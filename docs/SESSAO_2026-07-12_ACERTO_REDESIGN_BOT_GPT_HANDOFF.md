# Sessão 2026-07-12 — Acerto do redesign da tela do Bot (feito com GPT) + fiscais de volta ao verde

> **Contexto:** o dono repaginou a tela do Bot do painel da matriz com outra LLM (GPT) —
> 4 commits direto no main, já pushados (`ae81a2d` navegação · `8fe19d8` conversas ·
> `97db7e3` vendas · `667e023` demanda). O redesign é BOM (abas, fila unificada, mapa
> maior, "sem região" visível) e seguiu o padrão da casa (getters derivados no módulo-
> fábrica, arquivos no teto). MAS saiu sem prova nenhuma e com furos. Esta sessão
> auditou, consertou e devolveu os fiscais ao verde. Pedido do dono: "vc consegue
> concertar tudo isso?".

## O que estava furado (achado da auditoria)

1. 🔴 **Card "Resumo das últimas 48h" mentia** (aba Conversas): "Respondidos pelo bot"
   e "Tempo médio de espera" esperavam campos que o servidor NÃO mandava
   (`respondidas_bot_48h`, `espera_media_seg`) — o fallback do front rodava SEMPRE e
   mostrava conversas−escalados−abandonos **do período selecionado** (até 30d!) com
   rótulo "48h", e a espera da fila atual como se fosse do resumo.
2. 🔴 **Paridade da matriz quebrada** — 8 props novas do redesign sem regravar o
   baseline (378 → 386).
3. 🔴 **Fiscal de tamanho reprovando o main** — NÃO por culpa do redesign:
   `src/parceiro/route.ts` 1699 > teto congelado 1678 (engordou no harden de 07-10,
   `6e7fe4d`) e `queries-colaboradores.ts` 324 > 300 (engordou na 0132, `affbbb7`).
4. 🔴 **Baseline de ROTAS da matriz desatualizado** — a sessão da 0132 regravou a
   paridade mas esqueceu as rotas (`/admin/login.css`, `/admin/login.js`,
   `POST /admin/api/colaboradores/acesso` fora do baseline).
5. 🟠 **`?v=` não bumpado** em `app.bot.js` e `app.js` (mudaram no redesign e ficaram
   com etiqueta velha → pós-deploy, cache velho = abas que não respondem).
6. 🟠 Teste `tests/unit/admin/collaborators-access.test.ts` da 0132 estava **fora do
   git** (untracked — o commit esqueceu o `git add`).

## O que foi feito

### 1. Card 48h honesto (servidor → front → prova)
- `getBotVisao` ([queries-bot-visao.ts](../src/admin/painel/queries-bot-visao.ts)):
  cards ganharam **`respondidas_bot_48h`** com régua FIXA de 48h (conversas distintas
  com `agent.turns` `status='delivered'`, `agent_version='v2'` — a MESMA régua
  delivered da campainha/stale-trigger), independente do seletor de período.
- `app.bot.js`: `botRespondidas48h` lê SÓ do servidor (servidor calado = '—', nunca
  conta inventada); `botEsperaMediaSeg` assumido como o que É — média da fila de
  agora — e o rótulo na tela virou **"Espera média da fila agora"**.
- Prova estendida: **B20** (turn delivered → +1 por DELTA) → `prova-bot-tela-test.ts`
  agora é **20/20** (rodada ×2, determinística).
- Prova visual no preview 4230: período 30d mostra 1 conversa e o card 48h mostra **0**
  (a conversa é antiga) — a conta velha mostraria 1; o número agora é honesto.

### 2. Cache-bust
- `app.bot.js` e `app.js` → `?v=20260712-botui1` no index.html do painel.

### 3. Fiscal de tamanho de volta ao VERDE (repo inteiro)
- **`queries-colaboradores.ts` 324 → 113 + 222**: corte por ASSUNTO — cadastro fica
  (list/criar/função); ciclo de ACESSO da 0132 (papel do painel, revogar/reativar,
  senha — tudo que mexe em sessão/permissão) foi pra
  **`queries-colaboradores-acesso.ts`**. Barrel `queries.ts` re-exporta os dois;
  nenhum importador muda. De quebra saíram 8 imports MORTOS (sobra do corte verbatim
  da obra 300: wholesale/galpão/phone/randomBytes).
- **`src/parceiro/route.ts` 1699 → 1654** (teto congelado 1678): o assunto "login por
  usuário+senha" (handler + throttle em camadas por usuário/IP do harden 07-10 +
  constantes) foi pra **`src/parceiro/route-login.ts`** (70 linhas). Os schemas
  (`paramsSchema`/`loginSchema`) CONTINUAM no route.ts (fonte única dos campos) e
  entram por INJEÇÃO — zero duplicação, zero ciclo de import. Endpoint idêntico
  byte a byte; `LOGIN_MAX_ATTEMPTS`/`LOGIN_WINDOW_MS` exportados de lá porque o
  set-credentials reusa a régua.
- Teste da 0132 adicionado ao git (import atualizado pra fatia nova).

### 4. Baselines regravados DE PROPÓSITO
- **Paridade 386 props** (8 do redesign: botTab, botConversaBusca, botConversaFiltro,
  atualizarBotFila, botConversasFila, botConversasFiltradas, botRespondidas48h,
  botEsperaMediaSeg).
- **Rotas 103** (3 da 0132 que tinham ficado de fora).

### 5. Preview da matriz pós-0132
- `src/app/preview-matriz-server.ts` (local, untracked) ganhou o
  `registerAdminLoginRoute` — sem ele o preview não tem como logar (o front não usa
  mais bearer). **Env test ganhou um owner descartável `preview.dono`** via bootstrap
  (só test; prod intocada).

## Provas (todas verdes)
- typecheck ✓ · **565/565 unit** ✓ · `checar-tamanho` **[OK]** ✓
- `prova-bot-tela-test.ts` **20/20 ×2** ✓ (pooler test)
- `prova-matriz-colaboradores-test.ts` ✓ (não-regressão da fatiagem: revogar/
  reativar/senha provados contra o banco)
- paridade **386 idêntica** ✓ · rotas **103 idênticas** ✓
- Preview 4230 pelo clique: login humano 0132 → aba Bot → 4 sub-abas → card 48h
  honesto → mapa 24 municípios montado → zero erro de console.

## O que FICA (pro dono / próxima sessão)
- **Apertar Deploy** (main pushado) e conferir DE FORA: `?v=20260712-botui1` no ar.
- Validar ao vivo: abas da tela do Bot + card 48h com movimento real.
- Lixo local untracked da sessão GPT: `painel/public/bot-demanda-mock*.html` (8 arquivos),
  `dashboard.html` na RAIZ, `proposta-layout-2026-06/`, `assets/` — não vão pro deploy,
  mas sujam o repo; faxina quando o dono quiser.
- Recado dado ao dono: trabalho de outra LLM direto no main sem prova = os fiscais
  seguram, mas só se alguém RODAR. Combinado de sempre: prova antes do push.

— Orquestrador (Claude Fable 5) — domínios `matriz`/`bot`/`parceiro`
