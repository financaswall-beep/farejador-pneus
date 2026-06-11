# PLANO — Refatoração do painel do parceiro (app.js 4.755 → ~16 arquivos ≤300 linhas)

> Data: 2026-06-10 · Autor: Orquestrador (Claude Fable 5) · Domínio: `parceiro`
> Status: **EM EXECUÇÃO** na branch `feat/refatoracao-painel-300` — **ONDA A (passos 0–3
> + F7/M1/M4) COMPLETA, AUTORIZADA pelo dono e MERGEADA no main em 2026-06-11** (push =
> deploy automático Coolify). Validação final do dono no celular = pós-deploy, no site
> real. Próximo: **Onda B (passos 4–6)**. Progresso na tabela §6.
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
  interface; giro fino no celular dele = pós-deploy).
- **Onda B (médio):** Passos 4–6 (foto, chat, config).
- **Onda C (contrato):** Passos 7–10 (estoque, PDV, financeiro, raiz fina).

Rollback: passo = `git revert` do commit; onda = revert do merge; Coolify redeploya
sozinho (~2-3 min). A cada onda, trocar a etiqueta `?v=` do script tag (M4).

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
| 6 | **Config** | Configurações da loja + funcionários (470–693) | `app.config.js` (~300) | 🟡 | Abrir Config (dono), salvar SEM mudar nada (no-op) → toast ok; permissões pintam |
| 7 | **Estoque** | Forms estoque/catálogo (3186–3330) + entrada/ajuste (4598–4675) num arquivo; getters/KPIs de estoque (820–1057, 1546–1573) noutro | `app.estoque.forms.js` (~270) + `app.estoque.kpis.js` (~250) | 🟠 contrato 0076 | Na loja de TESTE: criar item, dar entrada +1, ajustar saldo, inativar; KPIs e disponível (físico−reservado) conferem antes/depois |
| 8 | **PDV/Vendas** | Carrinho/checkout/finalizar/cancelar (2659–3184) + getters pos* (1770–1906) num; busca/cadastro cliente PDV noutro | `app.pdv.js` (~300) + `app.pdv.clientes.js` (~200) | 🔴 dinheiro+estoque | Na loja de TESTE: venda Pix 1 item → estoque baixa, caixa do dia soma → CANCELAR a venda → estoque/caixa voltam. F2 e Esc funcionam |
| 9 | **Financeiro** | Compra/despesa/contas a pagar/receber CRUD (3332–3818) num; getters financeiros + score (1059–1235, 1575–1768) noutro | `app.financeiro.contas.js` (~300) + `app.financeiro.kpis.js` (~300) | 🔴 dinheiro | Na loja de TESTE: conta a pagar criar→pagar→cancelar; conta a receber criar→receber→cancelar; score e gauge idênticos antes/depois (print comparativo) |
| 10 | **Raiz fina** | O que sobra: ESTADO (16–218) + montagem; auth (323–432) sai pra arquivo próprio; init/api/loadData/navegação (220–301, 434–468, 695–768, 2628–2657) | `app.js` (~250, raiz) + `app.auth.js` (~180) + `app.core.js` (~280) | 🟠 espinha | Login+logout+primeiro acesso na unidade de teste; sessão 401 volta pro login; funcionário com permissão parcial vê só as telas dele |
| 11 | **Encerramento** | — | CLAUDE.md ganha a regra do teto 300 + fiscal no fluxo; `?v=` final; varredura: checklist COMPLETO uma última vez + dono valida no celular | 🟢 | Dono roda o dia a dia real (venda, estoque, chat, foto) e dá o OK final |

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
| F9 | **8 dos 11 `render*Chart` procuram canvas que NÃO existem no index.html** (só `chartPosSpark`, `chartFinanceRevenuePos` e `chartFinanceCostsPos` existem; `chartSalesTrend`, `chartResult`, `chartStock`, `chartStockMovement`, `chartFinanceBar/Split/Origin/Units` são órfãos — o render sai cedo no `if (!ctx) return`). PRÉ-EXISTENTE: mesmos 3 canvas no c0d7913 (antes da obra). Achado no giro do passo 4. Os 3 com canvas pintam e repintam nos 2 temas (provado na tela). | index.html / app.charts.*.js | NÃO mexer (regra 7) — código dormente, zero efeito. Decidir fora da obra (ou no passo 11): apagar os renders órfãos OU recolocar os canvas na tela do Resumo. |

## 8. MELHORIAS SEM MUDAR LÓGICA (cada uma = commit próprio, aprovadas pelo dono)

- **M1 ✅ FEITA** (`7f6e7ee`, autorizada pelo dono 06-10, antecipada da onda C) — `console.log` da venda removido (F3); provas verdes pós-remoção.
- **M2** Declarar `chatSending: false` e `orderCustomerTimer: null` no estado (F2).
  Inicialização explícita, sem efeito visível. Recomendo na onda B.
- **M3** Resolver a duplicata `isCurrentMonth` mantendo a vigente (F1). Obrigatória
  pra separação ser segura — entra no passo 9.
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
