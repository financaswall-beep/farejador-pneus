# HANDOFF — Obra do painel ≤300: PASSOS 8 (PDV) e 9 (financeiro) + M3 (2026-06-12)

> Sessão: continuação da Onda C (passo 7 na sessão anterior — ver
> `docs/SESSAO_2026-06-11c_OBRA_PAINEL_LIMPEZAS_E_PASSO7_HANDOFF.md`).
> Plano oficial (LER ANTES de mexer): `docs/PLANO_REFATORACAO_PAINEL_300_2026-06-10.md`.
> Branch: `feat/refatoracao-painel-300` (NÃO mergeada — Onda C sobe inteira após validação).
> Autor: Orquestrador (Claude Fable 5) — domínio `parceiro`.

---

## 1. Estado em uma linha

Os DOIS passos 🔴 de dinheiro da obra FEITOS na mesma sessão com contrato provado no
banco real: **passo 8 PDV** (venda Pix R$ 99 via F2 → estoque 10→9 + caixa 0→99 →
cancela → tudo volta) e **passo 9 financeiro** (pagar conta GEROU despesa via dedupe;
receber conta entrou no caixa 0→120; score 815 idêntico antes/depois) + **M3** (F1
resolvida). app.js **2589 → 1061**; 19 módulos ≤300. Falta: **passo 10 (raiz fina:
auth/core — precisa de CREDENCIAL pra teste de login, ver §6)** e passo 11 (encerramento).

## 2. Commits da sessão (ordem)

| Commit | O quê |
|---|---|
| `d1236bc` | **Passo 8** — `app.pdv.kpis.js` (167) + `app.pdv.js` (294) + `app.pdv.clientes.js` (261); `itemTypeLabel`/`itemPrimaryLabel` → labels (180) |
| `fd60a2b` | docs — passo 8 ✅ na tabela (desvios: 3 arquivos; rótulos no labels) |
| `ea22ea3` | **M3** — apaga a cópia SOMBREADA de `isCurrentMonth` (F1 resolvida; vigente única na raiz) |
| `29e9817` | **Passo 9** — 5 módulos `app.financeiro.*` (kpis 191, score 177, compras 188, contas 148, receber 190) |
| (este) | docs — passo 9 ✅ + M3 ✅ + este handoff |

## 3. O que existe agora (19 arquivos + raiz 1061)

`format` 150 · `labels` 180 (ganhou 2 rótulos no p8) · `charts.resumo` 19 · `charts.pdv` 158 ·
`foto` 228 · `chat` 255 · `chat.cliente` 246 · `config` 251 · `estoque.kpis` 258 ·
`estoque.forms` 255 · `pdv.kpis` 167 · `pdv` 294 · `pdv.clientes` 261 · `financeiro.kpis` 191 ·
`financeiro.score` 177 · `financeiro.compras` 188 · `financeiro.contas` 148 ·
`financeiro.receber` 190 · `app.js` **1061** (estado + auth + init/api/loadData/navegação +
getters do Resumo + pedidos/entregas — é o que o passo 10 fatia).
Paridade segue **465**; contratos **69**; etiqueta ainda `?v=20260611-onda-b` (M4 no
fechamento da onda).

## 4. Decisões de recorte desta sessão (registradas na tabela §6 do plano)

- **Passo 8 em 3 arquivos** (não 2): bloco de vender tinha 441 linhas. kpis/fluxo/cliente.
- **`itemTypeLabel`/`itemPrimaryLabel` → app.labels.js**: rótulo compartilhado (estoque 6×,
  PDV 2×) — o lugar é o módulo de rótulos.
- **Passo 9 em 5 arquivos** (não 2): CRUD 487 + getters/score 330 não cabem em 2×300.
- **Helpers 0076/0077** (`isPhysicalExitSale`/`saleRealizedAt`/`salesUnitsFor`) →
  `financeiro.kpis` (a regra de "venda realizada" é contrato financeiro; estoque/pdv acham
  via `this`). Raiz mantém `salesTodayCount`/`completedSales`/`salesSeries7d` (Resumo, p10).
- **M3**: só a cópia morta saiu; a vigente FICA na raiz (mover pro format = decisão do p10).

## 5. Provas que passaram (cada passo)

- Paridade **465/465** · contratos **69/69** · fiscal ≤300 · color-moved (p8: 1395 movidas/47
  estruturais; p9: 1664/77, sendo 5 = montagem) · typecheck · vitest **379/379** · `node
  --check` em todos os arquivos tocados.
- **Goldens one-off** (untracked): `obra-teste-passo8-pdv.cjs` **56/56** (0076 carrinho barra
  além do disponível; 0077 caixa do dia sem dupla contagem; customerSales SÓ venda
  realizada; **idempotency_key ESTÁVEL na re-tentativa** e zerada no sucesso; installments
  SEMPRE 1) · `obra-teste-passo9-financeiro.cjs` **64/64** (totalCusts = CMV+despesas com
  COMPRAS FORA; pagos/recebidos só do mês; score clamp/ângulo/cor por tema; **dedupe 409
  nos 2 desfechos**; M3 consolidada).
- **Tela real (loja de teste, banco REAL):**
  - PDV: venda Pix R$ 99 disparada com **F2 de verdade** → estoque 10→9, caixa 0→99 →
    `cancelSale` → 10 / 0 / snapshot idêntico. **Esc** limpa carrinho (tecla real).
  - Financeiro: conta a pagar criar→**pagar** (servidor **gerou a despesa** via dedupe — é o
    contrato 0078) → limpa; conta a receber criar→cancelar (A) e criar→**receber** (B) →
    **caixa do dia 0→120** → limpa. **Score 815/Ótimo/326,7° idêntico antes/depois.**
  - Console ZERO erro; giro 8 seções ok em todos os passos.

## 6. Aprendizados/avisos NOVOS desta sessão

- **Conta PAGA/RECEBIDA não se cancela pelo sistema** (`cancelPartnerPayable` tem
  `AND status='open'` — regra correta: pagamento é fato consumado). O DELETE devolve
  `payable_not_found` (404). Limpeza de teste = soft-delete cirúrgico via script one-off
  (dry-run → COMMIT; travas: id exato + descrição de teste + slug zz-teste; APAGADO após uso).
- **`unit_id` de `finance.partner_*` aponta pra `core.units`**, NÃO pra
  `network.partner_units` (JOIN errado = "não existe").
- O flash de erro de uma ação pode ser SOBRESCRITO pelo flash da ação seguinte —
  conferir efeito no DADO, não só na mensagem.
- **⚠️ Passo 10 tem dependência de AMBIENTE:** o teste exige login/logout real na loja de
  teste e **a senha está SÓ com o dono** (trocada em 06-10). Caminhos: (a) dono presente
  informa a senha na hora do teste; (b) dono autoriza rodar `scripts/resetar-senha-parceiro.cjs`
  (gera senha nova). O fluxo 401→login dá pra testar sem credencial (guardar token,
  simular 401, restaurar) — mas o POST /login de verdade não.

## 7. Ambiente / pendências

- **Preview 4101**: de pé, logado na loja de teste (sessão sobrevive a reload), serverId
  `98b2f92f…`. **Preview alheio 4100**: de pé (regra), desatualizado.
- **One-off untracked que ficam:** goldens 1–9 + `obra-preview-4101.cjs`. Extratores e o
  script de limpeza do p9 APAGADOS (regra).
- **Modificação alheia não-commitada:** `docs/CONTRATO_ESTOQUE_FINANCEIRO_0076_0077.md`
  (outra frente) — fora de todos os commits.
- ⚠️ Lembrete de NEGÓCIO (fora da obra): raios de entrega de TESTE nos 7 parceiros.

## 8. Como retomar — A FILA TRAVADA (confirmada com o dono em 06-12)

1. **Passo 10 (raiz fina)**: ESTADO (16–218 da raiz atual) fica; extrair `app.auth.js`
   (login/logout/sessão) + `app.core.js` (init/api/loadData/navegação/SSE global?). Teto
   final da raiz ~250. **Resolver a credencial ANTES (§6):** dono informa a senha da
   zz-teste na hora OU autoriza `scripts/resetar-senha-parceiro.cjs`. Teste:
   login+logout+primeiro acesso na loja de teste; 401 volta pro login; funcionário com
   permissão parcial. ⚠️ O passo 10 SÓ MOVE o login de gaveta — comportamento idêntico
   (regra 1); ele NÃO é a porta única.
2. **Passo 11 (encerramento)**: CLAUDE.md ganha a regra do teto 300 + fiscal no fluxo;
   `?v=` final (M4 da onda C); apagar `obra-painel-teto.json` (passa a valer o teto 300
   universal); faxina dos goldens; checklist completo; **dono valida o dia a dia no celular**.
3. **Merge da Onda C no main** = só com autorização do dono (regra §5; rollback = revert).
4. **🔔 GATILHO PÓS-MERGE — PORTA ÚNICA DE LOGIN (tarefa #1 depois da obra; o dono
   re-confirmou em 06-12 e exemplificou a URL: `farejador.smarttecsolutions.com.br/login`):**
   uma URL só de login pra TODOS os parceiros → valida usuário+senha → 1 loja entra
   direto; multi-loja (wallace existe em 4+) vê "em qual loja você quer entrar?" listando
   SÓ onde a senha validou; URLs por slug NÃO morrem (API/SSE ancorados nelas + favoritos);
   rate-limit por IP+username GLOBAL + revisão `seguranca` antes de subir; ~meio dia.
   Desenho completo: memória `project_porta_unica_login`; gatilho também no plano §5.
5. Depois, fora da obra: faxina docs/scripts; F5 (charts em `window._xxx`); raios reais
   de entrega (precisa do dono no WhatsApp + valores reais).

## 9. Conversa pós-handoff (mesma data, registrada)

- Dono perguntou **"o pior já foi?"** → resposta dada: SIM no risco que dói (dinheiro
  silencioso, passos 7-9, provado no banco real); o passo 10 é a espinha — se errar, o
  painel não abre (falha ESCANDALOSA, detecção instantânea, rollback 1 comando), e os
  goldens 1-9 remontam o app inteiro a cada rodada (rede madura).
- Dono perguntou se o passo 10 já entrega a **porta única** (`/login`) → esclarecido:
  NÃO (passo 10 = mover, zero comportamento novo); a porta única é o GATILHO pós-merge
  (item 4 acima). Dono confirmou a fila.
