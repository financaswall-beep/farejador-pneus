# Sessão 2026-07-05c — OBRA 300: portaria da matriz fatiada (route.ts 1.399 → 38)

> 3ª obra do dia (após fiscal+painel e queries). Dono deu o "VAI" pro route.ts
> da matriz furar a fila (folga de só 14 linhas até o teto congelado — a frente
> de caixa do vendedor e a Fase B iam esbarrar nele).

## O que subiu: `90a46e9` (aguarda Deploy do dono; backend puro, zero migration)

- `src/admin/painel/route.ts` = **porta de entrada (38 linhas)**: registra 13
  módulos `route-*.ts` NA ORDEM original. Rota nova entra no módulo do assunto.
- 13 módulos de rotas (static, dashboard, atacado, galpao, fornecedores, fiado,
  financeiro, logistica, logistica-rotas, parceiros, candidaturas, pedidos,
  colaboradores) — corpos VERBATIM (provados byte a byte no gerador) — +
  mezanino `route-schemas.ts` (linhas 76-325 + `export ` mecânico c/ prova
  reversa) e `route-helpers.ts` (326-375 idem). Maior arquivo: 278.
- Logística: schemas function-local (812-846) IÇADOS pro nível de módulo em
  route-logistica.ts (export; prova reversa); o parser de imagem registra em
  registerPainelLogistica ANTES das rotas de upload (ordem do composer).
- Costura de imports 100% guiada pelo tsc (script iterativo, 2 rodadas).
- teto-herdado.json: route.ts QUITADO (3º; **sobram 14**).

## Prova nova: `scripts/prova-rotas-matriz.ts` (+ baseline-rotas-matriz.json)

Manifesto **[método + URL + CADEADO]** das 86 rotas vs baseline: rota que
sumir/aparecer OU **perder o preHandler** reprova sozinha. O cadeado no
manifesto = recomendação da banca de segurança, acatada no mesmo commit.
Baseline: **57 AUTH + 29 públicas** (estáticos + seja-parceiro, as de sempre).
⚠️ Mudou rota DE PROPÓSITO? Regravar: `npx tsx --env-file=.env.pooler
scripts/prova-rotas-matriz.ts --gravar-baseline` no mesmo commit.

## Banca

- **seguranca = SHIP**: guards 57=57; fingerprint método+caminho+auth diff
  VAZIO; corpo normalizado sem linha executável removida; funil blindado do
  comprovante byte-idêntico; públicas = exatamente as intencionais; portal do
  entregador intocado.
- **Cadeira da matriz**: o revisor caiu no LIMITE MENSAL DE GASTO da conta ao
  concluir (25 tool calls feitos, veredito não emitido). Itens residuais
  fechados INLINE pelo orquestrador: ordem do composer == ordem original
  (parser antes do upload ✓); cada register chamado 1× ✓; zero path duplicado
  entre módulos ✓; handlers de dinheiro byte-idênticos (prova do gerador +
  varredura normalizada da seguranca) ✓.

## Cadeia de prova

corpos verbatim ✓ · tsc 0 ✓ · fiscal 15 arquivos ≤300 ✓ · 522 unit ✓ ·
**86/86 rotas (agora com cadeado)** ✓ · preview 4222 pós-obra: 15 endpoints
200 com Bearer, 401 sem token, estáticos 200 ✓ (único 500 = EMAXCONNSESSION
do pooler local sob rajada de curl; 3 retries isolados = 200 — ambiente).

## Fila da obra 300

1-3. ~~painel app.js~~ ✅ · ~~queries matriz~~ ✅ · ~~route matriz~~ ✅
4. `src/parceiro/queries.ts` (4.285 — o maior) → 5. `src/parceiro/route.ts`
(1.653) → 6. bot (tools 1.987, fulfillment 1.398...) com banca. Miúdos na passada.

## Avisos

- Preview 4222 de pé (env test). Deploy manual do dono; pós-deploy conferir
  painel + /entregas vivos (sem ?v= novo — backend).
- ⚠️ Limite mensal de gasto da conta Claude atingiu o teto durante a banca —
  agentes Opus podem falhar até o dono subir o limite (claude.ai/settings/usage)
  ou virar o mês.

— Orquestrador (Claude Fable 5)
