# PLANO — Refatoração do painel do parceiro (app.js 4.755 → ~16 arquivos ≤300 linhas)

> Data: 2026-06-10 · Autor: Orquestrador (Claude Fable 5) · Domínio: `parceiro`
> Status: **OBRA COMPLETA DE CÓDIGO — aguardando validação do dono no celular + merge da
> Onda C.** Branch `feat/refatoracao-painel-300`. **ONDAS A e B LIVE em prod** (merge
> `9d0f989`, deploy conferido byte-idêntico). **ONDA C (passos 7–11) COMPLETA na branch:**
> 7+8+9+10 feitos (contrato 0076/0077 provado no banco real) + **passo 11 encerramento
> `98c7a5c`** (etiqueta `?v=onda-c` provada ao vivo na 4101, regra do teto 300 no CLAUDE.md,
> teto json apagado, faxina; bateria 508 goldens + 379 vitest + paridade 465 verde; 2
> auditorias de segurança Opus SEM regressão da obra). **FALTA: dono valida no celular →
> autoriza merge → Deploy (botão do dono no Coolify) → eu confiro o ar → gatilho porta
> única (§5).** Progresso na tabela §6.
> Handoffs: `docs/SESSAO_2026-06-10_OBRA_PAINEL_PASSOS_0_A_2_HANDOFF.md` (passos 0–2) +
> `docs/SESSAO_2026-06-11_OBRA_PAINEL_PASSO3_MERGE_ONDA_A_HANDOFF.md` (passo 3 + merge).
> Pré-leitura obrigatória: diagnóstico Etapa 1/2 (sessão 2026-06-10) + CLAUDE.md §3 (convenções).

---

## 0. Regras inegociáveis (contrato da obra)

1. **Zero mudança de comportamento.** Refatoração = mover, nunca reescrever.
2. **Nenhum nome de método/getter/estado muda.** O `index.html` chama esses nomes
   (`@click`, `x-model`, `x-show`) — são a API pública do arquivo.
3. **Nenhum contrato de rede muda.** Mesmos endpoints, mesmos métodos HTTP, mesmos
   payloads, mesmos headers. SSE do chat/foto e upload de foto são CRÍTICOS.
4. **Sem dependência nova, sem empacotador.** Continua `<script>` cru + Alpine por CDN.
5. **Fatia pequena, commit isolado, prova após cada fatia.** Nunca duas fatias num commit.
6. **Dinheiro/estoque é contrato** (migrations 0076/0077): os passos que tocam
   PDV/estoque/financeiro têm validação extra e teste de submit SÓ na unidade de teste.
7. Dúvida em parte crítica → **não mexe, sinaliza** no relatório do passo.
8. Melhorias só entram se provadamente não mudarem comportamento, cada uma em
   commit próprio rotulado `chore(painel): melhoria Mx`, separado dos `refactor()`.

## 1. Escopo

- **ENTRA:** `parceiro/public/app.js` (4.755 linhas no c0d7913) → ~16 módulos ≤300 linhas;
  bloco de `<script>` novo no `index.html` (única mudança no HTML); regra do teto
  de 300 escrita no CLAUDE.md; fiscal automático de tamanho.
- **NÃO ENTRA:** `index.html` (2.405 linhas — fatiar HTML com Alpine é outra técnica,
  outra obra); `style.css`; backend (`src/parceiro/*`); painel da matriz
  (`painel/public/*`); qualquer arquivo do bot. Backend gordo segue a regra do bom
  escoteiro (emagrece quando for tocado por outro motivo).

## 2. A técnica (por que não quebra)

O Alpine monta a tela a partir de UM objeto (`x-data="parceiroApp()"`). A obra mantém
**um objeto só** — o que muda é onde cada pedaço dele MORA.

- Cada módulo vira uma fábrica registrada num namespace global:
  ```js
  // app.format.js
  window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
  window.PARCEIRO_MODULES.format = () => ({
    num(v) { ... }, money(v) { ... }, get nowClockLabel() { ... },
  });
  ```
- O `app.js` (raiz) monta o objeto final **preservando getters**:
  ```js
  function montarParceiroApp(estado, fabricas) {
    const out = estado;
    for (const f of fabricas) {
      Object.defineProperties(out, Object.getOwnPropertyDescriptors(f()));
    }
    return out;
  }
  ```
  ⚠️ NUNCA usar spread (`{...modulo()}`): spread EXECUTA getters e congela o valor —
  a tela para de reagir. `getOwnPropertyDescriptors` mantém o getter vivo. Este é o
  risco técnico nº 1 da obra inteira.
- `this` continua único e compartilhado — nenhum módulo ganha estado próprio.
- Ordem de carga no `index.html`: módulos primeiro, `app.js` (raiz) por último.
- Ordem de merge na montagem = ordem do array `fabricas` = **documentada e fixa**
  (importa por causa de sombreamentos — ver F1).

## 3. Ferramentas de prova (construídas no Passo 0, usadas em TODOS os passos)

| Ferramenta | O que prova | Como |
|---|---|---|
| `scripts/prova-paridade-painel.cjs` | **Mesma interface**: nenhum método/getter/estado sumiu ou mudou de tipo | Mocka `location`/`localStorage`/`window`/`document`, carrega os arquivos na ordem do index.html, chama `parceiroApp()`, extrai `getOwnPropertyDescriptors` e gera manifesto `{nome: getter\|function\|value:tipo}`. Compara com o baseline gerado ANTES da obra (commitado em `scripts/baseline-paridade-painel.json`). Diferença = passo REPROVADO. |
| `scripts/prova-endpoints-painel.cjs` | **Mesmos contratos de rede** | Greps estruturados de `this.api(`, `fetch(`, `EventSource(` em todos os módulos → lista ordenada de método+path. Compara com baseline. Diferença = REPROVADO. |
| `scripts/checar-tamanho.cjs` (fiscal) | **Teto de 300** | Falha se qualquer `parceiro/public/app*.js` passar de 300 linhas. Vira `npm run checar-tamanho` e regra permanente do projeto. |
| `git diff --color-moved=zebra` | **"Só movido, nada editado"** | No diff de cada passo, blocos movidos aparecem apagados; QUALQUER linha alterada dentro de função movida grita colorida → investigar ou reverter. |
| Preview 4101 → prod | **Olho na tela real** | `preview-parceiro-server` na porta 4101 (mesma máquina que cravou o bug da foto). Roteiro de cliques da tela afetada + giro geral. Console = zero erro novo. |
| Unidade de TESTE | **Submits de contrato** | Vendas/contas/estoque de teste só na zz-teste-copacabana (ou fake-rede), NUNCA na loja real. Criar → conferir efeito → cancelar/limpar. |

## 4. CHECKLIST PADRÃO — repetir ao final de CADA passo

```
☐ 1. npm run checar-tamanho            → nenhum arquivo >300
☐ 2. prova-paridade-painel             → manifesto IDÊNTICO ao baseline
☐ 3. prova-endpoints-painel            → lista de contratos IDÊNTICA
☐ 4. git diff --color-moved=zebra      → tudo "movido", nada "editado"
☐ 5. Preview 4101: roteiro da tela do passo + giro geral (login → resumo →
     vendas → estoque → financeiro → chat → foto) + console SEM erro novo
☐ 6. Teste específico do passo (tabela §6) PASSOU
☐ 7. Commit isolado: refactor(painel): extrai <módulo> (passo N/11)
☐ 8. Achou algo estranho? → REGISTRAR em §7 (falhas) — não consertar no mesmo commit
```

Passo só está PRONTO com os 8 itens marcados. Reprovou em 2/3/4 → reverter e refazer.

## 5. Ondas de deploy (o main só recebe onda validada)

Obra na branch `feat/refatoracao-painel-300`. Merge no main (= deploy automático
Coolify) em **3 ondas**, cada uma validada ao vivo pelo dono antes da próxima:

- **Onda A (baixo risco):** Passos 0–3 (fundação, format, labels, charts). ✅ **MERGEADA
  no main em 2026-06-11** (M4 `?v=20260611-onda-a`; autorizada pelo dono após validar a
  interface; giro fino no celular dele = pós-deploy). Deploy CONFERIDO no site real
  (arquivos novos 200, app.js byte-idêntico).
- **Onda B (médio):** Passos 4–6 (foto, chat, config). ✅ **MERGEADA no main e LIVE em
  prod (2026-06-11)** — merge `9d0f989` (autorizada pelo dono: "confio nas provas, pode
  subir"); deploy CONFERIDO no site real (10 arquivos 200, `app.js` byte-idêntico sha
  `9ae355f4…`, `?v=20260611-onda-b`); goldens 64+72+40 + 471 props + 69 contratos + 379
  vitest verdes; app.js 3995→3071. Rollback = `git revert -m 1 9d0f989` (Coolify redeploya).
- **Onda C (contrato):** Passos 7–11. **7+8+9 FEITOS** com contrato 0076/0077 provado no
  banco real; **10 FEITO (`098b4f0`)** — espinha (login/logout/firstAccess/401/funcionário
  parcial) AO VIVO na zz-teste-meier (credencial wallace/123456 informada pelo dono);
  **11 FEITO (`98c7a5c`, 2026-06-11)** — etiqueta `?v=onda-c` (provada ao vivo: 24 scripts
  200, painel boota, console limpo), regra do teto 300 no CLAUDE.md §3, `obra-painel-teto.json`
  apagado (vale o teto universal; app.js=263), faxina dos 10 goldens (arquivados em
  `_backup-goldens-painel-onda-c-2026-06-11.tgz`); bateria 508+379+paridade 465+typecheck 0
  verde; 2 auditorias de segurança (Opus) sem regressão. **ONDA C COMPLETA na branch —
  aguardando dono validar no celular + autorizar o merge.**

Rollback: passo = `git revert` do commit; onda = revert do merge; Coolify redeploya
sozinho (~2-3 min). A cada onda, trocar a etiqueta `?v=` do script tag (M4).

**🔔 GATILHO PÓS-OBRA (travado com o dono em 2026-06-12):** assim que a Onda C for
mergeada e validada, a **tarefa #1 seguinte é a PORTA ÚNICA DE LOGIN** (uma URL só de
login — dono exemplificou `/login`; multi-loja escolhe a unidade; URLs por slug NÃO
morrem; rate-limit global + revisão `seguranca`; ~meio dia). O passo 10 prepara o
terreno (login isolado em `app.auth.js`), mas NÃO muda comportamento — a porta única é
feature à parte. Desenho completo: memória `project_porta_unica_login` + handoff 06-12 §8.

## 6. OS PASSOS (ordem do mais seguro pro mais sensível)

> Linhas citadas = app.js de hoje (commit c0d7913). "Teste específico" = item 6 do checklist.

| # | Passo | O que extrai (de onde) | Arquivo(s) novo(s) | Risco | Teste específico |
|---|---|---|---|---|---|
| 0 | **Fundação ✅ FEITO** (`fd1b2a5`) | — | branch + 3 scripts de prova + baselines + `npm run checar-tamanho` + launch preview 4101 | 🟢 | ✅ Baselines: **471 propriedades** (não ~346) e **69 contratos**; verde no intacto; sabotagem A/B reprovou cada prova SÓ no seu domínio |
| 1 | **Formato ✅ FEITO** (`444ffbe`) | Máscaras/moeda/telefone/medida/datas/deep-links (4306–4443) + helpers puros `num/uuid/dateKeySaoPaulo/isSaving` (4410–4433) | `app.format.js` (150 linhas) | 🟢 | ✅ 138 linhas byte a byte = HEAD; golden 27/27; browser ok. Nasceu junto o `montarParceiroApp` + rota genérica de módulos no backend (F8) |
| 2 | **Rótulos/avisos ✅ FEITO** (`654e9a4`) | `categoryLabel`→`sourceClass`, `stockStatus*`, `flash/inferStatusKind/errMessage` (4445–4753) | `app.labels.js` (168 linhas) | 🟢 | ✅ 153 linhas byte a byte (4 sub-blocos); golden 31/31; toast e chips ao vivo no browser. RECORTE FINO: `stockAvailable`/`stockItemValue`/ações de saldo NÃO são rótulo → ficaram pro passo 7; `customer*`/`purchaseItemsLabel` → passos 8/9 |
| 3 | **Gráficos ✅ FEITO** (`06634e0`) | `renderAllCharts` + 11 render* (3834–4319 no 8445d42), VERBATIM por linha (27 âncoras) | `app.charts.resumo.js` (174) + `app.charts.financeiro.js` (188) + `app.charts.pdv.js` (158) | 🟢 | ✅ Golden 16/16: 11 gráficos pintam nos 2 temas, trocar tema repinta (11 destroys + cores do tema novo), byte a byte vs HEAD; preview 4101 ok (módulos 200, negativos 404, console limpo). **DESVIO registrado: 3 arquivos, não 2** — o lado financeiro+PDV real tem 316 linhas (>300); recorte por TELA (Resumo/Estoque, Financeiro, PDV) mantém coesão e folga. Adendo F8 consertado no mesmo commit |
| 4 | **Foto ✅ FEITO** (`29b2ec6`) | Bloco FOTO inteiro (2361–2574 no 2089903), VERBATIM | `app.foto.js` (228) | 🟠 SSE + upload | ✅ Golden 64/64 (countdown/urgência nas fronteiras, SSE global+poll 25s só reage a kind=photo_request, photoSend POST cru+guarda+3 erros mapeados, compressão EXIF 1600px/0.8, som persiste, thumb Bearer+cache, lightbox, byte a byte vs HEAD); tela real no 4101: card com countdown VIVO (5:45→4:43), badge 📷1+banner, **ENVIAR nasceu HABILITADO** (lição do `!!`), preview+retake limpam, giro 6 seções + 2 temas, console zero erro. Card de tela INJETADO client-side (INSERT em prod barrado pela trava — sem dado de teste no banco). Achado novo → F9 |
| 5 | **Chat ✅ FEITO** (`f2f8322`) | Bate-papo F7: núcleo (1953–1988 + 2222–2426 no 29b2ec6) e cliente Fase 2a + carrinho Fase 2b (1989–2221), VERBATIM | `app.chat.js` (255) + `app.chat.cliente.js` (246) | 🟠 SSE/Chatwoot | ✅ Golden 72/72 (getters/painéis/tags/labels/mapeadores, loadChat preserva fio + marca lida a ativa, SSE fallback 5s liga-desliga-religa + poll 30s, sendChat bolha otimista→persistida + ROLLBACK + guardas, selectChat, cliente load/form/busca debounce/vincular/criar, carrinho total/add/remove/orçamento/converter POST /vendas idempotente, byte a byte vs HEAD, F2 preservado). Tela real 4101: SSE+poll ligam ao abrir a aba, **rollback REAL** (envio em conversa fake → 404 → bolha some + draft volta + flash), filtros/getters vivos, console zero erro. DESVIO do teste: loja de teste tem 0 conversas e msg real dispara Chatwoot → "msg na conversa de teste + vincular cliente NA TELA" coberto no golden mecânico + rollback real; ponta-a-ponta com conversa REAL fica pro giro do dono pós-onda (item já validado ao vivo na frente F7/chat) |
| 6 | **Config ✅ FEITO** (`60a14d5`) | isOwner/canSee + funcionários Etapa 4c + Configurações (472–708 no f2f8322; o range do plano era 470–693 no arquivo antigo — cresceu com o raio da Fase 2/3), VERBATIM | `app.config.js` (251) | 🟡 | ✅ Golden 40/40 (isOwner/canSee dono×funcionário + mapa entrega→entregas + config nunca via canSee, firstAllowedSection, funcionários: load só dono/criar com validação/reset senha via prompt/revogar, loadConfiguracoes preenche forms + permissões efetivas, saves PUT certos + toasts + validações barram form vazio, byte a byte). Tela real: Config aberta como dono, abas trocam, **salvar Atendimento NO-OP por clique real** → toast success + banco conferido (raio 5.00/both intactos, só updated_at andou), console zero erro |
| 7 | **Estoque ✅ FEITO** (`3111ad5`) | KPIs/filtros/series + stockBreakdown + stockAvailable/stockItemValue 0076 (599–733, 750–836, 1325–1331, 2908–2919 no dcd8fa9) num; FORMS: STOCK + selectStock/modais/entrada/ajuste (2274–2418, 2921–3015) noutro. **RECORTE FINO:** helpers compartilhados c/ financeiro (`isPhysicalExitSale`, `saleRealizedAt`, `isCurrentMonth` ×2 = F1, `salesUnitsFor`) FICARAM na raiz — destino no passo 9 | `app.estoque.kpis.js` (258) + `app.estoque.forms.js` (255) | 🟠 contrato 0076 | ✅ Golden 59/59 (KPIs casos de borda 0076: disponível=físico−reservado/Infinity/null; saveStock validações+payload por tipo; **CONTRATO: _persistStockQuantity manda as 18 colunas** — parcial apagaria; byte a byte vs dcd8fa9; F1 intacta). Tela real na loja de TESTE: **criar → entrada +1 (preservou marca/posição/fornecedor/preço) → ajuste absoluto → inativar; snapshot final IDÊNTICO ao inicial** (zero sobra no banco); KPIs reais (20→23→24→22→20); giro 6 seções; console zero erro |
| 8 | **PDV/Vendas ✅ FEITO** (`d1236bc`) | Getters pos* + caixa do dia + rótulos de produto (1315–1444, 1528–1549 no d04768b) → kpis; carrinho/checkout/finalizar/saveSale/cancelSale (1518–1526, 1563–1642, 1854–2042) → pdv; cliente na venda + CRUD + VIP (1644–1852, 2532–2568) → clientes. **DESVIOS registrados:** (a) 3 arquivos, não 2 — o bloco de vender tinha 441 linhas (>300); recorte por função (leitura/fluxo/cliente); (b) `itemTypeLabel`/`itemPrimaryLabel` foram pro **labels** (rótulo compartilhado: estoque usa 6×, PDV 2×; labels 168→180). `salesTodayCount` (Resumo) e rótulos de COMPRA ficaram na raiz (passo 9) | `app.pdv.kpis.js` (167) + `app.pdv.js` (294) + `app.pdv.clientes.js` (261) | 🔴 dinheiro+estoque | ✅ Golden 56/56 (0076: carrinho barra além do disponível físico−reservado; 0077: caixa do dia sem dupla contagem, customerSales SÓ venda realizada — delivery aberto/cancelada FORA; **idempotency_key ESTÁVEL na re-tentativa** (não duplica venda) e zerada no sucesso; installments SEMPRE 1; validações barram antes do POST; byte a byte vs d04768b). Tela real na loja de TESTE: **venda Pix R$ 99 via F2 REAL → estoque 10→9 + caixa 0→99 → cancelSale → estoque 10 + caixa 0 + snapshot idêntico**; Esc limpa carrinho (tecla real); giro 8 seções; console zero erro |
| 9 | **Financeiro ✅ FEITO** (`29e9817`; M3 antes em `ea22ea3`) | KPIs (totalCusts/margem/séries/totais+details de contas, 583–742 no ea22ea3) + score (1092–1255) + compras/despesa (1376–1549) + conta a PAGAR (1551–1603, 1660–1684, 1752–1805) + conta a RECEBER (1605–1658, 1686–1750, 1807–1862). **DESVIOS:** (a) **5 arquivos, não 2** — CRUD tinha 487 linhas e getters+score 330 (>300); recorte por assunto; (b) helpers 0076/0077 (`isPhysicalExitSale`/`saleRealizedAt`/`salesUnitsFor`) moram no **financeiro.kpis** (a regra de venda realizada é do contrato financeiro); raiz mantém `salesTodayCount`/`completedSales`/`salesSeries7d` (Resumo, passo 10). **M3 FEITA** (`ea22ea3`): cópia sombreada de `isCurrentMonth` apagada (F1 RESOLVIDA; a vigente única fica na raiz) | `app.financeiro.kpis.js` (191) + `.score.js` (177) + `.compras.js` (188) + `.contas.js` (148) + `.receber.js` (190) | 🔴 dinheiro | ✅ Golden 64/64 (totalCusts = CMV+despesas, COMPRAS FORA — 0077/0078; totais só de aberta; pagos/recebidos SÓ do mês; score cenários bom/ruim+clamp+ângulo+cor por tema; validações barram antes do POST; PATCH na edição; **dedupe 409 duplicate_expense nos 2 desfechos** (recusa/força); byte a byte vs ea22ea3). Tela real na loja de TESTE: conta a pagar **criar→PAGAR (servidor GEROU a despesa via dedupe)→limpa**; conta a receber A criar→cancelar; conta B **criar→RECEBER → caixa do dia 0→120 (0077!)→limpa** (recebida/paga não se cancela pelo sistema — regra correta do servidor `status='open'`; limpeza via soft-delete cirúrgico com dry-run); **score 815/Ótimo/326,7° IDÊNTICO antes/depois**; zero resíduo; console zero erro |
| 10 | **Raiz fina ✅ FEITO** (`098b4f0`) | AUTH (340–449 no 29e9817) → auth; INIT+relógio+API/loadData+navegação (237–338, 451–547, 979–1038) → core; derivadas do Resumo (549–621, 932–961) → resumo; aba Pedidos+status de entrega (715–878) → pedidos; tela Entrega+Retiradas (623–713, 880–930) → entregas; `isCurrentMonth` (963–977) → **format** (família do dateKeySaoPaulo; vigente ÚNICA pós-M3). **DESVIOS:** (a) **5 arquivos, não 2** — pedidos/entregas/resumo nunca tiveram passo próprio no desenho e sobraram na raiz (a raiz tinha 1061, não ~530); (b) raiz final = ESTADO + montagem = **263** (abaixo dos ~250+ previstos) | `app.auth.js` (123) + `app.core.js` (275) + `app.resumo.js` (118) + `app.pedidos.js` (178) + `app.entregas.js` (156); raiz `app.js` **263** | 🟠 espinha | ✅ Golden 78/78 (byte a byte vs 29e9817; login 401/429/500/sucesso + senha limpa; firstAccess valida/username_taken/sucesso; logout limpa tudo sem Content-Type; api() Error com status/payload; loadData /me primeiro + feeds por canSee + redirect de seção proibida; init 401 volta pro login; goToSection barra config/canSee; submitOrder receivable+2w+idempotency; setDeliveryStatus payment_method SÓ no delivered; cancelar 2W exige motivo). **Bateria COMPLETA 1–10 verde (508 asserções)** — achado: goldens 1/2/5/7/8 estavam FURADOS desde M2/M3/p9 (loader hardcoded + asserções de época), consertados. AO VIVO na zz-teste-meier: login errado→mensagem, certo→painel (senha some da memória), logout→token fora+dados zerados, **401 real com token velho→login limpo**, firstAccess com código cru→entrou, **funcionário parcial: menu SÓ vendas+estoque, financeiro/config barrados, redirect automático**; limpeza zero resíduo (token/funcionário revogados); console zero erro |
| 11 | **Encerramento ✅ FEITO DE CÓDIGO** (`98c7a5c`) | — | M4 etiqueta `?v=20260611-onda-c` nos 24 scripts (provada AO VIVO na 4101: 24 scripts 200, 0 etiqueta velha, painel boota, console só com o nag pré-existente do Tailwind CDN, zero req falha); regra do teto 300 no CLAUDE.md §3; `obra-painel-teto.json` APAGADO (vale o teto universal 300; app.js=263 folgado); faxina dos 10 goldens one-off (arquivados em `_backup-goldens-painel-onda-c-2026-06-11.tgz`, lançador 4101 mantido). **Bateria COMPLETA verde uma última vez: paridade 465 + contratos 69 + 24 arquivos ≤300 + 10 goldens (508 asser.) + 379 vitest + typecheck 0.** 2 revisores de segurança (Opus, paralelos) = **SEM regressão da obra**; achados pré-existentes (PARTNER_DATABASE_URL fail-open, headers/CSP+SRI, token em localStorage, SEC-002) no handoff. **FALTA: dono valida no celular → autoriza merge → Coolify Deploy (botão do dono) → eu confiro o ar. Ao fechar: GATILHO porta única (§5).** | 🟢 | Dono roda o dia a dia real (venda, estoque, chat, foto) + dá o OK final + autoriza o merge |

## 7. FALHAS PRÉ-EXISTENTES ACHADAS NA LEITURA (sinalizadas — tratamento definido)

| # | Falha | Onde | Tratamento na obra |
|---|---|---|---|
| F1 | **`isCurrentMonth` definido DUAS vezes** — a 2ª (linha 1754) sombreia a 1ª (1071); só a 2ª vale hoje. Comportamento é igual (ambas comparam ano+mês em São Paulo), mas se a separação puser cada uma num arquivo, "quem vence" passa a depender da ordem de carga = bomba. | 1071 / 1754 | No passo 9 (financeiro): manter SÓ a versão vigente (1754), apagar a sombreada (código morto). Não é mudança de lógica — a 1ª nunca executou. Registrar no commit. |
| F2 | **`chatSending` e `orderCustomerTimer` usados sem declarar no estado** — funcionam porque atribuição cria a propriedade em runtime. | sendChat (2597) / onOrderCustomerSearch (1388) | Preservar como está nos passos 5/8 (regra 7). Declarar é a melhoria M2 — só com aprovação. |
| F3 | **`console.log('[venda] enviando:', body)`** — log de diagnóstico vazando dados da venda no console de produção. | saveSale (3143) | Melhoria M1 (remoção segura) — commit próprio. |
| F4 | **Etiqueta de cache `?v=20260606-gps` parada desde 06/06** — inofensiva hoje (servidor manda no-store), mas vira armadilha se o no-store cair um dia. | index.html:2402 | Melhoria M4: versionar a cada onda. |
| F5 | **Gráficos guardados em globais `window._xxxChart`** — funciona, mas é estado solto fora do Alpine. | 3835+ | NÃO mexer (regra 7). Anotado pra obra futura. |
| F6 | Lição permanente: **`:disabled` do Alpine com valor `undefined` trava botão** — origem do bug da foto. | — | Checklist do passo 4 verifica o `!!` preservado; regra já vai pro CLAUDE.md no passo 11. |
| F7 | **Warns de Alpine em TODA carga da página** (pré-existentes, achados no passo 1): `stockOpItem.quantity_on_hand` (mini-modal de entrada avalia x-text com item null) e `chatActive.avatar=null` (img @error com chat fechado). Não quebram nada visível; poluem o console. | index.html (expressões dos modais) | ✅ **RESOLVIDO** (fix `2a9406b`, autorizado pelo dono 06-10): a linha 1192 era a ÚNICA expressão de stockOpItem SEM o guard que as vizinhas já usavam; @error do avatar ganhou `chatActive &&` (×3). Carga nova = zero warn de Alpine (provado no preview). |
| F8 | **Backend servia estático por rota EXPLÍCITA por arquivo** — módulo novo daria 404 em prod. Desvio do §1 EXECUTADO no passo 1: rota genérica `/parceiro/:slug/:script` com whitelist `app.<nome>.js` (basename + regex, fora do padrão = 404), no padrão da rota de assets. | route.ts:483 | Resolvido no commit do passo 1 (444ffbe). **ADENDO (passo 3, `06634e0`):** o regex original `^app\.[\w-]+\.js$` só aceitava UM segmento — os nomes compostos que o PRÓPRIO plano usa (`app.charts.resumo.js`, `app.estoque.forms.js`…) dariam 404 em prod, e o MESMO regex (com `?`) deixava os fiscais `checar-tamanho`/`prova-endpoints` CEGOS pros arquivos novos. Corrigido: rota `^app(\.[\w-]+)+\.js$` (1+ segmentos; `app..js` continua 404) e `(\.[\w-]+)*` nos fiscais. Provado no preview (módulos 200, negativos 404) — vale pros módulos restantes. |
| F9 | **8 dos 11 `render*Chart` procuram canvas que NÃO existem no index.html** (só `chartPosSpark`, `chartFinanceRevenuePos` e `chartFinanceCostsPos` existem). PRÉ-EXISTENTE desde antes da obra (c0d7913); achado no giro do passo 4. | index.html / app.charts.*.js | ✅ **RESOLVIDO (`dcd8fa9`, decisão do dono 06-11: APAGAR)** — 366 linhas removidas: `app.charts.financeiro.js` deletado inteiro (todo órfão), `resumo.js` virou só o maestro (19 linhas) chamando os 3 vivos, baseline 473→465, golden do passo 3 regravado pós-F9 (16/16, com trava anti-regressão: mortos não voltam). Recuperável: o commit anterior (`2aee88a`) tem tudo. |

## 8. MELHORIAS SEM MUDAR LÓGICA (cada uma = commit próprio, aprovadas pelo dono)

- **M1 ✅ FEITA** (`7f6e7ee`, autorizada pelo dono 06-10, antecipada da onda C) — `console.log` da venda removido (F3); provas verdes pós-remoção.
- **M2 ✅ FEITA** (`2aee88a`, aprovada pelo dono 06-11) — `chatSending: false` e
  `orderCustomerTimer: null` declarados no estado (F2); baseline 471→473; provas verdes
  e conferido na tela (caixinhas existem desde o boot, console limpo).
- **M3 ✅ FEITA** (`ea22ea3`, no passo 9 como planejado) — cópia SOMBREADA de
  `isCurrentMonth` apagada (nunca executou: a 2ª definição no objeto literal sempre
  venceu); a vigente única segue na raiz. F1 RESOLVIDA; paridade 465 idêntica.
- **M4** Etiqueta `?v=` nova a cada onda (F4).
- **M5** Cabeçalho-padrão de 5 linhas em cada arquivo novo (o que mora ali, de onde
  veio, regra do teto). Documentação, não código.

## 9. Critério de PRONTO da obra inteira

1. `app.js` original (4.755) virou ~16 arquivos, todos ≤300 linhas.
2. Manifesto de paridade final idêntico ao baseline (exceto F1 documentada).
3. Lista de endpoints idêntica ao baseline.
4. Diff acumulado do `index.html` = só o bloco de `<script>` + `?v=`.
5. Roteiro visual completo verde nos 2 temas, desktop e celular.
6. Dono validou o dia a dia real no celular dele após a onda C.
7. CLAUDE.md atualizado com a regra do teto 300 + fiscal no fluxo de trabalho.

## 10. Estimativa e pendências

- **Esforço:** Onda A ~1 dia · Onda B ~1-1,5 dia · Onda C ~1,5-2 dias → **3,5–5 dias úteis**.
- **Pendência de ambiente ✅ RESOLVIDA (06-10):** senha da zz-teste-copacabana
  trocada (login `wallace`, owner) e provada ao vivo (login 200 via preview→prod).
  Valor está com o dono; perdeu = rodar `scripts/resetar-senha-parceiro.cjs` de novo.
- **Fora desta obra (anotado, não esquecido):** faxina de docs/scripts velhos
  (branch `chore/limpeza-projeto-2026-06-06` parada aguardando decisão de merge do
  dono + nova varredura); fatiamento do `index.html`; backend gordo via bom escoteiro.
