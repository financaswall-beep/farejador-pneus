# Dossiê de autorização — Bot, Vendas e Compras

**Data da revisão:** 17/08/2026
**Escopo:** painel da Matriz, APIs, banco, permissões e relações entre Bot, Conversas, Visão Geral, Demanda, Vendas, Compras, Estoque, Catálogo, Logística e Financeiro.
**Produção:** backup validado e migrations 0179–0181 aplicadas em 17/08/2026. As migrations 0177–0178 já estavam instaladas. Nenhum deploy foi iniciado por esta auditoria.

## Como ler o veredito

- **Aprovado em código:** implementação, migrations e testes locais estão coerentes.
- **Aprovado no ambiente:** migrations foram aplicadas no banco-alvo e o smoke pós-deploy passou.
- **Autorizado para produção:** decisão final do responsável, tomada somente depois dos dois itens anteriores.

Uma aprovação em código não substitui backup, migrations, deploy, smoke e conferência somente leitura dos dados reais.

## 1. Auditoria do Bot da Matriz

### Relações verificadas

| Origem/destino | O que a relação faz | Proteção verificada |
|---|---|---|
| Chatwoot → `raw.*` → `core.conversations/messages` | Recebe e normaliza conversas e mensagens | HMAC, timestamp, deduplicação, raw-first e separação por `environment` |
| `agent.turns` → `analytics.*` | O trigger analítico extrai fatos, classificações e sinais determinísticos depois do turno | Analytics separado de raw/core; falha analítica não altera o dado operacional |
| Bot → Visão Geral/Conversas | Mostra volume, respostas, escaladas, abandono, tempo e custo | Consultas somente leitura e filtradas por `environment` |
| Bot → Vendas | Liga pedido à conversa e calcula conversão/faturamento | Pedido cancelado não conta; conversa, contato e ambiente precisam ser compatíveis |
| Bot → Demanda | Usa município, medida consultada, falta de estoque, funil e motivo de perda | Proveniência em `analytics.*` e contagem por conversa |
| Bot → Estoque | Cruza medidas pedidas/faltantes com o saldo oficial do galpão | Leitura do estoque por ambiente; Bot não altera estoque |
| Painel/API | Entrega campainha e visão analítica ao administrador | Rotas autenticadas; nenhuma permissão de parceiro para dados sensíveis da Matriz |

### Problema encontrado e correção

Em um banco criado do zero, a view diária usada pelos cards podia não existir porque uma migration antiga dependia de uma view histórica. A migration `0177_bot_daily_metrics_fresh_schema.sql` passou a criar a view diretamente das tabelas atuais, pode ser reaplicada com segurança, separa `prod` de `test` e exclui pedido cancelado do faturamento.

### Provas principais

- Banco limpo cria e recria `analytics.v_daily_metrics`.
- Quatro conversas de teste produzem contagens distintas de venda, escalada e abandono.
- Pedido entregue entra no faturamento; pedido cancelado não entra.
- Linha de `prod` não se mistura com as linhas de `test`.
- Bot permanece somente leitura em Estoque, Vendas e Financeiro.

**Veredito da seção:** **APROVADO EM CÓDIGO.** A aprovação no ambiente depende de confirmar a migration 0177 e executar o smoke da aba Bot depois do deploy.

## 2. Auditorias funcional e matemática de Vendas da Matriz e do app

### Relações verificadas

| Relação | O que foi conferido |
|---|---|
| Tela/app → API | Valores e datas são revalidados no servidor; alteração administrativa exige dono |
| API → Banco | Operações críticas são transacionais e idempotentes; constraints impedem estados impossíveis |
| Vendas → Conversas/Clientes | Pedido originado no Chatwoot só aceita o contato da própria conversa e o mesmo ambiente |
| Vendas → Estoque | Venda trava somente as medidas envolvidas, baixa o saldo oficial e impede disputa da última unidade |
| Vendas → Financeiro | Receita, custo, recebível/caixa, cancelamento e ledger usam a mesma venda causal |
| Vendas → Logística | Entrega e retirada usam o pedido canônico; venda de balcão também aparece corretamente quando tem entrega |
| Vendas → Relatórios | Somente venda confirmada fatura; filtros usam a data da venda e históricos não truncam após 50 linhas |
| App → Matriz | O app grava nas mesmas entidades canônicas e respeita token, vendedor, unidade e módulos autorizados |

### Problemas corrigidos

- Mistura de pedido/unidade entre `prod` e `test` foi bloqueada no banco.
- Conversa ligada ao contato errado foi bloqueada no banco.
- Desconto maior que o valor da linha foi bloqueado.
- Venda e recebimento com data futura foram bloqueados na tela, servidor e banco.
- O vencimento de uma venda **a receber** continua podendo ser futuro; ele não é uma venda futura, é uma dívida a vencer. A tela atual registra um vencimento único, não um carnê com várias parcelas.
- A baixa de varejo deixou de travar o galpão inteiro e passou a travar somente as medidas pedidas.
- Mutações administrativas de atacado, fiado e pedidos foram restringidas ao dono.
- Históricos e resumos passaram a usar a competência correta e a contar somente estados válidos.
- Preço, desconto, linha e total passaram a ser calculados em centavos inteiros, com limites compatíveis com os campos do banco; frações de centavo e estouros são recusados.
- O banco confere que o cabeçalho da venda de varejo é exatamente a soma de seus itens. Agenda financeira, quitação parcial, comissão, frete e consolidação mensal também deixaram de depender da soma binária do JavaScript.
- Pedido `open`/`pending` deixou de ser tratado como venda concluída em comissão, folha, Caixa, CRM, Marketing, reconciliação e indicadores. Somente `confirmed`, `paid` e `delivered` realizam venda de varejo.
- O atacado passou a usar `sold_at` — a data em que vendeu — em competência, comissão e relatórios, mesmo quando a digitação ocorreu em outro mês.

As guardas de banco estão nas migrations `0178_matriz_sales_integrity.sql`, `0179_matriz_sales_final_guards.sql` e `0181_matriz_sales_math_audit.sql`.

### Provas principais

- Banco rejeita ambiente cruzado, contato alheio, desconto impossível e datas inválidas.
- Venda de balcão atualiza pedido, item, cliente, vendedor, estoque, movimento e financeiro na mesma operação.
- Duas vendas concorrentes da última unidade não conseguem vender duas vezes.
- Cancelamento devolve estoque e estorna os efeitos financeiros sem apagar o histórico.
- App e painel respeitam permissões por módulo e identidade do vendedor.
- A soma de 3 × R$ 19,99 com desconto de R$ 0,02 mais 2 × R$ 0,10 resulta exatamente em R$ 60,15 no varejo; no atacado, sem o desconto, resulta em R$ 60,17.
- Comissão de 2,5% sobre R$ 60,17 resulta em R$ 1,50 pela regra de arredondamento monetário.
- Venda aberta de R$ 77,77 resulta em zero faturamento, zero comissão e zero compras no perfil do cliente.
- A função de reconciliação matemática detecta cabeçalho divergente e todas as suas métricas voltam a zero no banco limpo.

**Veredito da seção:** **APROVADO EM CÓDIGO E NA AUDITORIA MATEMÁTICA LOCAL.** A aprovação no ambiente depende de confirmar as migrations 0178/0179/0181 e executar smoke de varejo, atacado, fiado, cancelamento, estoque, financeiro e logística.

## 3. Auditorias funcional e matemática de Compras

### Relações verificadas

| Relação | O que foi conferido |
|---|---|
| Compras → Fornecedores | Cadastro, histórico, arquivamento e vínculo das linhas |
| Compras → Estoque | Recebimento, quantidade, variante, custo médio, movimentos, cancelamento e correção de condição |
| Compras → Financeiro | À vista, a prazo, trânsito, recebimento, obrigação, pagamento, cancelamento e ledger |
| Compras → Catálogo/Vendas | Estoque físico pode existir antes do produto comercial; a resposta informa bloqueio de produto/preço e Vendas continua recusando item não catalogado |
| Compras → Relatórios | Total, ranking, preço por medida, capital parado e giro de reposição |
| Tela → API → Banco | Validação em três camadas para datas, valores e permissão |

### Correções funcionais

1. O cancelamento da sequência **em trânsito → recebido → cancelado sem pagar** agora estorna tanto a obrigação quanto a transferência de trânsito para estoque. O gate de reconciliação detecta qualquer metade ausente desse estorno.
2. Compra e pagamento futuros são recusados; vencimento futuro continua permitido e não pode ser anterior à data da compra.
3. Criar, confirmar, cancelar e arquivar compra/fornecedor exige perfil de dono; outros administradores permanecem somente leitura.
4. O giro usa todas as saídas dos últimos 30 dias, não apenas os 50 movimentos mais recentes.
5. Recebimento sem produto ou preço correspondente devolve um aviso estruturado de Catálogo. O fato físico não é escondido, mas a venda permanece bloqueada até completar produto e preço.

### Correções matemáticas

1. O custo médio ponderado passou a ser armazenado com seis casas decimais. Exemplo provado: uma unidade a R$ 0,01 mais uma a R$ 0,02 resulta em custo médio R$ 0,015000 e valor total R$ 0,03.
2. Todos os caminhos de entrada e transferência entre condições usam a mesma precisão de seis casas.
3. Valores lançados no ledger continuam em centavos e usam arredondamento decimal determinístico, inclusive em casos de meio centavo como R$ 2,135.
4. A API aceita custo unitário com no máximo duas casas, impede estouro por linha e impede total acima do limite do campo `NUMERIC(12,2)`.
5. O cancelamento compara o custo com tolerância compatível com as seis casas, sem aceitar alteração posterior indevida.

As guardas e o reparo de dados históricos estão na migration `0180_wholesale_purchase_audit_guards.sql`.

### Provas principais

- Compra recebida e paga: estoque contra caixa uma única vez.
- Compra em trânsito: obrigação, recebimento e quitação na ordem correta.
- Cancelamento não pago: obrigação zerada sem apagar o lançamento original.
- Cancelamento após trânsito e recebimento: estoque, trânsito e obrigação terminam zerados.
- Cancelamento já pago: caixa é preservado e nasce valor a recuperar.
- Custo subcentavo, aviso de Catálogo, datas protegidas e mais de 50 movimentos no giro foram testados em PostgreSQL real e descartável.
- Testes de interface comprovam modo somente leitura para não-dono e uso do `sales_30d` calculado no servidor.

**Veredito da seção:** **APROVADO EM CÓDIGO.** A aprovação no ambiente depende de confirmar a migration 0180 e executar o smoke de Compras, Estoque, Catálogo e Financeiro depois do deploy.

## 4. Evidência consolidada desta revisão

| Bateria | Resultado em 17/08/2026 |
|---|---|
| TypeScript | Aprovado |
| Unitários | **1.147/1.147 aprovados**, em 221 arquivos |
| Integrações matemáticas novas de Vendas | **4/4 aprovadas** em PostgreSQL real e descartável |
| Migrations | Manifesto íntegro, 182 arquivos, última `0181`, gap histórico 0071 documentado |
| Regressão completa com PostgreSQL | **231/231 aprovadas**, em 44 arquivos (230 na execução completa e a única expectativa antiga revalidada isoladamente após correção) |
| Build/provas estáticas | Build e TypeScript aprovados; 232 rotas, 92 contratos e paridade das interfaces aprovados; fiscal de tamanho aprovado |
| Navegador pós-deploy | Não executado; depende do deploy feito pelo responsável |
| Produção somente leitura | **PASS** no gate geral depois das migrations; ledger, estoque/financeiro, ingestão, normalização, isolamento e acesso sem divergências. A reconciliação matemática de Vendas encontrou 2 registros históricos de teste, de R$ 0,00, sem itens e sem ledger, descritos na seção 7 |

## 5. Condições obrigatórias antes da autorização

1. [x] Fazer backup restaurável do banco.
2. [x] Confirmar no banco-alvo quais migrations já foram aplicadas.
3. [x] Aplicar somente as migrations pendentes, na ordem do manifesto; 0177–0178 já estavam presentes e 0179–0181 foram aplicadas.
4. [ ] Executar o deploy do SHA publicado pelo responsável.
5. [ ] Rodar smoke pós-deploy de Bot, Vendas, Compras, Estoque, Catálogo, Financeiro e Logística.
6. [ ] Repetir a reconciliação financeira, de estoque e matemática em modo somente leitura após o deploy.
7. [ ] Confirmar que o Coolify realmente importou o SHA esperado e não reutilizou imagem antiga.

## 6. Decisão final

**Decisão técnica atual:** **MIGRATIONS CONCLUÍDAS; AUTORIZADO PARA DEPLOY CONTROLADO; PRODUÇÃO AINDA NÃO HOMOLOGADA.**
**Motivo:** o código das três seções passou pela regressão completa e as migrations foram aplicadas com backup e auditoria posterior. A homologação final ainda exige deploy, smoke pós-deploy e decisão explícita sobre 2 registros históricos de teste que não têm efeito financeiro ou de estoque, mas impedem o resultado zero absoluto da reconciliação matemática.

Após cumprir as condições acima, registrar uma opção:

- [ ] **AUTORIZO** a entrada em produção do escopo Bot + Vendas + Compras.
- [ ] **NÃO AUTORIZO**; há bloqueadores descritos abaixo.

**SHA implantado:** ______________________________
**Data/hora do smoke:** __________________________
**Responsável:** __________________________________
**Observações/bloqueadores:** ______________________

## 7. Continuidade operacional para o próximo agente

### Estado entregue

- As auditorias de Bot, Vendas e Compras estão encerradas em código e em banco descartável.
- O backup pré-migration `farejador-prod-pre-0179-0181-20260817-104359.dump` foi validado com 2.484 entradas restauráveis, 4.791.576 bytes e SHA-256 `50893A7A93855BFEC4943373205F9F67B84806CE0A9C83ED9632DBD2F44C002C`.
- As migrations 0177–0178 já estavam materialmente instaladas. As migrations 0179, 0180 e 0181 passaram em dry-run e foram aplicadas em transações individuais com `COMMIT`.
- A auditoria geral somente leitura depois das migrations retornou `PASS`: 0 ledger desbalanceado, 0 falha de reconciliação financeira/estoque, 0 mistura de ambiente e 0 falha de ingestão/normalização.
- Nenhum deploy foi iniciado por esta auditoria.
- Arquivos locais de protótipos, scripts avulsos e documentos históricos não fazem parte do pacote de publicação.
- A etapa atual da ordem oficial é: **deploy → smoke → reconciliação somente leitura → homologação**.

### Exceção histórica revelada pela auditoria matemática

O gate de Vendas retornou zero em quatro das cinco métricas. A métrica `retail_realized_without_items` retornou 2 por causa de dois registros de 01/08/2026 que já existiam antes das migrations:

- ambos pertencem a contatos com identificação de teste;
- ambos são entregas manuais de R$ 0,00, sem item, sem ledger e sem efeito em estoque, caixa, comissão ou contas;
- estão ligados às rotas históricas `ROTA-0074` e `ROTA-0075`;
- não foram alterados automaticamente, para preservar a trilha logística e evitar uma correção destrutiva sem autorização.

Essa exceção não bloqueia o início do deploy controlado, pois não representa divergência monetária nem regressão criada pela entrega. Ela bloqueia a **homologação final com zero absoluto** até ser formalmente aceita ou corrigida por uma operação de reparo auditável.

### Pacote de banco

Aplicar somente o que estiver pendente no banco-alvo e sempre na ordem do manifesto:

1. `0177_bot_daily_metrics_fresh_schema.sql`
2. `0178_matriz_sales_integrity.sql`
3. `0179_matriz_sales_final_guards.sql`
4. `0180_wholesale_purchase_audit_guards.sql`
5. `0181_matriz_sales_math_audit.sql`

Não reaplicar migration já registrada sem antes conferir o mecanismo de histórico do ambiente. Em rollback do aplicativo, preservar as migrations: 0179–0181 são guardas aditivas/compatíveis e desfazê-las retiraria proteções de dados.

### Smoke obrigatório depois do deploy

1. Abrir Bot, Vendas e Compras no painel da Matriz em celular e desktop.
2. Criar uma venda controlada de varejo e outra de atacado; conferir item, cabeçalho, estoque, Caixa/recebível, comissão e competência.
3. Criar uma compra controlada; conferir fornecedor, estoque ou trânsito, obrigação/caixa e cancelamento.
4. Confirmar que pedido aberto não aparece como faturamento ou comissão.
5. Executar em modo somente leitura e exigir zero em todas as métricas:

```sql
SELECT *
FROM commerce.matriz_sales_math_reconciliation('prod'::env_t);

SELECT finance.matriz_stage3_ledger_reconciliation('prod'::env_t);
SELECT finance.matriz_stage3_ledger_amount_mismatches('prod'::env_t);
SELECT finance.matriz_stage3_ledger_orphans('prod'::env_t);
SELECT finance.matriz_stage3_ledger_duplicates('prod'::env_t);
```

Se qualquer resultado for diferente de zero, não homologar produção: manter o aplicativo na versão segura, preservar o banco e investigar o registro causal indicado pela reconciliação.

### Evidência reproduzível

```text
npm run build
npm run typecheck
npm test
npm run test:integration
npm run check:migrations
npm run prova-painel
```

Resultados desta entrega: build e TypeScript aprovados; 1.147/1.147 testes unitários; 231/231 integrações válidas; 182 migrations verificadas; 232 rotas, 92 contratos e fiscal de tamanho aprovados.
