# HANDOFF — Obra do painel ≤300: Passos 0, 1 e 2 + fixes F7/M1 (2026-06-10)

> Sessão: execução da refatoração do `parceiro/public/app.js` (4.755 → ~16 arquivos ≤300).
> Plano oficial (LER ANTES de mexer): `docs/PLANO_REFATORACAO_PAINEL_300_2026-06-10.md` (progresso marcado na tabela §6).
> Branch: `feat/refatoracao-painel-300` (a partir do main `c0d7913`). **Main intocado — NADA foi pro ar.**
> Autor: Orquestrador (Claude Fable 5) — domínio `parceiro`.

---

## 1. Estado em uma linha

Passos 0–2 FEITOS e provados (fundação + `app.format.js` + `app.labels.js`; app.js em **4.478** linhas),
fixes F7 (console limpo) e M1 (log que vazava venda) autorizados pelo dono e shipados em commits
próprios. **Falta o Passo 3 (charts) pra fechar a Onda A** → dono valida no celular → merge = deploy.

## 2. Commits da branch (ordem cronológica)

| Commit | O quê |
|---|---|
| `fd1b2a5` | **Passo 0** — 3 ferramentas de prova + baselines + fiscal + npm scripts; plano entrou no git |
| `444ffbe` | **Passo 1** — `app.format.js` (150 linhas, 138 movidas verbatim); `montarParceiroApp`; rota genérica de módulos no `route.ts` (F8) |
| `d5034eb` | docs — achados F7/F8 registrados no plano §7 |
| `2a9406b` | **Fix F7** — guards de null (linha 1192 + @error avatar ×3); console de carga sem warn de Alpine |
| `7f6e7ee` | **Melhoria M1** — `console.log` do saveSale removido (vazava body da venda no DevTools em prod) |
| `654e9a4` | **Passo 2** — `app.labels.js` (168 linhas, 153 movidas verbatim em 4 sub-blocos) |

Depois: commit docs desta sessão (plano marcado + este handoff).

## 3. O que existe agora (e não existia)

- **`scripts/prova-paridade-painel.cjs`** — impressão digital do `parceiroApp()`: carrega os `app*.js`
  NA ORDEM do index.html num vm com browser mockado e compara `getOwnPropertyDescriptors` com
  `scripts/baseline-paridade-painel.json` (**471 propriedades**: 223 functions + 102 getters + 146 estados.
  O plano estimava ~346 — o baseline é a verdade). Getters NÃO são executados.
- **`scripts/prova-endpoints-painel.cjs`** — congela os **69 contratos de rede** (62 chamadas
  `this.api`/`fetch`/`new EventSource` com parênteses balanceados + 7 literais com `/api/`, que pegam
  a URL do SSE montada FORA da chamada). Baseline em `scripts/baseline-endpoints-painel.json`.
  Também reprova módulo órfão (app*.js na pasta fora do index.html).
- **`scripts/checar-tamanho.cjs`** — teto 300 pra `parceiro/public/app*.js`; o `app.js` tem teto
  TEMPORÁRIO em `scripts/obra-painel-teto.json` (**4478** hoje; SÓ DESCE, atualizar no MESMO commit
  de cada extração; apagar o JSON no passo 11).
- **Atalhos:** `npm run prova-painel` (roda as 3) e `npm run checar-tamanho`.
- **`parceiro/public/app.format.js`** (150) — máscaras (telefone/CPF/moeda), medida de pneu,
  datas, deep-links WhatsApp/Waze/Maps, helpers puros (`num/money/uuid/isSaving/dateKeySaoPaulo`).
- **`parceiro/public/app.labels.js`** (168) — categorias despesa/conta, origem 2W/porta, chips de
  status do estoque, posição/origem do pneu, rótulos de quantidade 0076 (display), toast
  (`flash`/`inferStatusKind`), `errMessage`.
- **`montarParceiroApp(estado, fabricas)`** no topo do `app.js`: merge por
  `Object.defineProperties(out, Object.getOwnPropertyDescriptors(f()))`. ⚠️ **NUNCA spread** —
  executa o getter e congela o valor (risco nº 1 da obra). Ordem do array = ordem de merge.
- **Rota backend nova** (`src/parceiro/route.ts`): `/parceiro/:slug/:script` genérica com whitelist
  `^app\.[\w-]+\.js$` + `path.basename` (path traversal morto; fora do padrão = 404). Era rota
  explícita POR ARQUIVO — sem isso, módulo novo = 404 em prod (achado F8). Vale pros 15 módulos
  que faltam; backend não precisa ser tocado de novo.

## 4. Decisões tomadas nesta sessão (e por quê)

1. **Desvio do §1 do plano (backend):** servir os módulos exigiu a rota genérica (F8). Mínima,
   no padrão da rota de assets, registrada no plano e no commit.
2. **Recorte do passo 2 mais fino que o range do plano:** `stockAvailable` (regra 0076 que trava
   venda no PDV), `stockItemValue`, `selectStock`/modais e entrada/ajuste de saldo
   (`_persistStockQuantity`, POST /estoque) **NÃO são rótulo** → ficam pro **passo 7** (que tem
   teste de contrato na loja de teste). `customer*`/`purchaseItemsLabel` → passos 8/9.
   Critério: só leitura/rotulagem sai num passo verde.
3. **M2 (declarar `chatSending`/`orderCustomerTimer`) ADIADA pra onda B** mesmo com autorização:
   adiciona propriedade ao manifesto → invalidaria o baseline de paridade no meio da onda A.
   Quando fizer: regenerar o baseline no MESMO commit, com justificativa.
4. **M1 antecipada da onda C** (autorização do dono): deleção de 1 linha, risco zero, provas verdes.
5. **Indentação preservada nos módulos** (métodos com 4 espaços dentro de `({`): mantém o diff
   100% "movido" sem flags especiais.

## 5. Lições operacionais (valem pros próximos passos)

- **Mojibake histórico** no app.js/index.html (`â”€` etc.): extração de bloco grande = **por número
  de linha** (script one-off com âncoras de sanidade que abortam se o arquivo não for o esperado),
  nunca por old_string com os caracteres podres. Edits pequenos: âncoras 100% ASCII.
- **Commit multilinha com aspas duplas quebra o here-string** no PowerShell tool → escrever a
  mensagem em arquivo e `git commit -F arquivo` (apagar depois).
- **Golden test em vm:** `Error` criado no realm do Node NÃO é `instanceof Error` no realm do vm —
  criar o erro DENTRO do contexto (`vm.runInContext("new Error(...)")`).
- **`Measure-Object -Line` ignora linha em branco** — contar linhas com `(Get-Content x).Count`.
- **O fiscal mordeu o autor** (teto 4477 vs real 4478 — a linha nova do array de fábricas):
  atualizar o teto contando TUDO que o passo adiciona ao app.js.
- **`preview_start` não adota servidor que ele não lançou**: derrubar o próprio processo e deixar
  a ferramenta ser dona (entrada `parceiro-obra-4101` no `.claude/launch.json`, wrapper
  `scripts/obra-preview-4101.cjs` que força a porta).

## 6. Provas rodadas (tudo verde no fim da sessão)

- Paridade **471/471** idêntica (após cada passo) · Contratos **69/69** · Fiscal ok
  (`format=150`, `labels=168`, `app.js=4478 ≤ teto 4478`).
- "Só movido": **byte a byte vs HEAD** — 138 linhas (passo 1) e 153 em 4 sub-blocos (passo 2).
- Golden: **27/27** (formato) e **31/31** (rótulos/toast/chips, incluindo prova CROSS-FILE:
  `stockQtyDisplay` no labels chamando `this.stockAvailable` que ficou no app.js).
- `npm run typecheck` + `npm test` **379/379** (rodados no passo 1, que tocou backend).
- Browser real (preview 4101): fábricas `format`+`labels` carregadas, Alpine montou, toast e chip
  certos ao vivo, **console nível error VAZIO**; sabotagens A/B provaram que cada prova morde
  só no seu domínio (passo 0).

## 7. Ambiente / pendências operacionais

- **Preview da obra: porta 4101**, gerenciado pelas preview tools (config `parceiro-obra-4101`,
  aponta pra PROD via `.env.preview`). Tela de login basta pros passos verdes; login de verdade
  só vai ser necessário no teste de contrato (onda B/C).
- ⚠️ **Preview alheio da 4100** (processo de outra sessão, deixado de pé por regra): serve os
  ARQUIVOS novos do disco mas o processo VELHO não tem a rota de módulos → **recarregar a página
  lá = tela morta (404 no app.format.js)** enquanto o working tree estiver na branch da obra.
  Dono autorizando, é só reiniciar aquele processo (ou esperar o merge).
- **One-off untracked que FICAM até o fim da obra** (não commitar — regra dos scripts de operação):
  `scripts/obra-teste-passo1-format.cjs` e `scripts/obra-teste-passo2-labels.cjs` (goldens, re-úteis
  no passo 10 quando a montagem mudar) e `scripts/obra-preview-4101.cjs` (wrapper do preview).
  Extratores `obra-extrai-passo1/2.cjs` foram apagados após uso. Faxina geral no passo 11.
- **Etiqueta `?v=20260606-gps`** mantida de propósito nos 3 script tags — troca é no fechamento
  da onda (M4), tudo junto.
- **Pendência pré-onda B/C:** senha temporária da `zz-teste-copacabana` (testes de contrato).
- **Pendência separada da obra:** faxina de docs/scripts velhos (lista pro dono aprovar).

## 8. Como retomar (próxima sessão)

1. `git checkout feat/refatoracao-painel-300` · ler o plano §6 (tabela com ✅) e este handoff.
2. Conferir chão: `npm run prova-painel` → 3× [OK].
3. **Passo 3 (fecha a Onda A):** extrair os 11 `render*Chart` + `renderAllCharts` (bloco começa
   ~linha 3690 no app.js atual; era 3820–4304 no original) em **2 arquivos**:
   `app.charts.resumo.js` (resumo/estoque) e `app.charts.financeiro.js` (financeiro/PDV) — ambos
   ≤300. Atenção F5 (charts em `window._xxxChart` — NÃO mexer). Teste do passo: gráficos pintam
   nos DOIS temas + trocar tema repinta (dá pra provar via vm chamando os render com canvas
   mockado + browser; visual fino fica pra validação do dono na onda).
4. Checklist de 8 itens do plano §4 + atualizar teto no MESMO commit + marcar ✅ na tabela §6.
5. Onda A fechada → **dono valida no celular** (login real, giro: resumo/vendas/estoque/financeiro/
   chat/foto nos 2 temas) → merge no main = **deploy automático Coolify** → trocar `?v=` (M4) →
   só então começar a onda B.
