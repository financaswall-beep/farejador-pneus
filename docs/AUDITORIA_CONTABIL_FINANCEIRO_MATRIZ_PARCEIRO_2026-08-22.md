# Auditoria contábil de prosseguimento — Financeiro da Matriz e do parceiro

**Data:** 22/08/2026
**Escopo:** resultado por competência, caixa realizado, contas a receber e a
pagar, vendas à vista e fiadas, entregas, compras, despesas, cancelamentos,
inadimplência, recuperação, datas de reconhecimento e painéis da Matriz e do
parceiro.
**Estado deste documento:** auditoria, correção e regressão concluídas. A
migration `0200_finance_credit_lifecycle.sql` foi aplicada e reconciliada no
banco-alvo; o código correspondente ainda não foi implantado.

## 1. Veredito executivo

O erro de interpretação que originou a revisão foi esclarecido e a regra foi
mantida corretamente:

- venda fiada realizada entra no **resultado por competência** e em **A receber**;
- venda fiada não entra no **caixa** antes do recebimento;
- recebimento parcial aumenta somente o caixa pelo valor efetivamente recebido;
- calote deixa de sustentar lucro: a baixa reconhece perda e reduz a conta a
  receber, sem inventar entrada ou saída de caixa;
- recuperação posterior aumenta caixa e resultado como recuperação de crédito,
  sem recriar venda, custo ou estoque.

As fragilidades encontradas na primeira passagem foram corrigidas. O motor
contábil, as interfaces e as integrações estão **aprovados em código**. A
autorização operacional continua condicionada a implantar o mesmo código e
executar smoke autenticado nas duas interfaces.

## 2. Como ler os números da imagem auditada

Antes da terceira venda fiada, o painel mostrava resultado de R$ 824,58, caixa
de R$ 1.037,21 e R$ 90,00 a receber. A venda adicionou:

- receita por competência: R$ 45,00;
- custo conhecido: R$ 17,00;
- resultado por competência: R$ 28,00;
- contas a receber: R$ 45,00;
- caixa: R$ 0,00.

Por isso o resultado passou a R$ 852,58, o valor a receber a R$ 135,00 e o caixa
permaneceu em R$ 1.037,21. Essa matemática está correta. O painel agora chama o
número pelo nome explícito **Resultado por competência** e informa que pode
incluir vendas ainda não recebidas.

## 3. Correções implantadas no código

### 3.1 Crédito do parceiro

- Recebíveis criados por venda não podem mais ter origem, cliente, valor ou
  identidade alterados, nem ser apagados isoladamente.
- Recebimento pode ser parcial ou integral e conserva saldo aberto.
- Alterar vencimento virou renegociação explícita, exclusiva do dono e auditada.
- O dono pode dar baixa parcial ou total por inadimplência, sempre com motivo.
- Crédito baixado pode ser recuperado posteriormente por evento próprio.
- Repetir a mesma requisição é idempotente; reutilizar a chave com outro valor
  retorna conflito, evitando dupla baixa.

### 3.2 Contas a pagar do parceiro

- Pagamentos podem ser parciais.
- Resultado por competência conserva o valor integral da obrigação.
- Caixa muda somente pelo pagamento efetivo.
- A quitação final mantém compatibilidade com o histórico sem duplicar despesa.

### 3.3 Crédito e obrigações da Matriz

- Recebíveis do varejo e atacado e obrigações de compra aceitam baixa parcial.
- Venda de atacado sincroniza o pagamento real com a conta correspondente do
  parceiro, pelo mesmo valor.
- O dono pode reconhecer perda parcial ou integral no livro central.
- A perda contabiliza débito em despesa de inadimplência e crédito em contas a
  receber; o lançamento permanece balanceado e auditável.

### 3.4 Caixa, COD, datas e relatórios

- Venda fiada sem recebimento fica fora do caixa.
- Venda COD entregue entra no caixa mesmo que o campo operacional ainda use
  `A receber`, desde que não exista recebível vinculado.
- Quando há recebível vinculado, o resumo usa o evento financeiro e não conta a
  venda novamente; a duplicidade de R$ 259,90 deixa de ser possível no cálculo.
- O relatório “Caixa do período” passou a usar recebimentos e pagamentos reais.
- Estornos devolvidos aparecem separados, sem serem mascarados como despesa.
- Venda de varejo entregue é reconhecida por `delivered_at`, inclusive na virada
  do mês, mantendo Vendas, Financeiro e reconciliação no mesmo período.
- Score com caixa zero não recebe mais bônus de caixa positivo.

## 4. Proteções de banco da migration 0200

A migration cria um ciclo financeiro baseado em eventos imutáveis:

- `finance.partner_receivable_events`: recebimento, perda, recuperação e estorno;
- `finance.partner_payable_events`: pagamentos realizados;
- `finance.partner_order_refunds`: devoluções financeiras de pedidos;
- visões efetivas com valor recebido, pago, perdido e saldo aberto;
- triggers contra excesso de pagamento, excesso de perda, recuperação superior
  ao valor baixado e estorno superior ao recebido;
- sincronização controlada dos estados dos documentos e parcelas;
- RLS por ambiente e unidade, proteção de data futura e trilha de auditoria;
- atualização do resumo financeiro do parceiro e do ledger central.

A alteração é aditiva e preserva documentos históricos. Os gatilhos de
compatibilidade traduzem baixas legadas para eventos quando necessário.

## 5. Baterias executadas após as correções

| Bateria | Resultado |
|---|---:|
| TypeScript | aprovado |
| Build de produção | aprovado |
| Unitários completos | **1.291/1.291**, 260 arquivos |
| Integração PostgreSQL completa | **276/276**, 55 arquivos |
| Migrations | **201 verificadas**, última `0200`; gap histórico `0071` documentado |
| Prova do painel parceiro | **599 propriedades** |
| Prova do painel Matriz | **1.105 propriedades** |
| Contratos de rede do parceiro | **95 contratos** |
| Rotas da Matriz | **243 rotas** |
| Fiscal de tamanho | aprovado |
| `git diff --check` | aprovado |

Os cenários contábeis específicos provam:

1. venda fiada reconhece competência e não cria caixa;
2. recebimento parcial de R$ 50,00 deixa R$ 100,00 em aberto;
3. baixa de R$ 100,00 reduz resultado sem movimentar caixa;
4. recuperação de R$ 20,00 aumenta caixa e resultado de recuperação;
5. obrigação de R$ 90,00 paga em R$ 30,00 + R$ 60,00 conserva competência,
   acumula caixa corretamente e não duplica despesa;
6. recebimento parcial e perda da Matriz zeram a obrigação e mantêm o ledger
   balanceado;
7. retry idempotente não duplica dinheiro e conflito de valor é recusado.

## 6. Situação dos achados originais

| Achado original | Situação pós-correção |
|---|---|
| Recebível de venda editável/excluível | resolvido na API e no banco |
| Ausência de baixa por inadimplência | resolvido na Matriz e parceiro |
| Atacado somente com quitação integral | resolvido com baixa parcial |
| COD contado junto com recebimento | cálculo deduplicado pela origem financeira |
| “Caixa” do relatório era competência | resolvido; agora usa dinheiro realizado |
| Entrega em mês diferente | resolvido com data de entrega |
| Score elogiava caixa zero | resolvido |
| Rótulos confundiam resultado e caixa | resolvido |

## 7. Decisão de release

**Código:** aprovado.
**Banco descartável/migration:** aprovado.
**Banco-alvo:** `0200` aplicada e reconciliada.
**Deploy:** pendente; o banco já está preparado.
**Pós-deploy:** smoke autenticado obrigatório em Matriz e parceiro.

O backup `farejador-prod-pre-0200-20260822-155942.dump` foi validado com
3.540.280 bytes, 2.741 entradas restauráveis e SHA-256
`4201d8ab2fd3eead8b1876a4491bed1d25065cd95591f80d29ccabfd6bb0f8ff`.
O primeiro dry-run detectou e reverteu uma incompatibilidade no backfill de uma
conta histórica ligada à Matriz; a correção manteve o parceiro bloqueado e
permitiu somente a ponte controlada da Matriz. O segundo dry-run passou e foi
revertido integralmente. A execução seguinte terminou com `COMMIT`.

A reconciliação pós-commit confirmou marcador 200, cinco relações, 23 triggers,
três tabelas com RLS, três constraints, zero privilégio público, zero saldo
negativo, zero título fechado com saldo e zero transação desbalanceada. Foram
convertidos para eventos três recebimentos e dois pagamentos históricos, sem
alterar os valores econômicos. Até o runtime correspondente ser implantado, a
interface publicada continua no comportamento anterior.
