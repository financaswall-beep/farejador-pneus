# HANDOFF — Obra do painel ≤300: Passo 3 (charts) + fechamento e MERGE da Onda A (2026-06-11)

> Sessão: continuação da obra (passos 0–2 na sessão anterior — ver
> `docs/SESSAO_2026-06-10_OBRA_PAINEL_PASSOS_0_A_2_HANDOFF.md`).
> Plano oficial (LER ANTES de mexer): `docs/PLANO_REFATORACAO_PAINEL_300_2026-06-10.md`.
> Branch: `feat/refatoracao-painel-300`. **Onda A MERGEADA no main nesta sessão (autorizada
> pelo dono) → push → deploy automático Coolify.**
> Autor: Orquestrador (Claude Fable 5) — domínio `parceiro`.

---

## 1. Estado em uma linha

Passo 3 FEITO (charts em 3 módulos por TELA) = **ONDA A COMPLETA** (passos 0–3 + F7/M1/M4);
dono validou a interface e autorizou o merge → main → deploy. Senha da loja de teste trocada
e provada NA TELA (gate da Onda B/C liberado). Pedido novo do dono anotado: **porta única de
login** (`/parceiro` sem slug) — fazer DEPOIS, fora da obra. Próximo: **Onda B (passo 4, foto)**.

## 2. Commits da sessão (ordem cronológica)

| Commit | O quê |
|---|---|
| `06634e0` | **Passo 3** — extrai `app.charts.{resumo,financeiro,pdv}.js` (486 linhas VERBATIM, 27 âncoras); app.js 4478→3995; **adendo F8** (regex de módulo composto na rota + fiscais) |
| `95c2ba7` | docs — passo 3 ✅ na tabela §6, adendo F8 no §7, contagem 4.755 alinhada |
| `58e1237` | docs — senha da zz-teste-copacabana trocada (gate onda B/C quitado no plano + CLAUDE.md) |
| `add4050` | **M4** — etiqueta `?v=20260611-onda-a` nos 6 scripts (fechamento da onda) |
| (merge) | Onda A → main (ver `git log main`) |

## 3. Passo 3 — o que existe agora

- **3 módulos por TELA** (desvio do plano registrado: eram 2 de ~240, mas o lado
  financeiro+PDV real tinha 316 linhas >300; recorte por tela mantém coesão e folga):
  - `app.charts.resumo.js` (174) — maestro `renderAllCharts` + abas Resumo e Estoque;
  - `app.charts.financeiro.js` (188) — aba Financeiro (Bar, Split, Origin, Units);
  - `app.charts.pdv.js` (158) — tela PDV (PosSparkline, RevenuePos, CostsPos — os que
    reagem a `this.theme`).
- **Adendo F8 (CRÍTICO, consertado no mesmo commit):** o regex da rota de módulos
  (`route.ts:491`) e o dos fiscais (`checar-tamanho.cjs`, `prova-endpoints-painel.cjs`)
  só aceitavam UM segmento (`app.format.js`) — TODO nome composto do plano
  (`app.charts.resumo.js`, `app.estoque.forms.js`…) daria **404 em prod** e ficava
  **invisível pros fiscais**. Agora: rota `^app(\.[\w-]+)+\.js$` (1+ segmentos; `app..js`
  e traversal continuam 404 — provado com negativos no preview) e `(\.[\w-]+)*` nos
  fiscais. Vale pros módulos das ondas B/C — não tocar de novo.
- **Golden do passo** (`scripts/obra-teste-passo3-charts.cjs`, one-off untracked, fica até
  o passo 10): 16/16 — 11 gráficos pintam nos 2 temas com o app REAL montado em vm
  (Chart instrumentado), trocar tema repinta (11 destroys + cores do tema novo), canvas
  ausente não explode, byte a byte vs HEAD. Extrator `obra-extrai-passo3.cjs` APAGADO
  após uso (regra).
- Provas do checklist: paridade 471/471 · contratos 69/69 · fiscal 6 arquivos ok ·
  color-moved: 44 linhas não-movidas TODAS estruturais · typecheck · vitest 379/379 ·
  preview 4101 (console limpo, módulos 200).

## 4. Fora da obra (mesma sessão)

- **Senha da `zz-teste-copacabana` TROCADA** (script `resetar-senha-parceiro.cjs`,
  DRY-RUN → COMMIT=1; login `wallace`, owner). Provada DUAS vezes: fetch 200 e **login
  clicado NA TELA** (preencher campos + botão) com painel carregando inteiro. Valor está
  SÓ com o dono (não persistido em lugar nenhum); perdeu = rodar o script de novo.
  **Gate de ambiente da Onda B/C: LIBERADO.**
- **"Usuário e senha incorreto" do dono:** diagnóstico = confusão de loja (a senha nova é
  da loja de TESTE; no Rio do Ouro vale a senha de sempre dele) e/ou autofill/maiúsculas.
  Não era bug.
- **Pedido novo do dono (decisão de produto):** login em **porta única** `/parceiro`
  (sem slug na URL) → loga → cai na unidade do login; username repetido (wallace existe
  em 4+ unidades) resolve com tela "em qual loja você quer entrar?" listando SÓ onde a
  senha validou; rate-limit global + revisão `seguranca`. **DECIDIDO fazer DEPOIS do
  merge, fora da obra** (~meio dia). Desenho completo na memória do orquestrador
  (`project_porta_unica_login`). As URLs por slug NÃO morrem (API/SSE ancorados nelas).

## 5. Lições operacionais novas

- **Testar o NOME do arquivo novo contra as whitelists ANTES de criar** (rota/fiscais/
  provas) — o 404 do adendo F8 foi pego por checagem preventiva, não por quebra.
- **O preview server NÃO recarrega código do backend** (tsx sem watch): mudou route.ts →
  reiniciar o servidor da obra (preview_stop + preview_start; o serverId MUDA). Os 404
  dos módulos novos no processo velho confundem como se fosse bug do regex novo.
- **`preview_fill` dispara os eventos do `x-model`** (Alpine atualiza) — dava pra logar
  na tela via tooling. O login NÃO usa `<form>`: achar o botão visível por TEXTO e marcar
  com `data-attr` pra clicar (CSS não seleciona por texto; havia submits invisíveis em
  modais que enganam o seletor genérico).
- A 4101 logada sobrevive a reload (sessão persistente) — bom pros testes da Onda B.

## 6. Ambiente / pendências

- **Preview da obra 4101**: de pé, **logado na loja de teste**, serverId atual
  `98b2f92f…` (muda a cada restart — pegar via preview_list).
- ⚠️ **Preview alheio da 4100** (processo de outra sessão): continua de pé por regra;
  processo VELHO sem a rota nova → recarregar a página lá = 404 nos módulos = tela morta.
  Reiniciar quando o dono autorizar (ou morre sozinho quando o main dele atualizar).
- **One-off untracked que ficam:** goldens passo 1/2/3 (`obra-teste-passo*.cjs`),
  wrapper `obra-preview-4101.cjs`. Faxina geral no passo 11.
- **Pós-deploy desta onda:** dono valida no CELULAR no site real (giro resumo/vendas/
  estoque/financeiro/PDV nos 2 temas — os gráficos são o que mudou).

## 7. Como retomar (próxima sessão)

1. Conferir deploy da Onda A ok (site real; Coolify ~2-10 min após o push).
2. `git checkout feat/refatoracao-painel-300` (continua viva pras ondas B/C; após o
   merge ela == main).
3. **Onda B = passos 4 (FOTO), 5 (chat), 6 (config)** — risco médio, SSE/upload.
   Passo 4: bloco FOTO (~linhas 2120–2340 do app.js de 3995; conferir com grep
   `FOTO|photo`) → `app.foto.js` ≤300. Teste na loja de TESTE (senha com o dono):
   card de foto, countdown, botão ENVIAR nasce HABILITADO (lição do `!!`), envio anexa.
4. Checklist §4 do plano em TODO passo + teto no MESMO commit + ✅ na tabela §6.
5. Depois da Onda B validada: porta única de login (memória `project_porta_unica_login`).
