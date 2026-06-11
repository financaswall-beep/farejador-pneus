# HANDOFF — Obra do painel ≤300: PASSO 10 (raiz fina / a ESPINHA) — 2026-06-11

> Sessão: continuação da fila travada no handoff dos passos 8+9
> (`docs/SESSAO_2026-06-12_OBRA_PAINEL_PASSOS_8_9_HANDOFF.md` — atenção: aquele
> arquivo foi nomeado 06-12, mas a cronologia real desta obra é 06-10 → 06-11).
> Plano oficial (LER ANTES de mexer): `docs/PLANO_REFATORACAO_PAINEL_300_2026-06-10.md`.
> Branch: `feat/refatoracao-painel-300` (NÃO mergeada — Onda C sobe inteira após validação).
> Autor: Orquestrador (Claude Fable 5) — domínio `parceiro`.

---

## 1. Estado em uma linha

**Passo 10 FEITO (`098b4f0`)**: a raiz foi fatiada em 5 módulos (auth/core/resumo/
pedidos/entregas) + `isCurrentMonth` foi pro format; raiz **1061 → 263** (ESTADO +
montagem). Login/logout/firstAccess/401/funcionário parcial provados **AO VIVO** na
zz-teste-meier (credencial que o dono passou: wallace/123456). **Bateria completa de
goldens 1–10 verde (508 asserções)** — e o passo achou/consertou buracos antigos na
rede (goldens 1/2/5/7/8 furados desde M2/M3/p9). **Falta SÓ o passo 11 (encerramento).**

## 2. Commits da sessão

| Commit | O quê |
|---|---|
| `7e81296` | docs — gatilho da porta única no plano §5/§6 + handoff 06-12 §8/§9 (sessão anterior, mesma conversa) |
| `098b4f0` | **Passo 10** — `app.auth.js` (123) + `app.core.js` (275) + `app.resumo.js` (118) + `app.pedidos.js` (178) + `app.entregas.js` (156); isCurrentMonth → format (168); raiz 263; teto json 263 |
| (este) | docs — passo 10 ✅ na tabela + este handoff |

## 3. O que existe agora (24 arquivos, TODOS ≤300)

`format` 168 (ganhou isCurrentMonth) · `labels` 180 · `charts.resumo` 19 · `charts.pdv` 158 ·
`foto` 228 · `chat` 255 · `chat.cliente` 246 · `config` 251 · `estoque.kpis` 258 ·
`estoque.forms` 255 · `pdv.kpis` 167 · `pdv` 294 · `pdv.clientes` 261 · `financeiro.kpis` 191 ·
`financeiro.score` 177 · `financeiro.compras` 188 · `financeiro.contas` 148 ·
`financeiro.receber` 190 · **`core` 275 · `auth` 123 · `resumo` 118 · `pedidos` 178 ·
`entregas` 156** · raiz `app.js` **263** (estado + montagem de 23 fábricas).
Paridade **465** · contratos **69** · etiqueta ainda `?v=20260611-onda-b` (M4 = passo 11).

## 4. Decisões de recorte (registradas na tabela §6 do plano)

- **5 arquivos, não 2**: o plano §6 só previa auth+core, mas pedidos/entregas/retiradas e
  as derivadas do Resumo NUNCA tiveram passo próprio no desenho — sobraram na raiz (1061
  reais vs ~530 que o desenho imaginava). Recorte por TELA: `pedidos` (aba Pedidos +
  setDeliveryStatus), `entregas` (tela Entrega/rota + tela Retiradas), `resumo` (derivadas).
- **`isCurrentMonth` → format**: família do `dateKeySaoPaulo` (comparação de data em São
  Paulo). Era a decisão pendente da M3 ("mover pro format = decisão do p10"). Continua ÚNICA.
- Raiz final = cabeçalho + `montarParceiroApp` + ESTADO (31–235 intactos byte a byte) +
  montagem com 23 fábricas (ordem documentada e fixa).

## 5. Provas que passaram

- Paridade **465/465** · contratos **69/69** · fiscal **24 arquivos ≤300** · color-moved
  **1599 movidas / 82 estruturais / 0 editadas** · `node --check` em 7 arquivos ·
  typecheck · vitest **379/379**.
- **Golden p10** (`obra-teste-passo10-raiz.cjs`, one-off untracked): **78/78** — byte a byte
  vs `29e9817` (cada bloco movido + raiz remontada com SÓ as 5 fábricas inseridas);
  login 401/429/500/sucesso (senha LIMPA da memória, token salvo); firstAccess
  (validações locais, Bearer do código CRU, username_taken, sucesso volta pro modo login);
  logout (POST sem Content-Type, para canal de foto, limpa tudo); api() (Error com
  status+payload); loadData (/me PRIMEIRO, role, permissions merge, redirect de seção
  proibida, feeds por canSee, financeiro condicional, produtos sempre); init (token
  salvo→authed; 401→limpa e volta pro login); goToSection (config só dono, canSee barra,
  tabs por seção, chat liga/desliga); RESUMO 0077 (completedSales: cancelada/delivery
  aberto FORA; salesTodayCount por delivered_at; série 7d só venda realizada); PEDIDOS
  (submitOrder barra carrinho vazio/sem endereço; payload receivable + 2w + idempotency
  `order-`; setDeliveryStatus manda payment_method SÓ no delivered; 0076 no addOrderItem);
  ENTREGAS/RETIRADAS (pickupAwaiting; cancelar 2W exige motivo; markRetrieved).
- **BATERIA COMPLETA 1–10: 10 goldens verdes, 508 asserções** (ver §6 — precisou consertar
  os antigos).

## 6. ACHADO IMPORTANTE: a rede de goldens tinha BURACOS (consertados)

Rodar a bateria completa revelou que **5 goldens antigos estavam quebrados ANTES do
passo 10** (provado com worktree no commit `7e81296`):

- **Goldens 1 e 2** (format/labels): loader HARDCODED (`['app.format.js','app.js']`) —
  quebraram quando a raiz passou a referenciar as outras fábricas (passo 3+). Nunca
  re-rodados. **Fix:** loader agora lê a ordem real do index.html (igual aos goldens 3–10).
- **Golden 5** (chat): asserção "chatSending segue SEM declarar (M2 só com aprovação)" —
  a M2 FOI aprovada e feita (`2aee88a`). **Fix:** asserção virou "M2 FEITA: declarado no
  ESTADO da raiz, não nos módulos".
- **Golden 7** (estoque): "helpers 0076 FICARAM na raiz" (saíram no p9 → financeiro.kpis)
  e "F1: DUAS cópias de isCurrentMonth" (M3 apagou uma). **Fix:** asserções apontam pros
  lares atuais.
- **Golden 8** (pdv): "salesTodayCount e rótulos de COMPRA ficaram na raiz" (rótulos
  saíram no p9 → financeiro.kpis; salesTodayCount saiu AGORA → resumo). **Fix:** idem.
- **Golden 9** (financeiro): ÚNICO quebrado DE FATO pelo passo 10 (2 asserções "raiz
  mantém X" — o próprio golden anotava "Resumo, passo 10"). **Fix:** apontam pros módulos.

**Lição de processo:** golden one-off com asserção de "onde mora" envelhece a cada passo
seguinte; a bateria COMPLETA precisa rodar em todo passo (vai pro checklist do passo 11).

## 7. Teste AO VIVO (zz-teste-meier, banco real, preview 4101)

1. **401 de verdade**: havia token VELHO inválido no navegador → na carga, /api/me 401 →
   init limpou o token e caiu na tela de login LIMPA (sem travar). Provado sem encenação.
2. **Login errado** → "Usuário ou senha incorretos." (servidor real respondeu 401).
3. **Login certo** (wallace/123456) → painel abriu, role owner, menu completo, dados da
   loja (estoque 2, vendas 2), **senha APAGADA da memória** após entrar.
4. **Giro nas 10 seções** (vendas/clientes/estoque/financeiro/pedidos/entregas/retiradas/
   batepapo/config/resumo) — config carregou "Borracharia Méier"; console **ZERO erro**.
5. **Logout pelo botão Sair** → token fora do localStorage, feeds zerados, login voltou.
6. **Funcionário parcial**: criado `teste-p10` pela função da tela + permissões SÓ
   vendas+estoque → logado → **caiu direto em "vendas"** (redirect de seção proibida),
   menu visual SÓ com Frente de caixa/Estoque, financeiro e config BARRADOS.
7. **firstAccess**: token cru gerado (`gerar-token-parceiro.cjs`) → modo "Primeiro
   acesso" → colou código + definiu `dono-p10`/senha → entrou (role owner), código limpo,
   modo voltou pra login, flash certo.
8. **Limpeza (zero resíduo)**: funcionário `teste-p10` revogado; token `dono-p10`
   revogado (450828a2); permissões da unidade restauradas pro padrão; todas as sessões
   de teste deslogadas. Auditoria SQL final: **1 token ativo** (login wallace original),
   **0 sessões de teste vivas**.

## 8. Aprendizados/avisos NOVOS desta sessão

- **`preview_click` sintético NÃO dispara o `@click` do Alpine** neste setup — o clique
  reporta sucesso mas o listener não roda. Caminho que funciona: `preview_eval` com
  `el.click()` (DOM real). (O preview_fill dispara o x-model normalmente, lição antiga vale.)
- **Lista de funcionários INCLUI revogados** (`listPartnerFuncionarios` traz `revoked_at`,
  revogados no fim) — re-revogar dá 404 `funcionario_not_found`; é o esperado, conferir o
  DADO no banco antes de achar que falhou (lição do flash sobrescrito, de novo).
- Botão "Ver todas as conversas" na tela do PDV não tem handler ativo (clique não navega;
  pré-existente, inofensivo — canSee seguraria de qualquer jeito). Não tratado (regra 7).
- O eval longo de giro (10 seções num loop) estoura o timeout do canal de teste — girar
  por chamadas curtas. A página em si não trava (zero erro).
- Datas dos handoffs: o arquivo dos passos 8+9 diz "2026-06-12" mas hoje é 2026-06-11 —
  cronologia real da obra: 06-10 (passos 0–2) → 06-11 (3 + merge A; B; 7; 8+9; 10).

## 9. Ambiente / pendências

- **Preview 4101**: de pé (serverId `98b2f92f…`). Sessão da copacabana INTACTA (localStorage
  por slug); na meier ficou DESLOGADO (zero resíduo). **Preview alheio 4100**: de pé (regra).
- **Credencial da obra**: wallace/123456 na **zz-teste-meier** (dono passou em 06-11;
  validada; loja REAL deu 401 com ela = segura). zz-teste-copacabana: senha com o dono.
- **One-off untracked que ficam**: goldens 1–10 (TODOS verdes agora) + `obra-preview-4101.cjs`.
  Extrator do recorte (`obra-recorte-passo10.cjs`) APAGADO (regra).
- **Modificação alheia não-commitada**: `docs/CONTRATO_ESTOQUE_FINANCEIRO_0076_0077.md`
  (migration 0078, outra frente) — fora de todos os commits desta obra.

## 10. Como retomar — SÓ FALTA O PASSO 11 (encerramento)

1. **Passo 11**: CLAUDE.md ganha a regra do teto 300 + fiscal no fluxo; **M4** trocar
   `?v=` dos 24 scripts (sugestão: `?v=20260611-onda-c`); **apagar
   `scripts/obra-painel-teto.json`** (passa a valer o teto universal de 300); faxina dos
   goldens one-off (decidir: apagar ou guardar como suíte — ver lição §6: a bateria pegou
   regressão real, vale considerar VERSIONAR); checklist §4 COMPLETO uma última vez
   (incluindo a bateria 1–10); **dono valida o dia a dia no celular**.
2. **Merge da Onda C no main** = SÓ com autorização do dono (regra §5; rollback = revert).
3. **🔔 GATILHO PÓS-MERGE — PORTA ÚNICA DE LOGIN** (tarefa #1 depois da obra; desenho na
   memória `project_porta_unica_login`; o `app.auth.js` de 123 linhas é a cama arrumada).
4. Depois: faxina docs/scripts; F5 (charts em `window._xxx`); raios reais de entrega.
