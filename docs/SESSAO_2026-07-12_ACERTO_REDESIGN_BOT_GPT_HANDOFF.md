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

---

## Parte 2 (mesma sessão) — ABA COLABORADORES redesenhada (desenho do dono com GPT, implementada pela casa)

O dono mandou o GPT desenhar uma tela nova de Colaboradores (mockup em imagem) e escolheu
implementá-la ("vamos nessa aqui, só mantenha o menu lateral existente"). **Obra 100%
front-only** — todo o backend (criar/função/acesso/senha/revogar/reativar) já existia
(0124+0132); a tela nova é vitrine nova pros mesmos endpoints. Menu lateral INTOCADO.

**O que a aba ganhou** ([index.html](../painel/public/index.html) seção colaboradores +
[app.colaboradores.js](../painel/public/app.colaboradores.js) 131→183):
- Header com botão **"＋ Novo colaborador"** que abre **drawer lateral direito** (como no
  desenho; backdrop clicável fecha) — o form saiu do miolo da página.
- Banner verde: entregador usa /entregas sem financeiro; frente de caixa do vendedor futura.
- **3 cards de contagem** (Ativos/Vendedores/Entregadores) + pill "N revogados" — getters
  derivados da lista, zero estado duplicado.
- **Tabela de verdade** (thead Colaborador/Função/Acesso/Status/Ações) com **avatar de
  iniciais** (cor determinística por nome), @username, badges Ativo/Revogado.
- **Busca** por nome/usuário + **filtros Ativos|Revogados** (revogado ganha ↻ Reativar).
- **Cadeado do último proprietário**: o select de acesso do ÚNICO owner ativo fica
  `disabled` + 🔒 com title "última chave da loja…" — espelho VISUAL da trava
  `last_owner_required` do 0132 (o servidor continua sendo o freio de verdade).
- Form: função nasce VAZIA ("Selecione a função" + validação); acesso nasce **"Sem acesso
  ao painel"** de propósito (menor privilégio por padrão — divergência consciente do
  mockup, que pedia "Selecione o acesso"); senha com olhinho (eye/eye-off).

**⚠️ Lição nova de preview — x-transition trava em aba de fundo:** o drawer com
`x-transition` (tanto classes Tailwind quanto o inline `.opacity`) ficou PRESO fechado no
Browser pane: a transição do Alpine depende de `requestAnimationFrame`, que **congela em
aba de fundo/headless** (mesma causa dos screenshots dando timeout na máquina). Em aba
visível funcionaria — mas não dá pra PROVAR no pane, então o drawer ficou **sem transição
de propósito** (x-show puro, comentado no HTML). Vale pra qualquer modal/drawer futuro
do painel: transição só se puder provar.

**Provas:** preview 4230 pelo clique real — login humano → cadastrou "João Preview"
entregador pelo drawer (msg verde, drawer fechou, contadores 3→4 ao vivo) → revogou
(confirm, ativos 4→3) → filtro Revogados mostrou ele → reativou ("mesma senha de antes")
→ busca "joao" filtrou → cadeado do owner único provado disabled+🔒 → console zero erros
→ João deixado REVOGADO (env test limpo). Fiscal [OK] (183/282), **paridade 398 regravada
DE PROPÓSITO** (12 props novas: colabBusca/colabView/colabSenhaVisivel + 9 getters/helpers),
565/565 unit. `?v=20260712-colab1` em app.colaboradores.js e app.js. SEM migration/flag.

— Orquestrador (Claude Fable 5) — domínios `matriz`/`bot`/`parceiro`

---

## Parte 3 (mesma sessão, modelo Opus 4.8) — ABA FINANCEIRO em 5 sub-abas (desenho do dono com GPT)

O dono escolheu implementar a tela do GPT pro **Financeiro** — a aba mais sensível (dinheiro),
que JÁ existia e JÁ tinha sido auditada (07-08b, ⭐⭐⭐⭐). Ele pediu "fale antes de montar" e
perguntou se 4.8 dava conta ou se passava pro Fable 5. Parecer dado: **obra FRONT sobre um
backend que eu mesmo construí/auditei** — o `getMatrizFinanceiroVisao` já entrega ~85% dos
números. Risco não é raciocínio, é disciplina de não inventar número (lição do card 48h). 4.8
com o contexto do financeiro é a escolha certa; Fable só se fosse reescrever o CÁLCULO do lucro.

**Cruzamento imagem × servidor (feito ANTES de montar):** já vinham prontos — Resultado do
mês, Entrou, Saiu, Custos, Despesas, Lucro, Margem, Capital parado, Ponto de equilíbrio, as 4
pernas (valor), lucro de atacado/varejo, a_receber/a_pagar. **4 pontos que não batiam** e como
resolvi (SEM inventar no front):
1. **Giro "2,58x"** — servidor só dava `giro_dias`; adicionei `indicadores.giro_vezes` =
   custo30d/capital (MESMA base do giro_dias, inverso × 30). ÚNICO toque no servidor.
2. **Lucro do Frete** — não existe isolado; o frete entra CHEIO no lucro (a gasolina já desconta
   na perna Despesas). Front mostra `recebido` como lucro bruto — e a conta FECHA (Σ lucro bruto
   das 4 pernas − despesas = lucro líquido, exatamente o que o servidor já calcula).
3. **Lucro da Comissão** — é lucro puro (valor = lucro bruto). Idem frete.
4. **"12 pneus capital parado alto"** — não inventei o "alto": a Atenção rápida usa
   `pneus_galpao` + `capital_parado` (já existem), texto "N pneus, R$ X parado → Ver estoque".

**Seletor de período (Hoje/7d/30d da imagem) NÃO entrou** de propósito: o financeiro é
competência MENSAL (decisão de arquitetura já auditada); multi-período mexe na régua do dinheiro
e é obra de servidor própria (avisado ao dono). Em vez do seletor, selo "competência do mês
corrente" no header. Menu lateral do mock (rebrand "Matriz Farejador/Admin Farejador") IGNORADO
— mantido o menu da casa, como nas outras telas.

**A tela** ([index.html](../painel/public/index.html) seção financeiro ·
[app.financeiro.js](../painel/public/app.financeiro.js) 172→220 ·
[queries-financeiro-visao.ts](../src/admin/painel/queries-financeiro-visao.ts)): 5 sub-abas
(Visão geral | Cobranças | Contas a pagar | Despesas | Indicadores, mesmo padrão do Bot).
Visão geral = 4 cards topo (Resultado/Entrou/Saiu/Atenção hoje) + Resultado do período com barra
segmentada custo/despesa/lucro (fecha 100%) + Atenção rápida (3 atalhos pras sub-abas/estoque) +
De onde veio o dinheiro (4 fontes com valor + lucro bruto %) + 4 indicadores (Margem/Capital/
Giro x/Ponto). Cobranças←quem te deve · Contas a pagar←agenda · Despesas←bloco 0130 inteiro
VERBATIM · Indicadores←4 cards + margem. Toda ação preservada (Recebi/Paguei/Cobrar/despesas).

**Provas:** typecheck · fiscal [OK] (financeiro-visao 271 linhas, app.financeiro 220) ·
**prova-financeiro-visao 30/30 ×2** (V6a novo: giro_vezes acompanha giro_dias) · 565 unit ·
**paridade 404 regravada DE PROPÓSITO** (6 props: finTab + finLucroPerna/finPctLucro/finResSeg/
finResPct/finCobrancasAbertas) · preview 4230 pelo clique (5 sub-abas trocam 1-a-1, barra
47,5%custo+52,5%lucro=100%, lucro varejo 94,90+frete 10 batendo o dado, giro "—" honesto com
galpão de teste vazio, console zero erros). `?v=20260712-fin1`. SEM migration, SEM flag nova.

⚠️ Pendências pro dono (avisadas): (a) o **seletor de período** no financeiro é obra separada
(régua de competência = dinheiro); (b) validar ao vivo com dado real de prod (o giro em x, as
pernas com lucro); (c) as outras sub-abas hoje têm o conteúdo ATUAL — refinar quando o dono
mandar o desenho de cada uma.

— Orquestrador (Claude Opus 4.8) — domínio `matriz`
