# HANDOFF — Obra do painel ≤300: ONDA B completa (passos 4-5-6: foto, chat, config) (2026-06-11, madrugada)

> Sessão: continuação direta do merge da Onda A (ver
> `docs/SESSAO_2026-06-11_OBRA_PAINEL_PASSO3_MERGE_ONDA_A_HANDOFF.md`).
> Plano oficial (LER ANTES de mexer): `docs/PLANO_REFATORACAO_PAINEL_300_2026-06-10.md`.
> Branch: `feat/refatoracao-painel-300`. **Onda B COMPLETA NA BRANCH — NÃO mergeada:
> aguarda validação do dono + autorização (regra §5 do plano).**
> Autor: Orquestrador (Claude Fable 5) — domínio `parceiro`.

---

## 1. Estado em uma linha

Deploy da Onda A CONFERIDO no site real (~14 min após o push; arquivos novos 200, app.js
byte-idêntico) → Onda B executada inteira na mesma sessão: **passos 4 (foto), 5 (chat) e
6 (config) FEITOS** com goldens 64+72+40 verdes; app.js **3995 → 3071**; M4
`?v=20260611-onda-b`. Próximo: dono valida no preview/celular → autoriza → merge → Onda C.

## 2. Commits da sessão (ordem)

| Commit | O quê |
|---|---|
| `29b2ec6` | **Passo 4** — `app.foto.js` (228; bloco 2361–2574 do 2089903, 18 props) |
| `1af2734` | docs — passo 4 ✅ + **achado F9** (8 renders de chart órfãos de canvas, PRÉ-existente) |
| `f2f8322` | **Passo 5** — `app.chat.js` (255; núcleo) + `app.chat.cliente.js` (246; cliente+carrinho) |
| `9ebb91c` | docs — passo 5 ✅ (desvio do teste de tela registrado) |
| `60a14d5` | **Passo 6** — `app.config.js` (251; isOwner/canSee + funcionários + configurações) |
| `7db7d66` | **M4 da onda** — `?v=20260611-onda-b` nos 10 scripts |
| `5a33adb` | docs — passo 6 ✅ + Onda B completa na branch (aguardando dono) |

## 3. O que existe agora (10 arquivos ≤300 + raiz 3071)

`app.format.js` 150 · `app.labels.js` 168 · `app.charts.resumo.js` 174 ·
`app.charts.financeiro.js` 188 · `app.charts.pdv.js` 158 · `app.foto.js` 228 ·
`app.chat.js` 255 · `app.chat.cliente.js` 246 · `app.config.js` 251 · `app.js` **3071**
(teto temporário no `scripts/obra-painel-teto.json` = 3071, rebaixado a cada passo no
MESMO commit). ESTADO continua TODO na raiz (sai só no passo 10). F2 PRESERVADO
(`chatSending` segue sem declarar — M2 só com aprovação do dono).

## 4. Provas que passaram (cada passo + fechamento)

- Paridade **471/471** · contratos **69/69** · fiscal de tamanho · color-moved (16/30/16
  não-movidas, todas estruturais) · typecheck · vitest **379/379** — em TODOS os passos.
- **Goldens one-off** (untracked, ficam até o passo 10; infra vm reaproveitada do passo 3):
  - `obra-teste-passo4-foto.cjs` **64/64** — countdown/urgência nas fronteiras, SSE global
    + poll 25s só reage a `kind=photo_request`, photoSend POST cru + guarda + 3 erros
    mapeados, compressão EXIF 1600px/0.8, som persiste, thumb Bearer + cache, lightbox,
    lição do `!!` (F6) nos 2 `:disabled`, byte a byte.
  - `obra-teste-passo5-chat.cjs` **72/72** — getters/painéis/tags/labels/mapeadores,
    loadChat preserva fio + marca lida a ativa, SSE fallback 5s (liga só se cair!) +
    poll 30s, sendChat otimista→persistida + rollback + guardas, selectChat, cliente
    (load/form/busca debounce/vincular/criar), carrinho (total/add/remove/orçamento/
    converter POST /vendas idempotente).
  - `obra-teste-passo6-config.cjs` **40/40** — isOwner/canSee (dono×funcionário,
    entrega→entregas, config nunca via canSee), firstAllowedSection, funcionários
    (só dono; criar/reset via prompt/revogar), loadConfiguracoes preenche forms,
    saves PUT + toasts + validações barram form vazio.
  - ⚠️ Goldens ancoram em COMMIT FIXO (2089903/29b2ec6/f2f8322), não em HEAD — HEAD
    anda e o byte a byte quebraria (aconteceu no fechamento; consertado).
- **Tela real (preview 4101, logado na loja de teste):**
  - Foto: card INJETADO client-side (poll pausado→testado→religado), countdown VIVO
    (5:45→4:43), badge 📷1 + título piscando, compressão real no browser (canvas→
    photoPickFile), **ENVIAR nasceu HABILITADO**, retake limpa. SEM clicar enviar
    (dispatcher/expirador reais rodam em prod — não deixar photo_request fake no banco).
  - Chat: SSE+poll ligam ao abrir a aba; conversa injetada client-side; **rollback REAL**
    (envio → 404 do servidor → bolha some + draft volta + flash; nada gravado).
  - Config: aberta como dono, abas trocam, **salvar Atendimento NO-OP por clique real**
    → toast success; banco CONFERIDO (raio 5.00/`both` intactos; só `updated_at` andou).
  - Console: ZERO erro em todos os giros (6 seções × 2 temas no passo 4).

## 5. Aprendizados/decisões NOVOS desta sessão

- **INSERT manual em prod (mesmo loja de teste) = barrado pela trava de auto-mode.**
  Caminho certo descoberto: estado injetado client-side (Alpine) com canal pausado +
  ações pela PRÓPRIA TELA (PUT no-op autorizado pelo plano §3/§6). Mais limpo e sem
  risco de sobra no banco.
- **Goldens devem ancorar em commit FIXO** (o "VEIO DE" do cabeçalho do módulo).
- **Fallback do chat NÃO liga junto com o SSE** — só quando o SSE cai (CLOSED) ou não
  existe. O golden inicial assumiu errado; o código real é mais econômico.
- `loadChatCustomer` LIMPA na entrada e o guard só impede payload de conversa errada.
- `resetFuncionarioSenha` usa `prompt()` do browser (sandbox precisa mockar).
- **F9 (novo, §7 do plano):** 8 dos 11 `render*Chart` procuram canvas que NÃO existem
  no index.html (só PosSpark/RevenuePos/CostsPos existem) — PRÉ-existente desde c0d7913,
  zero efeito; decidir fora da obra ou no passo 11.
- O `requestAnimationFrame` do goToSection não dispara com aba em background (preview) —
  charts pintam ao chamar `renderAllCharts()` direto; não é bug.

## 6. Ambiente / pendências

- **Preview 4101**: de pé, logado na loja de teste, serverId `98b2f92f-…` (muda a cada
  restart — pegar via preview_list). Mexi só em estáticos → reload basta.
- **Preview alheio 4100**: continua de pé (regra de não derrubar), DESATUALIZADO.
- **One-off untracked que ficam:** goldens passos 1/2/3/4/5/6 + `obra-preview-4101.cjs`.
  Extratores apagados após uso (regra). Faxina geral no passo 11.
- **Modificação alheia não-commitada:** `docs/CONTRATO_ESTOQUE_FINANCEIRO_0076_0077.md`
  (doc da migration 0078, de outra frente) — NÃO misturei com a obra; decidir destino
  em sessão própria.
- Senha da zz-teste-copacabana: com o dono (trocada 06-10; reset =
  `scripts/resetar-senha-parceiro.cjs`).

## 7. Como retomar (próxima sessão)

1. **Dono valida a Onda B** (preview 4101 ou aguardar merge): giro foto (card chega →
   bip/banner → anexar → ENVIAR habilitado), chat (abrir conversa real, mandar msg,
   vincular cliente), config (abrir, salvar no-op). É a validação de NEGÓCIO; a técnica
   tá toda verde.
2. **Dono autoriza** → merge da Onda B no main (= deploy automático Coolify ~2-10 min;
   conferir no site real igual fiz com a A: arquivos `?v=20260611-onda-b` respondendo 200).
3. Depois do merge validado: **Onda C (passos 7-10: estoque, PDV, financeiro, raiz)** —
   zona de CONTRATO 0076/0077 (dinheiro/estoque): teste de submit SÓ na loja de teste,
   snapshot de rollback, validação extra (regra 6 do plano). Reler `SECOES/ESTOQUE.md` antes.
4. Na fila fora da obra: porta única de login (`project_porta_unica_login`), faxina
   docs/scripts, F9 (canvas órfãos), M2 (declarar chatSending — pedir aprovação).

---

## 8. FECHAMENTO — MERGE + DEPLOY (mesma sessão, atualização)

Apresentei ao dono um **checkbox visual de status** (onde paramos / feito / falta) +
ofereci o preview pra validar. Conferi o preview 4101 saudável (10 scripts `?v=onda-b`,
logado como dono, console limpo) e fui transparente: a **loja de teste tem 0 conversa e
0 pedido de foto** — foto/chat com dado real só no site de verdade. O dono escolheu
**"confio nas provas, pode subir"**.

- **Merge:** `git stash` do doc do contrato (fora da obra) → `git checkout main` →
  `git merge --no-ff feat/refatoracao-painel-300` = **merge commit `9d0f989`** → `git push
  origin main` (`2089903..9d0f989`) → voltei pra branch + `stash pop` (doc restaurado).
  Espelhei a Onda A: merge commit por onda pra "desfazer a onda = `git revert -m 1 9d0f989`".
- **Pré-checagem:** origin/main era ancestral direto (FF possível, 8 commits à frente, 0
  atrás); doc do contrato idêntico no commit (carrega seguro). Merge entrou cirúrgica: só
  os 4 módulos + app.js (3071) + index.html + teto json. Doc e goldens ficaram de fora.
- **Deploy CONFERIDO no site real** (`farejador.smarttecsolutions.com.br/parceiro/
  zz-teste-copacabana/`): vigia em background pegou a virada em **~1,5 min** (try1 onda-a →
  try2 onda-b). Final: **10 arquivos 200**, `?v=20260611-onda-b`, `app.js` 3071 linhas e
  **sha256 byte-idêntico ao repo** (`9ae355f4…`). Registros atualizados (plano §5/§6 +
  memória + MEMORY.md).
- **Pendência do dono:** validação de NEGÓCIO (foto/chat com dado real no celular, loja com
  movimento). **Próximo da obra:** Onda C (passos 7–10, contrato 0076/0077).
