# Sessão 2026-07-08b — Auditoria da aba FINANCEIRO (⭐⭐⭐⭐) + conserto do FRETE INVISÍVEL e do sweep da comissão

> Fecha a aba **Financeiro** na série de auditorias aba a aba (pedido do dono 07-06).
> Auditoria REPORTOU 2 furos → dono deu o "vai" → consertos SHIPADOS no mesmo dia.
> **SEM migration. SEM flag nova.** Rollback = reverter o commit.

---

## 1. A auditoria (rito das outras abas)

- **Provas de banco (flags de prod):** prova-financeiro-visao **25/25 ×2**, prova-financeiro-atacado (fiado 0115) 14/14, prova-sino-galpao 12/12.
- **Preview 4227** (entrada nova `matriz-financeiro-audit-4227` no `.claude/launch.json`, mesmo molde do 4226) ponta a ponta pelo caminho do usuário: lançar despesa à vista "55,90" (vírgula parseia) → competência + lucro + pago-no-mês; a pagar com vencimento → agenda vencido-primeiro + ponto de equilíbrio recalcula EXATO (255,90 ÷ margem 72% = 355); Paguei → sai da agenda; fiado vencido → "Quem te deve" com VENCEU + telefone + Cobrar wa.me; comissão por parceiro; Recebi (fiado e comissão) → somem e o realizado do mês FICA; Remover → soft delete confirmado no banco.
- **Prod read-only:** 8 despesas reais ok (7 da IA R$624,55 + 1 manual R$55); atacado 335 / varejo 99 / capital 705 (39 pneus). Descrições pré-0129 sem ROTA-XXXX = esperado (formato novo é pra frente).
- **Integrações verificadas:** Vendas (cancelada some do fiado) · Compras (cancelada some do a pagar) · Estoque (capital parado = mesma conta) · Logística (gasolina/IA com nº da rota; apagar despesa reflete na rota) · Comissão (settle = mesmo endpoint da Rede) · Sino (réguas espelham as telas).
- **Nota: ⭐⭐⭐⭐** — zero bug de conta; perdeu meia pelo frete assimétrico + meia pela comissão defasada (abaixo).

## 2. Os furos achados (e consertados com o "vai")

### 🟠 Furo 1 — FRETE INVISÍVEL (assimetria Logística × Financeiro)
A **gasolina** da rota DESCONTA do lucro do mês (despesa 0120, lançada no fechamento e pela IA), mas o **frete que o cliente paga** (9,90/13/19 por distância) não somava em perna nenhuma — o varejo 0117 conta só itens DE PROPÓSITO (régua da comissão). O "a rota se pagou" da Logística SEMPRE contou o frete; o Financeiro não. Provado em prod: R$13 de frete (PED-0223) fora da conta vs R$507 de gasolina/pedágio dentro. **O lucro do mês mentia pra baixo, piorando com a escala de entrega.**

**Conserto:** perna **"Frete de entrega"** no consolidado (`queries-financeiro-visao.ts`):
- `mes.pernas.frete.recebido` — SEMPRE presente (deriva de `commerce.orders`, sem flag);
- conta = régua da Logística: `GREATEST(total_amount − Σ itens, 0)` por pedido (bot embute o frete no total; walk-in/desconto clampa em 0, nunca negativo);
- janela/cancelado = MESMA régua da perna do varejo (`created_at` mês São Paulo, `status <> 'cancelled'`, unit `main`, `fulfillment_mode='delivery'`);
- **faturamento e lucro do mês passam a incluir o frete** (frete entra CHEIO no lucro — o custo dele, a gasolina, já desconta nas despesas); margem e ponto de equilíbrio derivam.
- UI: barra ciano "Frete de entrega" entre Comissão e Despesas (`index.html` + candidato no `finBarWidth`); `?v=20260708-frete1`.

### 🟡 Furo 2 — comissão DEFASADA no Financeiro
A varredura (sweep 0118, idempotente) rodava só no **boot do painel** e no **GET da página Rede**. Painel aberto há horas + venda 2W realizando no meio = a perna da comissão e o "quem te deve" do Financeiro ficavam velhos até alguém abrir a Rede.

**Conserto:** o `GET /admin/api/matriz/financeiro` roda `sweepCommissionEntries()` ANTES da visão (`route-financeiro.ts`), **FAIL-OPEN** (sweep caiu → loga warn e a visão serve mesmo assim). A visão continua **leitura pura** (o sweep mora na PORTA, não na query — racional do comentário em `queries-comissoes.ts` preservado e atualizado).

### 🔵 Miudeza — giro "0 dias" com galpão zerado
`giro_dias` agora exige `capital_parado > 0` além de custo > 0 → galpão vazio mostra "—" (era "0 dias", ruído).

## 3. Provas do conserto

- **prova-financeiro-visao-test.ts estendida: 30/30 ×3** (novos V9a–V9e: frete +10 = 110−100 no consolidado · faturamento +110 · lucro sobe SÓ o frete (item sem custo não chuta lucro de pneu) · retirada não gera frete · total<itens clampa em 0 · CANCELOU → frete sai). Test-first: V9 escrito ANTES, quebrou exatamente na perna inexistente.
- **Sweep no GET provado AO VIVO** (one-off, apagado depois): venda 2W realizada plantada com 0 lançamentos → `GET /admin/api/matriz/financeiro` (200) → lançamento nasceu `open` R$50,00 (10% de 500) E o parceiro veio no "quem te deve" DA MESMA RESPOSTA.
- prova-comissao-rede (não-regressão do sweep) ✓ · **522 unit** ✓ · typecheck ✓ · fiscal do teto ✓ · **paridade 365 IDÊNTICA** (payload novo, interface Alpine intocada — sem regravação).
- Preview 4227 com o código novo: barra "Frete de entrega R$10,00" (5%, ciano), lucro 94,90 → **104,90**, faturamento 189,90 → **199,90**, giro "—". Screenshot ok.

## 4. Lições / avisos de percurso

- **Pooler de test estoura com 15 sessões**: 2 previews de pé + prova tsx = `EMAXCONNSESSION`. Reciclar o preview PRÓPRIO libera (o de outra sessão fica de pé — regra do dono).
- O renderer do preview travou uma vez no meio da auditoria (screenshot/eval timeout com confirm nativo); o estado foi conferido pelo BANCO (fonte da verdade) e o restart limpou.
- Pedido de varejo do env test com frete embutido (total 199,90 vs itens 189,90) validou a perna nova com dado pré-existente: baseline do frete = 10,00 na prova (10 → 20 com o seed).

## 5. O que NÃO entrou (de propósito)

- Refresh de 15s não recarrega a visão (recarrega ao entrar na aba) — padrão de TODAS as abas, mexer é obra própria.
- Parse "1.500" → R$1,50 (ponto de milhar) — padrão da casa INTEIRA em input de dinheiro; merece sessão própria, não conserto isolado numa aba.
- Fiado de varejo, pagamento parcial, livro-razão único, saldo/extrato = **Fase B** (planta `docs/PLANO_FINANCEIRO_MATRIZ_ROBUSTO_2026-07-02.md`, banca de 4 ANTES).
- "Vencido" vira ~3h mais cedo (current_date UTC) — consistente em todas as telas, custo/benefício de mexer não fecha.

## 6. Estado ao fim

- Pushado no `main` (aguarda Deploy do dono no Coolify). Conferir pós-deploy: `?v=20260708-frete1` no index + barra "Frete de entrega" na aba Financeiro.
- Preview **4227** de pé (financeiro, código novo) + **4226** de pé (da auditoria do Estoque — intocado).
- Banco de test limpo (seeds da auditoria e das provas removidos; one-offs apagados).
- Fila da auditoria de abas (o dono chama): **Resumo · Rede · Colaboradores**.

— Orquestrador (Claude Fable 5) — domínios `matriz` + `banco`
