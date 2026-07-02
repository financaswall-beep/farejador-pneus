# SESSÃO 2026-07-02c — COMISSÃO vira LANÇAMENTO (0118) + editor do modelo comercial

> Terceira perna da sessão de 07-02 (ver `..._2026-07-02_FRETE_PINO_FIADO_...` e
> `..._2026-07-02b_FATIA2_...`). O dono deu o "vai" na obra 4 e BATEU AS 4 REGRAS
> (todas as recomendadas). Obra PRONTA LOCAL, **NÃO pushada** — aguarda ordem.
> Migration 0118 JÁ APLICADA. Antes desta obra: fatia 2 PUSHADA (`91a3694`, ordem do dono).

---

## 1. As 4 regras batidas com o dono (2026-07-02 — via perguntas fechadas)

1. **Quando nasce:** quando a venda REALIZA — mesma régua 0077/0090 do faturamento do
   parceiro (entrega só quando ENTREGOU; retirada só quando o cliente LEVOU; balcão no
   fechamento; cancelada nunca).
2. **Cancelamento:** o lançamento MORRE JUNTO, sozinho (estorno automático com trilha; se
   já estava PAGO → `reversed` com `settled_at` preservado = "acerto por fora", espelho do
   aviso do cancelamento do atacado).
3. **Percentual:** da FICHA do parceiro (`network.partners.commission_percent`), CONGELADO
   no lançamento — mudar a ficha depois NÃO mexe no passado (mesmo desenho do custo do
   galpão). Inclui o EDITOR do modelo comercial (pendência de 06-01 — quitada).
4. **Mensalidade:** FORA desta fatia (vira lançamento na próxima, mesmo desenho).
5. **FRETE FORA da base** (batida na sequência, 07-02): o total do pedido do parceiro
   INCLUI o frete (conferido em `register_partner_local_order`: pneus − desconto + frete);
   o card antigo "Comissão 2W" calculava sobre esse total. Decisão: comissão SÓ sobre os
   pneus → base = `total_amount − freight_amount` (clamp 0); `order_total` do lançamento
   guarda a BASE (a conta "X% de R$ Y" da tela fecha).

Base da comissão continua = **SÓ venda 2W** (`partner_orders.source_tag='2w'` — o que a
matriz trouxe; venda de porta não paga), decisão de 06-01 honrada.

## 2. O que entrou (flag `NETWORK_COMMISSION_LEDGER`, default OFF)

- **Migration `0118_network_commission_ledger.sql` — APLICADA** (via `scripts/aplicar-0118.cjs`,
  untracked): `network.commission_entries` (1 linha por venda 2W realizada; UNIQUE
  env+partner_order_id = idempotência; status open|settled|reversed + trilha completa).
  **ZERO grant pro `farejador_partner_app`** (conferido no próprio aplicador — o app do
  parceiro tem SELECT em partners/partner_units, mas NÃO no livro).
- **VARREDURA read-triggered** (`sweepCommissionEntries` em queries.ts): o GET da tela
  varre e (1) CRIA lançamento pra venda 2W realizada sem lançamento (INSERT..SELECT com
  ON CONFLICT DO NOTHING), (2) ESTORNA lançamento vivo cuja venda foi cancelada/apagada.
  **Sem gancho nenhum no fluxo do parceiro/bot** — auto-corrige o que ficou pra trás;
  régua de "realizada" duplicada de `getPainelRede` (comentário cruzado: mudou lá, mude cá).
- **Livro** (`getCommissionLedger`): total em aberto + agregado por parceiro (de quem
  cobrar) + últimos 25 lançamentos (vivos/recebidos/estornados — trilha visível).
- **Quitação** (`settleCommissionEntries`): "Recebi" quita TODOS os abertos do parceiro
  (open→settled + settled_by); nada aberto → `nothing_open`.
- **Editor do modelo comercial** (`updatePartnerCommercialTerms` — SEM flag, é cadastro):
  grava modelo (commission|monthly|hybrid) + % + mensalidade na FICHA com validação
  (0-100) e **trilha em audit.events** (`partner_terms_updated`, before/after).
- **Rotas:** GET `/admin/api/rede/comissoes` (flag off → `enabled:false`, UI some; on →
  roda a varredura e devolve o livro) · POST `/admin/api/rede/comissoes/settle`
  `{partner_id}` · POST `/admin/api/partners/:partner_id/terms` (editor, sem flag).
- **UI:** página REDE ganha o bloco **"Comissões a receber"** (total + por parceiro com
  botão Recebi + últimos lançamentos com badge; estornada-após-paga avisa "acerto por
  fora"); página da UNIDADE ganha o card **"Modelo comercial (Rede)"** (abaixo do raio de
  entrega; `x-effect` re-preenche ao trocar de parceiro; % some se modelo=mensalidade e
  vice-versa). `?v=20260703-comissao2`.
- **Alarme COBRAR + extrato escondido** (pedido do dono 07-02, na sequência): a tela
  mostra UM botão Recebi por LOJA com o total ACUMULADO (não um por venda — o extrato
  lançamento-a-lançamento fica ESCONDIDO atrás de "ver extrato"). O dono define o valor X
  ("piscar COBRAR quando a loja acumular R$ ___", salvo nesta máquina —
  `localStorage farejador_comissao_alerta`, mesmo padrão da meta da Rede; em branco/0 =
  sem alarme); loja com aberto ≥ X → linha rosa + badge **🔔 COBRAR** piscando
  (`animate-pulse`) + botão **"Cobrar no WhatsApp"** (deep-link `wa.me` com mensagem
  pronta e o valor — padrão da casa, fora da API Meta; só aparece se a ficha tem
  `whatsapp_phone`, que agora viaja no payload do livro — `getCommissionLedger`).
  Funções: `setComissaoAlerta` / `comissaoEstourou` / `comissaoWhatsLink` (app.js).
- **Card antigo "A receber da rede" agora LÊ O LIVRO** (furo apontado pelo DONO 07-02 ao
  testar o Recebi: quitou no livro e o card antigo — conta de padaria % × vendas 2W do
  período — continuava mostrando R$ 53 na MESMA página). Com a flag on, os 3 lugares
  (card do RESUMO + bloco da REDE + drill-down "Cobrança à matriz" da unidade) mostram
  comissão = lançamentos EM ABERTO no livro (respeita o Recebi; frete fora; sem recorte
  de período — rótulos/subtítulos trocam junto: "Comissão (em aberto)"); mensalidade
  segue estimativa do mês (vira lançamento na próxima fatia); flag off = comportamento
  antigo intocado. Getters `livroComissaoOn` / `redeComissaoAReceber` /
  `redeAReceberTotal` / `parceiroComissaoAReceber` / `parceiroAReceberTotal` (app.js;
  casamento por `partnerId` que o applyRede já carregava); `loadComissoes()` agora roda
  no init (o card do Resumo precisa do livro no boot; flag off = resposta barata).
  Provado no preview 4213: estimativa antiga daria 53 → card mostra 0 (livro quitado);
  dívida fake injetada no navegador → card/drill mostram 77,50 na hora; restaurado → 0.
  `?v=20260703-comissao3`.

## 3. Provas (tudo verde)

- `scripts/prova-comissao-rede-test.ts` **18/18** (integração real, fake-rede-a, faxina e
  ficha RESTAURADA no finally): nasce só quando realiza (pickup fechado ✓, entrega
  pendente ✗→entregue ✓, aguardando retirada ✗→retirado ✓, porta ✗, cancelada ✗) ·
  **frete fora da base** (309,90 com 9,90 de frete → 10% de 300 = 30,00) · idempotente ·
  % congelado (ficha 10→15%, lançamento antigo segue 10) · livro por parceiro (4 abertos
  = R$110) · Recebi quita 4 + `nothing_open` no retry · venda cancela APÓS paga →
  reversed com settled_at preservado · editor valida (percent>100 barra, parceiro
  fantasma barra) + grava + audita.
  Rodar: `npx tsx --env-file=.env.pooler scripts/prova-comissao-rede-test.ts`
- Regressão: vitest **519/519** · fiado 14/14 · cancelar 13/13 · baixa 12/12 ·
  fornecedores 10/10 · custo varejo (fatia 2) 15/15 · typecheck.
- **Visual** (preview `matriz-fatia2-4212`, agora com `NETWORK_COMMISSION_LEDGER=true`):
  seed 2 vendas 2W (350+180) → abrir a página Rede DISPAROU a varredura no servidor →
  bloco "Comissões a receber R$ 53,00" com FAKE REDE A (2 lançamentos) + badges; página
  da unidade com o editor PRÉ-CARREGADO da ficha (commission, 10%). Console zero erros.
- **Visual do ALARME** (retomada pós-interrupção; preview novo `matriz-comissao-4213` —
  o 4212 era de outra sessão e ficou DE PÉ, backend dele é anterior ao `whatsapp_phone`
  no livro): re-seed da demo (agora o seed também põe `whatsapp_phone` fake 21999990000
  no fake-rede-a) → alarme em R$ 50 com R$ 53 acumulado → `comissaoEstourou=true`, linha
  rosa + badge COBRAR piscando confirmados no DOM e no print; `comissaoWhatsLink` =
  `wa.me/5521999990000?text=...` (DDI 55 automático, mensagem com o valor); extrato
  fechado por padrão, abre no clique; alerta persistido (`localStorage=50`). Re-prova
  pós-retomada: typecheck ✓ · prova 18/18 ✓ · vitest 519/519 ✓. Demo SEMEADA de pé no
  4213 pro dono ver (limpar: `node scripts/seed-demo-comissao.cjs --limpar`).

## 4. Avisos honestos

1. **O % congela na CRIAÇÃO do lançamento (varredura), não no instante exato da venda** —
   janela entre realizar e a primeira varredura usa o % vigente na varredura. Com a tela
   aberta no dia a dia a janela é minutos; rigor absoluto exigiria histórico de % (não vale
   a complexidade agora).
2. **Lançamentos NASCEM da flag em diante** — ligou, a primeira varredura pega TODO o
   histórico de vendas 2W realizadas (prod tem pouquíssimas — começa quase zerado, sem
   dívida-surpresa; se quiser começar do zero absoluto, é só quitar/ignorar o retroativo).
3. **Estorno de lançamento PAGO não mexe em dinheiro** — marca e avisa ("acerto por
   fora"), igual o cancelamento do atacado.
4. `sweepCommissionEntries` duplica a régua de realizada do `getPainelRede` (fragmentos
   são template strings locais de lá) — comentário cruzado nos dois pontos.
5. **Estorno é MÃO ÚNICA (achado da banca de 4 especialistas, 07-02):** venda cancelada
   → lançamento `reversed`; se a venda for RE-confirmada depois (cancelou por engano e
   refez), o lançamento NÃO ressuscita sozinho (o INSERT bate no ON CONFLICT e o UPDATE
   só sai de open/settled). Cancelamento 2W é raro e o dono já trata pós-pago como
   "acerto por fora" — decisão: documentar, não automatizar. Se acontecer: acerto manual.
6. **Fila 0119 (aditiva, ANTES de ligar a flag com volume grande):** (a) índice parcial
   `partner_orders (environment, source_tag) WHERE source_tag='2w' AND deleted_at IS NULL`
   — a varredura hoje faz Seq Scan e roda em todo GET da página Rede (ok com volume atual,
   pesa na escala 100); (b) replicar na 0118 a TRAVA FÍSICA da 0110 (DO block que explode
   se `farejador_partner_app` ganhar acesso ao livro por acidente futuro). Achados da
   banca (banco+seguranca), nenhum bloqueante hoje.

## 5. Estado / o que falta (ordem)

| Obra | Commit | Deploy | Flag |
|---|---|---|---|
| Cancelamento (0116) | `ed82fa5` PUSHADO | pendente | sem flag |
| Fatia 2 — lucro varejo (0117) | `91a3694` PUSHADO | pendente | `WHOLESALE_MATRIZ_RETAIL_COST` OFF (ligar) |
| Comissão (0118) | **COMMITADA+PUSHADA nesta sessão** (após banca 4×SHIP: banco+seguranca+parceiro+matriz) | pendente | `NETWORK_COMMISSION_LEDGER` OFF (ligar) |

1. Dono manda **push** → commit da comissão (env.ts, queries.ts, route.ts, app.js,
   index.html, 0118, prova) + este handoff + CLAUDE.md. (`.claude/launch.json` é
   IGNORADO pelo git — configs de preview ficam locais, não viajam.)
2. **Deploy** (carrega 0116+0117+0118 juntos) → conferir `?v=20260703-comissao3` de fora.
3. Ligar no Coolify: `WHOLESALE_MATRIZ_RETAIL_COST=true` + `NETWORK_COMMISSION_LEDGER=true`.
4. Validar ao vivo: venda fiada → Recebi (fiado) · registro errado → Cancelar · venda
   balcão → card Custo/Lucro mexe · abrir a Rede → comissões aparecem (se houver 2W
   realizada) · editar % de um parceiro → rótulo muda.
5. Herdadas: raios REAIS · matar zz-teste · rotacionar chave Google · validar frete-pino
   (flag JÁ LIGADA, roteiro #696) · faxina de chaves (combinada 07-02).

## 6. Roadmap depois desta

**Consolidado das 3 pernas DESBLOQUEADO** (varejo com custo congelado ✓ + atacado ✓ +
comissão como lançamento ✓): a tela única "faturei/lucrei/tenho a receber" agora é só
LEITURA das três fontes. Depois: mensalidade como lançamento (mesmo desenho da comissão);
faxina de chaves; PEPS e Camada 2 seguem adiados de propósito.

— Orquestrador (Claude Fable 5) — domínios `matriz` + `banco`, 2026-07-02
