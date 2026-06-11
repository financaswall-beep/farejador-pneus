# HANDOFF — Obra do painel ≤300: merge+deploy da Onda B, limpezas M2+F9, PASSO 7 (estoque) (2026-06-11, sequência)

> Sessão: continuação direta do fechamento da Onda B (ver
> `docs/SESSAO_2026-06-11b_OBRA_PAINEL_ONDA_B_HANDOFF.md`, §8 = merge desta sessão).
> Plano oficial (LER ANTES de mexer): `docs/PLANO_REFATORACAO_PAINEL_300_2026-06-10.md`.
> Branch: `feat/refatoracao-painel-300`. **Onda B LIVE em prod; Onda C INICIADA (passo 7 ✅).**
> Autor: Orquestrador (Claude Fable 5) — domínio `parceiro`.

---

## 1. Estado em uma linha

Onda B mergeada (`9d0f989`) e **deploy CONFERIDO byte-idêntico no site real** (~1,5 min;
sha `9ae355f4…`) → dono aprovou 2 limpezas (M2 declara fantasmas; **F9 APAGAR** os 8
renders órfãos ~330 linhas) → **passo 7 (estoque) FEITO** com contrato 0076 testado na
loja de teste. app.js **3071 → 2589**. Próximo: **passo 8 (PDV — 🔴 dinheiro; sessão fresca)**.

## 2. Commits da sessão (ordem)

| Commit | O quê |
|---|---|
| `9d0f989` | **merge da Onda B no main** (autorizada: "confio nas provas, pode subir") |
| `67e5b71` | docs — plano/handoff: Onda B live, deploy conferido |
| `2aee88a` | **M2** — declara `chatSending`/`orderCustomerTimer` (F2); baseline 471→473 |
| `dcd8fa9` | **F9** — apaga 8 renders órfãos (~366 del.); `charts.financeiro.js` MORREU; `resumo.js`=19 (só maestro); baseline 473→465 |
| `f65d8f3` | docs — M2 FEITA + F9 RESOLVIDO no plano |
| `3111ad5` | **Passo 7** — `app.estoque.kpis.js` (258) + `app.estoque.forms.js` (255); app.js 2589 |
| (este) | docs — passo 7 ✅ na tabela + este handoff |

## 3. Decisões do dono NESTA sessão

1. **Onda B: "confio nas provas, pode subir"** (sem giro no preview) → merge + deploy conferido.
2. **F9: APAGAR** os 8 gráficos órfãos (sabendo: ~330 linhas, financeiro.js inteiro morto).
3. **M2: DECLARAR** as 2 caixinhas fantasma.
4. Perguntou "o que ganhamos com a refatoração" → expliquei honesto (usuário não ganha
   nada; ganho = velocidade/segurança/custo de manutenção futura). Perguntou "cresce pra
   onde?" → cresce PRO LADO (arquivo irmão novo), nunca re-engorda; teto é alarme.

## 4. O que existe agora (11 arquivos + raiz 2589)

`format` 150 · `labels` 168 · `charts.resumo` **19** (só maestro; F9) · `charts.pdv` 158 ·
`foto` 228 · `chat` 255 · `chat.cliente` 246 · `config` 251 · **`estoque.kpis` 258 (novo)** ·
**`estoque.forms` 255 (novo)** · `app.js` **2589**. (`charts.financeiro.js` NÃO EXISTE MAIS.)
Paridade pós-limpezas = **465** (471 +2 M2 −8 F9). Contratos = 69 (intactos).

## 5. Passo 7 — como foi (zona de contrato 0076)

- **Reli `SECOES/ESTOQUE.md` antes** (regra). Pontos-chave aplicados: upsert sobrescreve
  TUDO → payload sempre completo; saldo+status recalculados juntos; disponível =
  físico − reservado.
- **Recorte fino:** 6 ranges do `dcd8fa9` (kpis: 599–733, 750–836, 1325–1331, 2908–2919;
  forms: 2274–2418, 2921–3015). Helpers compartilhados com o financeiro
  (`isPhysicalExitSale`, `saleRealizedAt`, `isCurrentMonth` ×2 = **F1 intacta**,
  `salesUnitsFor`) **ficaram na raiz** — destino decidido no passo 9.
- **Extrator com âncoras de sanidade** (16 linhas conferidas antes do corte; aborta se
  uma não bater) — apagado após uso (regra).
- **Golden 59/59** (`obra-teste-passo7-estoque.cjs`, ancora no COMMIT FIXO dcd8fa9):
  KPIs de borda 0076, validações barram antes do POST, payload por tipo (serviço força
  `is_tracked=false` e anula físicos), **CONTRATO: as 18 colunas presentes no
  _persistStockQuantity**, byte a byte, helpers ficaram, F1 com 2 cópias.
- **Tela real (loja de teste, pela própria tela):** criar → entrada +1 → ajuste → inativar;
  **snapshot final IDÊNTICO ao inicial** (zero sobra); preservação de marca/posição/
  fornecedor/preço provada no banco real; KPIs 20→23→24→22→20; console zero erro.
- color-moved: 973 movidas, 33 não-movidas TODAS estruturais (cabeçalhos/montagem).

## 6. Aprendizados NOVOS desta sessão

- **git diff pra arquivo DESLIGA cor** → color-moved precisa `git -c color.diff=always`.
  E módulo novo untracked fica FORA do diff → `git add -N` antes.
- **Fixture de golden com template (`item({over})`): cuidado com campos herdados** —
  3 falhas iniciais eram o serviço/zerado herdando marca/fornecedor do template (o
  código estava certo; a fixture errada).
- **Assinatura em teste de "saiu do app.js": usar `nome(args) {` com abre-chave** —
  `stockAvailable(item)` sem chave casa com a CHAMADA `this.stockAvailable(item)` dos
  consumidores do PDV (falso positivo).
- **Teto do M2:** regra "só diminui" ganhou campo `_excecoes` documentado no próprio
  JSON (M2 +2, F9 −1) — auditável, não escondido.
- O golden do passo 3 foi **REGRAVADO pós-F9** (3 vivos + trava anti-regressão: mortos
  não voltam; financeiro.js não existe). Goldens são da REALIDADE atual, não do passado.

## 7. Ambiente / pendências

- **Preview 4101**: de pé, logado na loja de teste, `?v=20260611-onda-b` com os 2 módulos
  novos. serverId `98b2f92f…` (muda a cada restart).
- **Preview alheio 4100**: de pé (regra), desatualizado.
- **One-off untracked:** goldens 1/2/3(regravado)/4/5/6/**7** + `obra-preview-4101.cjs`.
- **Modificação alheia não-commitada:** `docs/CONTRATO_ESTOQUE_FINANCEIRO_0076_0077.md`
  (outra frente; ficou fora de todos os commits — stash/restaurada no merge).
- ⚠️ Lembrete de NEGÓCIO fora da obra: **raios de entrega de TESTE nos 7 parceiros**
  (bot roteia com número falso) — troca depende de validar Fase 3 ao vivo + raios reais.

## 8. Como retomar (próxima sessão)

1. **Passo 8 (PDV/Vendas) — 🔴 dinheiro+estoque, o MAIS sensível da obra.** Sessão
   fresca de propósito (regra 6/7 do plano: validação extra em zona crítica).
   Blocos: carrinho/checkout/finalizar/cancelar + getters pos* + busca/cadastro cliente
   PDV. Teste: na loja de TESTE, venda Pix 1 item → estoque baixa, caixa soma →
   CANCELAR → estoque/caixa voltam. F2 e Esc funcionam.
2. Depois: passo 9 (financeiro; resolver F1/M3 + decidir destino dos helpers
   compartilhados), passo 10 (raiz fina), passo 11 (encerramento + faxina goldens).
3. Onda C completa → dono valida → merge no main (igual A e B).
4. Fora da obra: porta única de login, faxina docs/scripts, raios reais.
