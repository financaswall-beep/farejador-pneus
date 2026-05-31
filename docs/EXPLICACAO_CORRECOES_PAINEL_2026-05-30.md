# O que eu arrumei no painel do parceiro — explicado em português simples

**Data:** 2026-05-30
**Para:** Wallace (dono)
**Assunto:** auditoria de lógica, cálculos e métricas do painel do parceiro — o que estava
errado, o que eu fiz e por que importa. Sem termos técnicos.

> Resumo de uma linha: encontrei 5 problemas de cálculo no painel. Consertei 4.
> O 5º é uma **decisão sua** (o jeito de calcular "lucro"), e eu explico no fim.

---

## 1. Pedido cancelado aparecia como "Saiu pra entrega"

**O que estava errado:**
Na aba **Pedidos**, pedidos que já tinham sido **cancelados** continuavam mostrando o
selo antigo "Saiu pra entrega" ou "Recebido", como se fossem entregas de verdade. Aí
você ia na aba **Entrega** e não tinha nada — porque a Entrega (corretamente) só mostra
pedido ativo. Parecia bug, mas o errado era a aba Pedidos enganando.

**O que eu fiz:**
Agora pedido cancelado mostra um selo vermelho **"Cancelado"** e "sem cobrança". Também
arrumei as contas do topo: "Finalizados" só conta entrega concluída de verdade, e
"Não entregues" passa a incluir os cancelados.

**Por que importa:**
Você bate o olho e entende na hora o que aconteceu com cada pedido, sem achar que tem
entrega perdida.

**Analogia:** é como uma comanda riscada que ainda mostrava "pedido na cozinha". Agora
ela aparece carimbada como "cancelada".

---

## 2. O gráfico de faturamento dos últimos 30 dias estava quebrado

**O que estava errado:**
O gráfico que mostra quanto você faturou por dia no último mês estava com um errinho de
programação: **todos os 30 dias usavam a data de hoje**. Resultado: o gráfico não
mostrava o histórico — só o dia de hoje, repetido. O gráfico de *quantidade* do lado
estava certo; só o de *dinheiro* tinha o defeito (foi copiado e esqueceram uma linha).

**O que eu fiz:**
Coloquei a linha que faltava (recuar um dia por vez). Agora o gráfico mostra o
faturamento real de cada um dos 30 dias.

**Por que importa:**
Você passa a enxergar de verdade os dias fortes e fracos do mês.

**Analogia:** era um calendário onde todas as folhas estavam impressas com a data de
hoje. Agora cada folha tem o seu dia.

---

## 3. "Vendas de hoje" usava o fuso errado (do outro lado do mundo)

**O que estava errado:**
O contador de "vendas hoje" usava o horário **UTC** (fuso de referência mundial, que
está 3 horas à frente do Brasil), enquanto o caixa do dia usava o horário de **São
Paulo**. Os dois "hoje" não batiam: depois das **21h**, o contador já achava que era o
dia seguinte e podia mostrar número diferente do caixa.

**O que eu fiz:**
Padronizei o "vendas hoje" pra usar o horário de São Paulo, igual ao caixa. Agora os
dois sempre concordam.

**Por que importa:**
À noite, perto de fechar a loja, os números do painel batem entre si — não tem mais
"o caixa diz X e o contador diz Y".

**Analogia:** dois relógios na parede marcando horas diferentes. Acertei os dois pra o
horário de Brasília.

---

## 4. As métricas só olhavam os últimos 100 pedidos

**O que estava errado:**
O painel buscava só os **100 pedidos mais recentes** pra desenhar os gráficos. Hoje, com
pouco movimento, isso não dá problema. Mas numa loja movimentada, pedidos além dos 100
mais recentes **sumiriam** dos gráficos — inclusive pedidos de dentro do mês.

**O que eu fiz:**
Aumentei o limite de 100 para **500 pedidos**, o que cobre tranquilo a janela de 30 dias
mesmo numa loja bem movimentada.

**Observação honesta:** 500 ainda é um teto, não é infinito. Se um dia uma loja fizer
mais de ~16 pedidos por dia de forma sustentada, o jeito 100% certo é o servidor mandar
os totais já somados (em vez do painel somar na mão). Por enquanto, 500 resolve com
folga. Os **números grandes do topo** (faturamento do mês, resultado, etc.) já vinham
calculados no servidor sem esse limite — então sempre estiveram certos; o limite só
afetava os gráficos por dia.

**Analogia:** era como conferir o caixa olhando só as últimas 100 notinhas. Agora olha
as últimas 500 — pega o mês inteiro com sobra.

---

## 5. Os gráficos por dia agrupavam pelo fuso errado

**O que estava errado:**
Mesma família do problema 3, mas nos gráficos de 7 e 30 dias: eles agrupavam as vendas
por dia usando o fuso **UTC** em vez do de **São Paulo**. Uma venda feita à noite podia
cair no **dia errado** do gráfico.

**O que eu fiz:**
Fiz os três gráficos (7 dias, 30 dias unidades e 30 dias faturamento) agruparem por dia
de São Paulo, igual ao resto do painel.

**Por que importa:**
A venda das 22h aparece no dia certo, não empurrada pro dia seguinte.

---

## 6. ✅ "Resultado" e "Margem" agora são lucro real (CGV) — FEITO

> **Atualização (31/05):** você autorizou e eu **já implementei**. Resultado e Margem
> agora usam o **custo do que foi vendido (CGV)**, não mais "todas as compras do mês".

Esse era diferente dos outros: não era um defeito, era uma escolha de cálculo — por isso
eu esperei tua autorização antes de mexer.

**Como funciona hoje:**
O painel calcula o **resultado do mês** assim:

> Resultado = Vendas do mês − **Compras do mês** − Despesas do mês

O problema é a parte "Compras do mês". Quando você **repõe muito estoque** num mês (ex.:
compra R$ 20.000 em pneus), o painel joga esses R$ 20.000 inteiros como custo daquele
mês — mesmo que você vá vender esses pneus ao longo dos próximos meses. Aí o "resultado"
afunda e a **margem fica negativa**, dando a impressão de prejuízo, mesmo você tendo
vendido bem.

**O jeito mais "contábil" (lucro de verdade):**

> Lucro = Vendas − **custo só do que VENDEU** (não de tudo que comprou)

Isso se chama **CGV / custo da mercadoria vendida**. Reflete o lucro real da operação,
sem distorcer nos meses de reposição.

**O que eu fiz:**
- O **Resultado do mês** agora é: Vendas − **CGV** − Despesas (não mais "− Compras").
- O **CGV** = soma de (quantidade vendida × custo médio do item no estoque), só dos
  pedidos que contam como venda no mês.
- **Margem** e **Score financeiro** acompanham automaticamente (passam a refletir lucro
  real, sem precisar mexer em mais nada).
- A mudança foi no banco (migration **0074**), recriando a view de resumo. Adicionei uma
  coluna `cogs_month` pra transparência.

**O que eu NÃO mudei (de propósito):** o donut "Composição dos custos" e o "Total de
custos" continuam mostrando **Compras + Despesas** (a saída de caixa do mês) — é uma
visão de **caixa**, diferente do lucro. Então pode acontecer, num mês de reposição
grande, do "Resultado" estar **positivo** (deu lucro nas vendas) e ao mesmo tempo você
ter gasto bastante em estoque. As duas coisas são verdade e medem coisas diferentes
(lucro × caixa).

**Analogia:** é a diferença entre dizer "fiquei no vermelho esse mês porque enchi o
estoque" e "tive lucro nas vendas, e à parte investi em estoque pra vender depois". As
duas frases são verdade — mas a segunda mostra melhor se o seu negócio dá dinheiro.

---

## O que continua certo (também conferi)

Pra você ficar tranquilo, estas partes eu auditei e **estão corretas**:

- **Pagamento na entrega (COD):** o pedido fica como "a receber" e o dinheiro só entra
  no caixa quando você marca como **entregue**. Não conta antes nem conta duas vezes.
- **Contas a pagar/receber vencidas:** o painel separa certo o que está vencido, vence
  hoje, nos próximos 7/30 dias — tudo no horário de São Paulo.
- **Caixa do mês:** não conta a mesma despesa duas vezes (quando ela veio de uma conta a
  pagar).
- **Score financeiro:** a régua de 0 a 1000 é coerente e alcança as faixas (ruim →
  ótimo) — fora a ressalva do item 6, que afeta 3 dos critérios dele.

---

## Resumão

| # | Problema | Situação |
|---|---|---|
| 1 | Cancelado parecia entrega ativa | ✅ Corrigido |
| 2 | Gráfico de faturamento 30d travado em "hoje" | ✅ Corrigido |
| 3 | "Vendas hoje" com fuso errado | ✅ Corrigido |
| 4 | Métricas só viam 100 pedidos | ✅ Corrigido (subiu pra 500) |
| 5 | Gráficos por dia no fuso errado | ✅ Corrigido |
| 6 | "Resultado/Margem" usava compra como custo | ✅ Corrigido (agora CGV — migration 0074) |

Os 6 itens estão resolvidos. ✅
