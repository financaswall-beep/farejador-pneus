# Sessão 2026-07-06c — Auditoria da aba COMPRAS + conserto dos furos (0127)

## Parte 1 — AUDITORIA (pedido do dono: aba a aba, mesma régua da Vendas)

Provas re-rodadas verdes (prova-fornecedores 8/8, prova-financeiro-atacado 14/14) +
ciclo COMPLETO no preview 4225 pelo caminho do usuário: compra à vista com fornecedor
novo (galpão recebeu na mesma transação, telefone normalizado), compra FIADA (média
ponderada exata 10@20+10@30→20@25; a pagar com vencimento na agenda do Financeiro),
Paguei quitou, medida fora do catálogo recusada com rollback, ranking/dependência/
preço-por-medida com ★ todos vivos, "parado no galpão" cruzando certo (20×25=500).

**Furos achados (1+2+3 se combinavam: fácil errar, não via, não desfazia):**
1. 🔴 Compra INVISÍVEL e IRREVERSÍVEL — o front até buscava `/wholesale/purchases`
   e jogava fora (nenhuma tabela); cancelamento não existia (o banco 0114 já previa
   status 'cancelled', nunca construído). A venda tinha lista+badge+Cancelar (0116).
2. 🟠 Custo em branco = compra a R$ 0 SEM aviso → média desabou 23,64→19,26 ao vivo
   (contamina lucro varejo 0117, lucro atacado, capital parado).
3. 🟠 Linha sem medida DESCARTADA em silêncio — tela mostrava R$170, registrou R$20.
4. 🟡 Erro de qtd não-inteira vazava inglês; fornecedor duplicável; sem arquivar.

Nota da auditoria: ⭐⭐⭐½ (motor 5★ — transação/média/segurança; cabine 2★).

## Parte 2 — CONSERTO (autorização direta do dono: "faça também os menores")

- **0127 APLICADA test+prod**: trilha cancelled_at/by/reason em wholesale_purchases
  (espelho da 0116; o CHECK 'cancelled' já existia desde a 0114).
- **`cancelWholesalePurchase`** (`queries-fornecedores-cancel.ts` NOVO, teto 300):
  transacional, FOR UPDATE, trilha, e REVERTE o galpão pelo inverso ponderado —
  novo = (qty×custo − qty_i×custo_i)/(qty − qty_i). Reversão INCONDICIONAL (a entrada
  também é — simetria; a venda usa flag porque a baixa usa). Clamps honestos
  documentados (já vendeu parte → qty clampa 0; média mudou → custo clampa 0; qty
  zerou → mantém custo). Ranking/breakdown/a pagar se corrigem sozinhos (filtram
  confirmed). Cancelar 2x → purchase_already_cancelled.
- **`archiveWholesaleSupplier`**: soft delete; some do form/ranking/breakdown;
  compras ficam no histórico; dívida pendente CONTINUA no a pagar (provado).
- **Rotas** `POST /admin/api/wholesale/purchases/cancel` + `/suppliers/archive`
  (ambas AUTH — fiscal de rotas conferiu; baseline 93→95 regravado de propósito).
- **Tabela "Últimas compras"** na sub-aba Comprar (o dado já chegava no navegador):
  data/fornecedor/pneus (SOMA das unidades)/total/badge pago×a-prazo-vence×cancelada/
  botão Cancelar (aviso forte se paga: "acerto por fora").
- **3 confirms no form** (matam os furos na origem): custo R$ 0 ("derruba o custo
  médio — é isso mesmo?"), linha preenchida sem medida ("vai ficar DE FORA"), nome
  de fornecedor repetido ("cria OUTRO? escolhe ele na lista"). Linha 100% vazia
  segue ignorada sem pergunta.
- **Erro traduzido**: quantity não-inteira → código 'quantidade_inteira' no zod →
  "Quantidade tem que ser número inteiro (sem vírgula)."
- Botão **arquivar** no ranking de fornecedor. Bump `?v=20260707-compras1`.

## Provas
- **prova-compras-cancel-test.ts NOVA: 18/18 ×2** (média reversa EXATA 20@25→10@20,
  trilha, some do ranking/breakdown/a-pagar, 2x=409, clamp 5−10→0 custo mantido,
  fiada some do a pagar + settle vira payable_not_found, lista com status, archive).
  ⚠️ Lição: prova que liga flag usa `await import()` DINÂMICO no main() (import
  estático é içado e o `process.env.X=...` textual NÃO pega — provado empiricamente).
- Não-regressão: prova-fornecedores 8/8, prova-financeiro-atacado 14/14, 522 unit,
  typecheck, checar-tamanho OK. Paridade 345→348 regravada DE PROPÓSITO.
- Preview 4225 ponta a ponta: registrar→ver na lista→cancelar (trilha "Wallace /
  teste da auditoria", galpão 20@25→10@20 no banco vivo)→badge cancelada; os 3
  confirms aparecem e BARRAM no "não"; arquivar some do dropdown/ranking e o
  histórico fica. Test zerado no fim (0/0/0/0).

## Fica pra depois (de propósito)
- Drift de ≤1 centavo na média reversa quando a média armazenada tem dízima
  (round intermediário a 2 casas) — inerente à média persistida; correção real =
  livro-razão (Fase B, já na fila com banca).
- O mesmo erro de qtd não-inteira existe na VENDA de atacado (cosmético; escopo
  mínimo — mexi só na compra auditada).
- Assinatura: Orquestrador (Claude Fable 5) — domínio `matriz`, 2026-07-06
