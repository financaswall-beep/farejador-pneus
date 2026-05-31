# Guia dos indicadores — Financeiro do Portal Parceiro

Data: 2026-05-24  
Tela: `/parceiro/:slug/` → menu **Financeiro**

Este documento explica, em linguagem simples, cada indicador da tela financeiro do parceiro.

## Ideia central

O financeiro foi separado em tres visoes:

1. **Competencia:** o que aconteceu no mes, mesmo que ainda nao tenha entrado ou saido dinheiro.
2. **Caixa:** o que entrou e saiu de dinheiro de verdade no mes.
3. **Futuro:** o que ainda esta em aberto para receber ou pagar.

Essa separacao evita a confusao mais comum: achar que uma venda "a receber" ja virou dinheiro no caixa, ou que uma compra a prazo ja foi paga.

## Fluxo de caixa projetado

Os quatro cards do topo mostram contas abertas por vencimento. Cada card mostra:

- valor verde: total a receber naquele periodo;
- valor vermelho: total a pagar naquele periodo;
- valor principal: saldo liquido, ou seja, `a receber - a pagar`;
- contadores: quantidade de contas a receber e contas a pagar no periodo.

### Vencido

Mostra contas a receber e contas a pagar com vencimento anterior a hoje.

Uso pratico:

- Se estiver negativo, existe mais conta vencida a pagar do que a receber.
- Se estiver positivo, existe dinheiro atrasado para cobrar.

### Hoje

Mostra contas que vencem hoje.

Uso pratico:

- Ajuda o parceiro a saber o que precisa cobrar ou pagar no dia.

### Proximos 7d

Mostra contas que vencem nos proximos 7 dias.

Uso pratico:

- Ajuda a antecipar aperto de caixa na semana.

### Proximos 30d

Mostra contas que vencem nos proximos 30 dias.

Uso pratico:

- Ajuda a enxergar se o mes esta confortavel ou se vai faltar dinheiro.

## Cards principais

### Vendas do mes

Total vendido no mes atual.

Fonte:

- vendas confirmadas em `commerce.partner_orders`;
- nao conta vendas canceladas.

Formula:

```text
Vendas do mes = soma do valor das vendas confirmadas no mes
```

Importante:

- Venda a receber entra aqui porque a venda aconteceu.
- O dinheiro dessa venda so entra no caixa quando a conta a receber for marcada como recebida.

### Ticket medio

Valor medio de cada venda no mes.

Formula:

```text
Ticket medio = Vendas do mes / Numero de vendas do mes
```

Uso pratico:

- Mostra se o parceiro esta vendendo apenas itens baratos ou vendas melhores.
- Exemplo: vender 10 vezes R$ 50 gera ticket de R$ 50; vender 2 vezes R$ 250 gera ticket de R$ 250.

### Custo do mes (competencia)

Representa o custo realizado do mes pelo regime de competencia.

> Atualizado em 2026-05-31: antes usava "Compras do mes"; passou a usar CMV para
> bater com o resultado (ver migration 0077). Compras viraram KPI separado de
> caixa/reposicao, fora do custo de competencia.

Formula:

```text
Custo do mes = CMV (custo dos pneus vendidos no mes) + Despesas do mes
```

Leitura simples:

- E o minimo que o parceiro precisa vender no mes para cobrir o custo da mercadoria
  vendida e as despesas registradas.
- Se as vendas do mes forem maiores que esse numero, o resultado estimado fica positivo.

Observacao:

- Nao e um ponto de equilibrio contabil real (nao separa custo fixo, custo variavel,
  imposto ou margem por produto). E uma leitura simples de cobertura de custo.
- Desde 2026-05-31 (migration 0078), "Despesas do mes" e por COMPETENCIA: uma conta a
  pagar de despesa (ex.: aluguel) ja pesa no resultado no mes em que vence, mesmo antes
  de ser paga. Compra de pneu continua de fora (so vira custo via CMV quando vende).

### Resultado estimado

Estimativa de resultado do mes pelo regime de competencia.

Formula:

```text
Resultado estimado = Vendas do mes - CMV - Despesas do mes
```

(CMV = custo dos pneus efetivamente vendidos no mes, nao o que foi comprado.)

Uso pratico:

- Mostra se a operacao do mes esta dando lucro ou prejuizo no papel.

Importante:

- Nao e a mesma coisa que dinheiro em caixa.
- Uma venda a receber aumenta o resultado estimado, mas nao aumenta o caixa ate ser recebida.
- Uma compra a prazo aumenta o custo do mes, mesmo que ainda nao tenha sido paga.

### Margem estimada

Percentual de resultado sobre as vendas.

Formula:

```text
Margem estimada = Resultado estimado / Vendas do mes * 100
```

Uso pratico:

- Mostra quanto sobra em percentual depois de compras e despesas.
- Exemplo: vendeu R$ 1.000 e resultado estimado foi R$ 200 → margem de 20%.

## Blocos de leitura financeira

### Competencia do mes

Mostra o resultado pelo que aconteceu no mes.

Componentes:

- vendas;
- CMV (custo da mercadoria vendida);
- despesas;
- resultado de competencia.

Formula:

```text
Competencia do mes = Vendas - CMV - Despesas
```

Quando usar:

- Para saber se a operacao foi boa no mes, independentemente do prazo de pagamento.

### Caixa do mes

Mostra o dinheiro que entrou e saiu de verdade no mes.

Entradas consideradas:

- vendas pagas na hora;
- contas a receber marcadas como recebidas no mes.

Saidas consideradas:

- compras pagas na hora;
- despesas pagas;
- contas a pagar marcadas como pagas no mes.

Formula:

```text
Caixa do mes = Entrou no mes - Saiu no mes
```

Quando usar:

- Para saber se o parceiro ficou com mais ou menos dinheiro no bolso durante o mes.

### Posicao futura

Mostra o saldo das contas em aberto.

Componentes:

- contas a receber em aberto;
- contas a pagar em aberto.

Formula:

```text
Posicao futura = A receber em aberto - A pagar em aberto
```

Quando usar:

- Para saber se o futuro proximo esta positivo ou negativo.

## Graficos

### Resultado financeiro

Grafico de barras com quatro valores:

- vendas;
- CMV (custo da mercadoria vendida);
- despesas;
- resultado.

Uso pratico:

- Ajuda a enxergar visualmente se CMV e despesas estao consumindo as vendas.
- As barras reconciliam: Resultado = Vendas - CMV - Despesas.

### Composicao dos custos

Grafico de rosca que divide os custos do mes entre:

- CMV (custo da mercadoria vendida);
- despesas.

No centro aparece o total de custos.

Formula do centro:

```text
Total de custos = CMV + Despesas do mes
```

Uso pratico:

- Mostra se o custo esta vindo mais do custo dos pneus vendidos ou de despesas operacionais.
- Reconcilia com o resultado (mesma base de custo do lucro do mes).

### Origem dos pneus

Grafico de rosca que divide os pneus vendidos por origem:

- **2W:** vendas ligadas a origem 2W;
- **Porta:** vendas de cliente que entrou direto pela borracharia.

No centro aparece o total de pneus vendidos.

Uso pratico:

- Mostra se o parceiro esta vendendo mais por indicacao/fluxo 2W ou por movimento proprio da loja.

### Grafico financeiro dos ultimos 30 dias

Linha de receita por dia nos ultimos 30 dias.

Formula:

```text
Valor do dia = soma das vendas confirmadas naquele dia
```

Uso pratico:

- Ajuda a ver dias fortes, dias fracos e tendencia de movimento.

## Cards laterais

### Contas a pagar

Mostra o total de contas abertas que o parceiro ainda precisa pagar.

Formula:

```text
Contas a pagar = soma de partner_payables com status open
```

Tambem mostra quanto foi pago no mes.

### Contas a receber

Mostra o total de contas abertas que o parceiro ainda precisa receber.

Formula:

```text
Contas a receber = soma de partner_receivables com status open
```

Tambem mostra quanto foi recebido no mes.

## Listas recentes

### Contas a receber recentes

Lista contas que o parceiro cadastrou como valor a receber.

Pode vir de:

- venda feita como "Ficou a receber";
- cadastro manual de conta a receber.

Status principais:

- `open`: ainda falta receber;
- `received`: ja recebeu;
- `cancelled`: cancelada.

### Contas a pagar recentes

Lista contas que o parceiro cadastrou como valor a pagar.

Pode vir de:

- compra de pneus a prazo;
- cadastro manual de conta a pagar;
- material/servico pago ou a pagar.

Status principais:

- `open`: ainda falta pagar;
- `paid`: ja pagou;
- `cancelled`: cancelada.

## Formularios da tela

### Cadastrar conta a pagar

Serve para registrar algo que a borracharia deve pagar ou ja pagou.

Exemplos:

- fornecedor;
- funcionario;
- aluguel;
- agua/luz;
- manutencao;
- outras despesas.

Se marcar como **em aberto**, entra em contas a pagar.

Se marcar como **pago agora**, entra como pagamento no caixa do mes.

### Cadastrar conta a receber

Serve para registrar dinheiro que a borracharia tem para receber ou ja recebeu.

Exemplos:

- cliente ficou devendo;
- venda em prazo;
- recebimento manual.

Se marcar como **em aberto**, entra em contas a receber.

Se marcar como **recebido agora**, entra no caixa do mes.

### Registrar venda

Venda normal do parceiro.

Se escolher **Recebeu agora**:

- entra em vendas do mes;
- entra no caixa do mes.

Se escolher **Ficou a receber**:

- entra em vendas do mes;
- cria conta a receber;
- so entra no caixa quando for marcada como recebida.

### Registrar compra de pneus

Compra de estoque.

Se escolher **Pago na hora**:

- aumenta compras do mes;
- sai do caixa do mes.

Se escolher **A prazo**:

- aumenta compras do mes;
- cria conta a pagar;
- so sai do caixa quando a conta for marcada como paga.

## Resumo das diferencas mais importantes

### Venda e dinheiro nao sao sempre a mesma coisa

Uma venda a prazo aumenta vendas e resultado, mas ainda nao aumenta caixa.

### Compra e pagamento nao sao sempre a mesma coisa

Uma compra a prazo aumenta compras/custos, mas ainda nao sai do caixa ate pagar.

### Resultado estimado e caixa do mes podem divergir

Exemplo:

```text
Vendeu R$ 1.000 a receber
Comprou R$ 300 pago na hora

Resultado estimado = R$ 700
Caixa do mes = -R$ 300
```

Isso e normal. O resultado diz se a venda foi boa. O caixa diz se entrou dinheiro.

## Limitacoes conscientes

Este financeiro e propositalmente simples. Ele nao tenta ser ERP completo.

Ainda nao cobre:

- conta bancaria separada;
- conciliacao bancaria;
- estorno automatico de pagamento;
- nota fiscal;
- fechamento contabil mensal;
- parcelamento de contas a pagar.

Para o uso atual, a prioridade e controlar bem:

- venda;
- estoque;
- compra;
- conta a pagar;
- conta a receber;
- dinheiro que entrou/saiu;
- pendencias futuras.

