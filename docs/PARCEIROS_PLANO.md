# Portal de Parceiros - Plano MVP Seguro

Data: 2026-05-19

## Objetivo

Criar um portal operacional simples para unidades parceiras da rede de borracharias, sem misturar dados do bot, do Shadow ou de outros parceiros.

O parceiro precisa conseguir:

- registrar venda local;
- consultar vendas do mes;
- cadastrar/ajustar estoque local;
- registrar compra de pneus;
- registrar despesa;
- ver um resumo simples da propria unidade.

O painel central continua sendo o lugar onde Wallace ve a rede inteira.

## Regra de isolamento

Todo dado do parceiro passa por `unit_id`.

O parceiro nao escolhe `unit_id` no request. A API resolve a unidade a partir de:

```text
/parceiro/:slug + Authorization: Bearer <token_do_parceiro>
```

Depois disso, todo SELECT/INSERT usa:

```sql
WHERE environment = FAREJADOR_ENV
  AND unit_id = unidade_do_token
```

## O que parceiro nao acessa

O portal parceiro nao le:

- `raw.*`
- `core.conversations`
- `core.messages`
- `agent.*`
- `ops.*`
- `analytics.*`
- `dashboard.shadow_pairs`
- qualquer dado do Bot/Shadow

Isso evita que uma unidade parceira veja conversas, rascunhos, comparacoes humano vs bot ou dados internos da automacao.

## Modelo de dados MVP

### `network.partners`

Cadastro comercial do parceiro:

- CNPJ/CPF;
- responsavel;
- telefone/WhatsApp;
- endereco;
- status: `credentialing`, `active`, `suspended`;
- modelo comercial: `commission`, `monthly`, `hybrid`;
- comissao e mensalidade.

### `network.partner_units`

Liga parceiro a uma unidade operacional:

- `partner_id`;
- `unit_id` apontando para `core.units`;
- `slug` publico da rota;
- nome/endereco/status da unidade.

### `network.partner_access_tokens`

Token por unidade/parceiro, salvo como hash SHA-256.

O banco nunca guarda token puro.

### `commerce.partner_stock_levels`

Estoque local da unidade:

- produto do catalogo, quando houver;
- descricao livre quando nao houver catalogo;
- quantidade;
- estoque minimo;
- fornecedor;
- custo medio;
- preco de venda;
- `is_tracked=false` para estoque nao controlado.

### `commerce.partner_purchases`

Compras de pneus feitas pela unidade.

### `finance.partner_expenses`

Despesas da unidade: funcionario, aluguel, energia, manutencao, extras.

Despesas usam exclusao logica:

- `deleted_at`;
- `deleted_by`.

Quando o parceiro exclui uma despesa, ela sai da lista ativa e do resumo financeiro, mas o registro permanece no banco para auditoria.

### Cancelamentos no MVP

O portal nao apaga dado comercial relevante:

- venda vira `commerce.orders.status = 'cancelled'`;
- compra recebe `commerce.partner_purchases.deleted_at`;
- estoque recebe `commerce.partner_stock_levels.deleted_at`;
- despesa recebe `finance.partner_expenses.deleted_at`.

Assim o painel operacional fica limpo, mas ainda existe trilha para conferencia.

## APIs MVP

Todas as rotas exigem token de parceiro:

```text
GET  /parceiro/:slug/api/resumo
GET  /parceiro/:slug/api/vendas
GET  /parceiro/:slug/api/estoque
GET  /parceiro/:slug/api/compras
GET  /parceiro/:slug/api/despesas
POST /parceiro/:slug/api/vendas
POST /parceiro/:slug/api/estoque
POST /parceiro/:slug/api/compras
POST /parceiro/:slug/api/despesas
DELETE /parceiro/:slug/api/vendas/:orderId
DELETE /parceiro/:slug/api/estoque/:stockId
DELETE /parceiro/:slug/api/compras/:purchaseId
DELETE /parceiro/:slug/api/despesas/:expenseId
```

## Como criar o primeiro token piloto

Depois de criar `network.partners`, `core.units` e `network.partner_units`, gere um token fora do banco, guarde apenas o hash e entregue o token puro ao parceiro uma unica vez.

Exemplo:

```sql
INSERT INTO network.partner_access_tokens (
  environment, partner_unit_id, token_hash, label, created_by
) VALUES (
  'prod',
  '<partner_unit_id>',
  network.hash_partner_token('<token-puro-entregue-ao-parceiro>'),
  'piloto celular principal',
  'wallace'
);
```

Se vazar, revoga:

```sql
UPDATE network.partner_access_tokens
SET revoked_at = now()
WHERE id = '<token_id>';
```

## Estrategia sem RLS agora

Neste MVP, a protecao fica no backend:

- token identifica uma unidade;
- queries usam `unit_id` do token;
- body nao aceita `unit_id`;
- endpoints de parceiro nao reutilizam endpoints admin.

RLS entra depois, quando houver login real por parceiro e mais de uma pessoa por unidade. Antes disso, RLS apressado aumenta risco de falsa seguranca.

## Caminho de evolucao

1. MVP parceiro com token por unidade.
2. Primeiro parceiro piloto usando no celular.
3. Ajustes de fluxo real.
4. Supabase Auth ou sessao propria.
5. RLS por `unit_id`.
6. Multiusuario por unidade.

## Decisao

Comecar agora com portal parceiro demonstravel e funcional, mas mantendo separacao forte:

- central/admin ve tudo;
- parceiro ve apenas a propria unidade;
- bot/shadow continua isolado.

## Integracao com o painel admin central - status 2026-05-20

O painel admin em `/admin/painel` tem a visao central da rede. A tela **Rede** deve consolidar tudo que cada parceiro registra no Portal Parceiro.

Endpoint central:

```text
GET /admin/api/dashboard/rede
```

Fonte de verdade da tela Rede:

- cadastro do parceiro: `network.partners`
- unidade do parceiro: `network.partner_units`
- resumo consolidado: `network.partner_unit_summary`
- vendas locais: `commerce.partner_orders`
- itens vendidos: `commerce.partner_order_items`
- estoque local: `commerce.partner_stock_levels`
- compras de pneus: `commerce.partner_purchases`
- despesas/folha/extras: `finance.partner_expenses`

Importante: depois da criacao do silo do parceiro, **venda local do parceiro nao entra em `commerce.orders`**. Ela entra em:

```text
commerce.partner_orders
commerce.partner_order_items
```

Portanto, qualquer ranking, grafico ou detalhe da Rede que represente parceiro deve ler `partner_orders`, nao `commerce.orders`.

### Migration de correcao do resumo

`db/migrations/0041_partner_summary_reads_partner_orders.sql`

Motivo: `network.partner_unit_summary` ainda somava vendas em `commerce.orders`. Apos a correcao, o resumo/financeiro da unidade soma `commerce.partner_orders`.

Validacao em `prod`, unidade `borracharia-rio-do-ouro`:

```text
sales_month: R$ 664,00
orders_month: 7
purchases_month: R$ 50,00
expenses_month: R$ 450,00
estimated_result_month: R$ 164,00
stock_items: 3
low_stock_items: 1
sales_2w: R$ 298,00 / 3 pedidos
sales_porta: R$ 366,00 / 4 pedidos
```

### O que o admin ja enxerga da unidade

A tela Rede do admin ja consegue receber pela API:

- vendas do mes;
- pedidos do mes;
- venda de hoje;
- compras de pneus;
- despesas;
- folha/funcionario;
- despesas extras;
- resultado estimado;
- origem das vendas do parceiro: 2W vs porta;
- estoque local completo;
- alertas de estoque baixo/zerado;
- ultimos lancamentos;
- pneus mais vendidos;
- serie de vendas dos ultimos 7 dias.

### Status da tela Rede em 2026-05-20

A tela Rede do admin deve mostrar somente dados reais vindos de `GET /admin/api/dashboard/rede`.

Removido da tela:

- filtro Diario/Semanal/Mensal que nao filtrava a API;
- botoes Exportar/Credenciar sem endpoint real;
- indicador de periodo "meta" no grafico consolidado.

Mantido como leitura real:

- faturamento, custos e resultado: mes atual;
- grafico de vendas: ultimos 7 dias;
- estoque: posicao atual;
- detalhe da unidade: cadastro, saude, 2W/porta, compras, folha, despesas, estoque e lancamentos.

### Indicadores adicionados em 2026-05-21

A tela Rede passou a ter indicadores operacionais mais fortes para a matriz acompanhar a saude dos parceiros:

- ticket medio da rede;
- conversao 2W da rede: vendas 2W / vendas totais;
- estoque total em quantidade e valor de custo estimado;
- grafico de origem das vendas: 2W vs porta;
- ranking/grafico de score de saude da unidade;
- ranking de dependencia da 2W por unidade;
- alertas reais: estoque critico, sem venda hoje, sem atualizacao, resultado negativo e alta dependencia 2W;
- filtros da lista de parceiros: Todos, Com alerta, Sem venda hoje, Sem atualizacao, Dependentes 2W e Score baixo;
- grafico de vendas consolidadas agora recebe tambem `order_series` para evolucao de pedidos dos ultimos 7 dias.

Score de saude da unidade, escala 0-100:

- resultado positivo: 20 pontos;
- vendeu hoje: 15 pontos;
- estoque atualizado ate 3 dias: 15 pontos;
- estoque sem item baixo/zerado: 15 pontos;
- margem estimada >= 20%: 15 pontos;
- custos/despesas registrados: 10 pontos;
- vendas 2W registradas: 10 pontos.

Faixas:

- 80-100: forte;
- 60-79: atencao;
- abaixo de 60: risco.

Esses indicadores continuam usando somente as tabelas do parceiro e nao leem/escrevem em tabelas do bot/Shadow.

### Periodos e meta da matriz em 2026-05-21

A rota `GET /admin/api/dashboard/rede` aceita filtro real por periodo:

```text
GET /admin/api/dashboard/rede?period=today
GET /admin/api/dashboard/rede?period=7d
GET /admin/api/dashboard/rede?period=30d
GET /admin/api/dashboard/rede?period=month
```

O periodo recalcula no banco:

- vendas consolidadas;
- pedidos;
- compras de pneus;
- folha/despesas;
- lucro estimado;
- origem 2W vs porta;
- pneus mais vendidos;
- serie diaria de vendas e pedidos.

Os filtros aparecem nos graficos:

- Vendas consolidadas da rede;
- Lucro estimado por unidade;
- Compras de pneus por unidade;
- Pneus mais vendidos da rede.

A matriz tambem pode definir uma meta de vendas do periodo na tela Rede. Essa meta fica salva no navegador local em `localStorage` como `farejador_rede_sales_goal`; ela nao altera o banco e nao interfere em dados do parceiro, bot ou Shadow.

### Cuidado operacional

O Portal Parceiro continua isolado:

- parceiro ve apenas a propria unidade pelo token;
- admin ve a rede toda;
- bot/shadow/Chatwoot continuam fora das tabelas `partner_*`;
- dados de parceiro nao devem ser usados como input do bot sem uma decisao explicita futura.

### Auditoria Rede vs Parceiro em 2026-05-21

Auditoria feita na unidade `borracharia-rio-do-ouro`, ambiente `prod`.

Comparacao correta:

- Portal Parceiro: resumo mensal da propria unidade.
- Admin Rede: usar filtro `period=month` para comparar com o Portal Parceiro.
- Filtros `today`, `7d` e `30d` existem apenas na matriz e recalculam a Rede por periodo.

Fontes cruzadas:

- `network.partner_unit_summary` usado pelo resumo do parceiro.
- Tabelas brutas: `commerce.partner_orders`, `commerce.partner_order_items`, `commerce.partner_stock_levels`, `commerce.partner_purchases`, `finance.partner_expenses`.
- `GET /admin/api/dashboard/rede?period=month`, via `getPainelRede('month')`.

Resultado da auditoria mensal:

```text
vendas: R$ 664,00
pedidos: 7
compras de pneus: R$ 50,00
despesas/folha: R$ 450,00
lucro estimado: R$ 164,00
origem 2W: R$ 298,00 / 3 pedidos
origem porta: R$ 366,00 / 4 pedidos
ticket medio: R$ 94,86
conversao 2W: 45%
estoque: 3 itens, 15 pneus, R$ 750,00 de custo estimado
alerta estoque baixo/zerado: 1
pneus mais vendidos: 90/90-18 (5), 80/100-18 (2)
score calculado: 85
```

Checks fechados:

- parceiro resumo vs tabelas brutas: OK;
- admin Rede mensal vs tabelas brutas: OK;
- admin Rede mensal vs parceiro resumo: OK nos campos equivalentes;
- 2W + porta soma o total de vendas: OK;
- pneus mais vendidos da Rede batem com os itens vendidos brutos: OK;
- estoque e alerta baixo/zerado batem com estoque bruto: OK.

Correcao feita durante a auditoria: alguns blocos visuais da Rede ainda assumiam serie fixa de 7 dias (`serieVendas[6]`) para calcular "vendeu hoje". Em periodo mensal isso podia baixar score e alerta indevidamente. A regra agora usa sempre o ultimo ponto da serie exibida.
