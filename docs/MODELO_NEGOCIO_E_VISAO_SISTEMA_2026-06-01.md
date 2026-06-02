# Farejador — Modelo de Negócio & Visão do Sistema

**Data:** 2026-06-01 · **Autor:** Claude (Opus 4.8) sob direção do Wallace
**Status:** documento-norte (negócio + arquitetura em 3 camadas). Marca o que **já existe/validado** vs **ideia/a construir**.

---

## 1. A tese do negócio (em uma frase)

> **Wallace é um distribuidor de pneus.** Ele dá um sistema de graça pro borracheiro,
> gera clientes pra ele com tráfego pago + bot, e com isso faz o borracheiro **vender mais
> e comprar mais pneu no atacado dele**. O sistema é a isca; o pneu no atacado é a receita.

O dinheiro de verdade está no **atacado de pneus**. O sistema parceiro, o bot e a matriz
existem para **aumentar o giro do borracheiro** (e, por tabela, a recompra de pneu) e para
**capturar os dados** de toda a rede.

---

## 2. O volante (flywheel)

```
        Tráfego pago (Wallace investe)
                  │
                  ▼
        Bot capta o cliente (WhatsApp/IG/FB)
                  │
                  ▼
        Lead/pedido encaminhado ao borracheiro parceiro
                  │
                  ▼
        Borracheiro vende (usa o sistema parceiro)
                  │
                  ├─► Matriz "chupa" os dados da venda (monitora a rede)
                  │
                  ▼
        Borracheiro precisa repor estoque
                  │
                  ▼
        Compra pneu NO ATACADO da matriz  ◄── RECEITA PRINCIPAL
                  │
                  ▼
        Mais giro ⇒ mais recompra ⇒ volante gira mais forte
```

Quanto mais cliente o Wallace entrega, mais o borracheiro vende, mais pneu ele compra de
volta. A **mensalidade/comissão** do parceiro serve para **bancar o tráfego pago** que
alimenta o volante (não é o lucro principal — é o combustível).

---

## 3. As 3 camadas

### 3.1 PARCEIRO (o borracheiro) — *a isca*
Portal operacional que o borracheiro ganha de graça. Roda a loja dele inteira.
- **Existe e validado (★★★★☆):** Frente de caixa (PDV), Estoque (pneu/insumo/serviço),
  Clientes (VIP automático), Financeiro (caixa, contas a pagar/receber, resultado, score),
  **Pedido de entrega COD** (paga na entrega), e **Bate-papo unificado** (WhatsApp/IG/FB
  dentro do portal, com envio e tempo real).
- **Isolamento:** cada parceiro só vê a própria unidade (RLS efetivo no Postgres).
- **Valor pro Wallace:** engaja o borracheiro no dia a dia → ele não larga → e gera o
  **dado** que a matriz consome.

### 3.2 BOT (a Atendente) — *o gerador de clientes*
Atende no Chatwoot (WhatsApp/IG/FB), responde o cliente do tráfego pago e **encaminha o
pedido** pro parceiro.
- **Existe:** captação + resposta + encaminhamento; modo shadow/review pra calibrar.
- **Papel no volante:** transforma **R$ de anúncio em lead** e entrega o lead no colo do
  borracheiro (vendas marcadas como origem `2w` = "veio da internet/bot").
- **Risco aberto conhecido (SEC-001):** o bot pode vazar pedido de outro cliente por
  número — **prioridade de segurança** antes de escalar.

### 3.3 MATRIZ (o Wallace) — *o cockpit do dono da rede*
Painel que agrega e monitora **todas** as lojas + monetiza os parceiros.
- **Existe:** aba **Rede** com visão consolidada + **drill-down por loja** (faturamento,
  pedidos, compras, despesas, resultado, saúde da unidade, modelo comercial, comissão %,
  gráficos). Lê das views `network.partner_unit_summary` / `network_orders_unified` /
  `network_stock_unified`.
- **Regra de ouro do silo:** *matriz vê tudo do parceiro; parceiro não vê nada da matriz.*
- **A construir:** a **conta matriz↔parceiro** (cobrança) — hoje só **mostra** a taxa, não
  **calcula** o quanto cada um deve. E há **dados mockados** de parceiros fake no front a
  limpar.

---

## 4. Monetização (as fontes de receita)

| Fonte | O que é | Status |
|---|---|---|
| **Atacado de pneus** | Borracheiro repõe estoque comprando da matriz. **Receita principal.** | Negócio existente; ligação ao sistema (compras do parceiro = venda atacado da matriz) a mapear |
| **Mensalidade** | Taxa fixa R$X/mês do parceiro — banca o tráfego pago | Campo `monthly_fee` existe; **cobrança a construir** |
| **Comissão** | % sobre as vendas que **a matriz gerou** pro parceiro | Campo `commission_percent` existe; **cálculo a construir** |

### Modelo comercial por parceiro (à escolha)
Cada parceiro tem **um** arranjo, e o banco já aceita os três:
- **Mensalidade** (fixa), ou
- **Comissão** (% sobre vendas), ou
- **Híbrido** (mensalidade + comissão).

### Decisão de design pendente — base da comissão
Sobre **o que** a comissão incide:
- **(Recomendado) Só sobre o que a matriz trouxe** — vendas origem `2w` (bot/tráfego).
  Discurso justo: *"cobro % dos clientes que EU te entreguei"*. O sistema **já separa**
  `sales_2w` de `sales_porta`.
- Sobre **todas** as vendas (2w + balcão) — mais agressivo, difícil de justificar.

Fórmula proposta do que o parceiro deve à matriz no mês:
```
devido_mes = monthly_fee (se mensalidade)  +  (sales_2w × commission_percent)  (se comissão)
```

---

## 5. A ideia do sistema (visão integrada)

Os três pilares formam **uma máquina só**:

1. **Bot** vira anúncio em cliente e joga no parceiro.
2. **Parceiro** opera a venda e a entrega COD, e fica preso ao sistema pela conveniência.
3. **Matriz** observa tudo, cobra o combustível (mensalidade/comissão) e vê quem está
   comprando pouco pneu (oportunidade de empurrar atacado).

O que falta para fechar o círculo no software:
- **Módulo de cobrança da rede** (matriz): fecha o mês, mostra quanto cada parceiro deve,
  por loja e consolidado. *(próximo passo recomendado)*
- **Editor do modelo comercial** por parceiro (hoje cadastro é só-leitura).
- **Ligação atacado:** enxergar a compra do parceiro como venda-atacado da matriz (quem
  compra muito × pouco), pra o Wallace agir comercialmente.
- **Roteamento multi-loja do bot:** quando houver 2+ parceiros, decidir pra quem vai o lead
  (geografia/rodízio) — hoje o fan-out assume 1 unidade ativa.

---

## 6. Estado atual × a construir

| Peça | Estado |
|---|---|
| Portal parceiro (PDV, estoque, financeiro, COD, chat) | ✅ Existe e **auditado ★★★★☆** |
| Integridade financeira do parceiro | ✅ Validada (20 invariantes + teste vivo) |
| Bot capta + encaminha lead | ✅ Existe |
| Matriz: visão da rede + drill-down por loja | ✅ Existe |
| Matriz: **cobrança (mensalidade/comissão)** | 🔨 **A construir** |
| Matriz: editor do modelo comercial | 🔨 A construir |
| Matriz: dados mockados no front | 🧹 Limpar |
| Roteamento multi-loja do bot | 🔮 Quando houver 2+ parceiros |
| SEC-001 (vazamento no bot) | 🔴 Risco de segurança aberto |
| Mobile (parceiro + matriz) | ⚠️ Não validado |

---

## 7. Roadmap sugerido (ordem de valor)

1. **Passo 0 — confiança:** garantir que a Rede mostra **parceiro real** (matar mock).
2. **Cobrança da rede (mensalidade + comissão):** o módulo que dá sentido econômico à
   matriz. Base da comissão = `sales_2w` (recomendado). Inclui editor do modelo comercial.
3. **Ligação atacado:** mapear compra do parceiro ↔ venda-atacado da matriz (relatório de
   "quem está comprando pneu de mim").
4. **SEC-001 + hardening + mobile:** antes de credenciar o 2º parceiro / expor publicamente.
5. **Roteamento multi-loja do bot:** quando a rede crescer.

---

## 8. Princípios que já guiam a arquitetura (manter)

- **Silo isolado:** parceiro nunca enxerga a matriz; matriz lê tudo via views de rede.
- **Números à prova de bala:** todo movimento (venda, baixa, cancelamento, pagamento) é
  atômico, idempotente e auditado em `audit.events`. Confiança > features.
- **COD como modelo padrão do lead:** pedido da internet paga na entrega; vira venda/caixa
  só quando o entregador finaliza.
- **Preview sem efeito colateral:** servidores enxutos (`preview-parceiro`, `preview-matriz`)
  para mexer em prod sem acionar o bot.

---

*Este documento é a visão consolidada para guiar a evolução. Próxima decisão para destravar
o desenvolvimento: confirmar a base da comissão (recomendado: sobre vendas `2w`).*
