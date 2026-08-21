# Dossiê de autorização — Bot, Vendas, Compras, Estoque e Financeiro

**Data da revisão:** 20/08/2026
**Escopo:** painel da Matriz, APIs, banco, permissões e relações entre Bot, Conversas, Visão Geral, Demanda, Vendas, Compras, Estoque, Catálogo, Logística e Financeiro.
**Produção implantada:** backup validado; migrations 0179–0181 aplicadas; 0177–0178 já instaladas; deploy do SHA `d95b146e30de1e1527951370df8b53a3f71e8310` concluído no Coolify em 17/08/2026; smoke técnico e auditoria somente leitura aprovados.

**Pacote atual de banco:** Estoque foi implantado inicialmente no SHA `6690c46c15bf11013eea3731ad9bb6ed747b7028`. As evoluções `0182`–`0190` estão materialmente presentes no banco; a `0190` foi aplicada e reconciliada em 20/08/2026. O runtime correspondente ao pacote financeiro ainda aguarda o próximo deploy.

**Atualização de continuidade em 20/08/2026:** o repositório está em `main` no SHA
`2064f1a`. A migration `0189_checkout_price_negotiation.sql` foi confirmada
**materialmente no banco de produção**, por consulta `REPEATABLE READ READ ONLY`: as duas
colunas `reference_unit_price NUMERIC(10,2) NOT NULL`, as duas constraints, os dois triggers
e o preenchimento sem nulos estão presentes. A tabela
`supabase_migrations.schema_migrations`, porém, não registra a `0189` e está atrasada até a
`0167`; por isso a `0189` não deve ser reaplicada. O deploy do SHA atual e o smoke autenticado
continuam dependendo de evidência própria e não são presumidos por essa verificação de schema.

**Auditoria atual do Financeiro:** concluída em código em 20/08/2026. O relatório completo
está em `docs/AUDITORIA_FINANCEIRO_PONTA_A_PONTA_2026-08-20.md`. A migration `0190` foi
aplicada com backup e reconciliação `PASS`; o código foi incorporado pela PR `#61` à `main`
no SHA `92ae93d73a33780adf801b0e2a33fb16a7f78906`. A aprovação atual cobre código e banco,
mas ainda não substitui o deploy e o smoke pós-deploy.

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
| Smoke técnico pós-deploy | **Aprovado**: Coolify importou o SHA esperado; imagem nova construída; rolling update concluído; `/livez`, `/readyz` e `/healthz` responderam 200 com o SHA implantado; painel e módulos de Vendas/Compras responderam 200; mobile antigo do parceiro redirecionou para `/operacao` e o manifesto aposentado respondeu 404 |
| Navegador autenticado pós-deploy | Pendente: o controle visual do navegador não iniciou no ambiente do Codex. Nenhuma credencial foi contornada; as APIs protegidas recusaram acesso sem sessão normal |
| Produção somente leitura | **PASS** depois do deploy; ledger, estoque/financeiro, ingestão, normalização, isolamento e acesso sem divergências. Reconciliações do ledger: 0 divergência de valor, 0 órfão e 0 duplicidade. A reconciliação matemática de Vendas manteve apenas 2 registros históricos de teste, de R$ 0,00, sem itens e sem ledger, descritos na seção 7 |

## 5. Condições obrigatórias antes da autorização

1. [x] Fazer backup restaurável do banco.
2. [x] Confirmar no banco-alvo quais migrations já foram aplicadas.
3. [x] Aplicar somente as migrations pendentes, na ordem do manifesto; 0177–0178 já estavam presentes e 0179–0181 foram aplicadas.
4. [x] Executar o deploy do SHA publicado pelo responsável.
5. [ ] Concluir o smoke **autenticado e visual** de Bot, Vendas, Compras, Estoque, Catálogo, Financeiro e Logística; o smoke técnico público já foi aprovado.
6. [x] Repetir a reconciliação financeira, de estoque e matemática em modo somente leitura após o deploy.
7. [x] Confirmar que o Coolify realmente importou o SHA esperado e não reutilizou imagem antiga.

## 6. Decisão final

> Esta decisão registra o deploy anterior de Bot + Vendas + Compras. Para a decisão atual que inclui Estoque, prevalece a seção 8.

**Decisão técnica atual:** **DEPLOY TÉCNICO APROVADO; PRODUÇÃO AINDA NÃO HOMOLOGADA EM DEFINITIVO.**
**Motivo:** código, migrations, CI, construção da imagem, saúde do container e reconciliações pós-deploy foram aprovados. A homologação final ainda exige o smoke visual com uma sessão normal de usuário e a decisão explícita sobre 2 registros históricos de teste que não têm efeito financeiro ou de estoque, mas impedem o resultado zero absoluto da reconciliação matemática.

Após cumprir as condições acima, registrar uma opção:

- [ ] **AUTORIZO** a entrada em produção do escopo Bot + Vendas + Compras.
- [ ] **NÃO AUTORIZO**; há bloqueadores descritos abaixo.

**SHA implantado:** `d95b146e30de1e1527951370df8b53a3f71e8310`
**Data/hora do deploy:** 17/08/2026, 14:05–14:06 (America/Sao_Paulo)
**Responsável pelo deploy:** responsável do sistema, via Coolify
**Observações/bloqueadores:** smoke técnico aprovado; smoke visual autenticado pendente; 2 registros históricos de teste documentados sem impacto monetário.

## 7. Continuidade operacional para o próximo agente

### Estado entregue

- As auditorias de Bot, Vendas e Compras estão encerradas em código e em banco descartável.
- O backup pré-migration `farejador-prod-pre-0179-0181-20260817-104359.dump` foi validado com 2.484 entradas restauráveis, 4.791.576 bytes e SHA-256 `50893A7A93855BFEC4943373205F9F67B84806CE0A9C83ED9632DBD2F44C002C`.
- As migrations 0177–0178 já estavam materialmente instaladas. As migrations 0179, 0180 e 0181 passaram em dry-run e foram aplicadas em transações individuais com `COMMIT`.
- A auditoria geral somente leitura depois das migrations retornou `PASS`: 0 ledger desbalanceado, 0 falha de reconciliação financeira/estoque, 0 mistura de ambiente e 0 falha de ingestão/normalização.
- O deploy foi executado pelo responsável no Coolify. A imagem foi construída para o SHA `d95b146e30de1e1527951370df8b53a3f71e8310`; o novo container iniciou e o rolling update terminou sem erro.
- Arquivos locais de protótipos, scripts avulsos e documentos históricos não fazem parte do pacote de publicação.
- O smoke técnico público e a reconciliação somente leitura foram concluídos. A etapa atual é: **smoke visual autenticado → decisão sobre a exceção histórica → homologação**.

### Evidência pós-deploy

- `/livez`, `/readyz` e `/healthz`: HTTP 200 e SHA implantado correto; readiness confirmou banco, schema e conexão do aplicativo de parceiros.
- `/admin/painel`, módulo novo de marcas de Vendas e módulo de Compras: HTTP 200.
- Mobile legado dos parceiros: HTTP 302 para `/operacao`; `manifest.webmanifest` aposentado: HTTP 404.
- Gate geral somente leitura: `PASS`, com 113 eventos processados nas últimas 24 horas, 0 pendência antiga, 0 falha recente e 0 duplicidade de delivery.
- Ledger: 317 transações, 0 desbalanceada, 0 divergência de ambiente, 0 divergência de valor, 0 órfão e 0 duplicidade.
- Reconciliação de Vendas: quatro métricas zeradas; somente `retail_realized_without_items=2`, correspondente à exceção histórica já identificada.
- O aviso do Coolify sobre `NODE_ENV=production` não afetou a entrega: o `Dockerfile` força `NODE_ENV=development` no estágio de build, instala `devDependencies`, executa o build com sucesso e usa produção apenas no estágio final de runtime.

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
6. `0182_stock_end_to_end_integrity.sql` — pendente para o pacote de Estoque
7. `0183_matrix_partner_stock_transfer.sql` — pendente para a venda/remessa da Matriz ao parceiro
8. `0184_partner_arrival_item_adjustments.sql` — pendente para o acerto individual, carga em trânsito e redirecionamento

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

Resultados da entrega já implantada: build e TypeScript aprovados; 1.147/1.147 testes unitários; 231/231 integrações válidas; 182 migrations verificadas; 232 rotas, 92 contratos e fiscal de tamanho aprovados.

## 8. Adendo — auditoria integral do Estoque

O relatório detalhado está em `docs/AUDITORIA_ESTOQUE_PONTA_A_PONTA_2026-08-17.md`.

### Relações fechadas

- Matriz: galpão oficial, filme, Vendas de varejo/atacado, Compras, Financeiro, Logística, Catálogo, Bot e Demanda.
- Parceiros: estoque local, venda, reserva, compra pendente, recebimento pelo app Operação, cancelamento e custo congelado.
- Banco: ambiente, unidade, RLS, identidade da variante, idempotência, datas, total da compra, reservas, custo médio e trilha imutável.

### Correções centrais

- Saldo disponível substituiu saldo físico nos pontos de decisão de venda, reposição e status.
- Cancelamento da compra do parceiro passou a reverter quantidade **e** custo médio.
- Item recebido passou a guardar a ficha exata de estoque e snapshots antes/depois; o banco bloqueia vínculo com outra loja.
- Cabeçalho de compra passou a fechar com a soma dos itens em centavos no servidor e no banco.
- Inativação com saldo/reserva, compra futura e contagem abaixo da reserva passaram a ser recusadas.
- Remoção e ajuste do galpão passaram a exigir dono, motivo, auditoria, idempotência e conciliação financeira.
- A migration `0182` reconstrói somente as duas aberturas da Matriz comprovadas matematicamente.
- A migration `0183` transforma a venda de atacado da Matriz para um parceiro em uma remessa pendente no app da loja, na mesma transação.
- Um pedido que já saiu pode receber acréscimos sem reescrever a venda original: cada extra fica ligado ao pedido raiz, baixa a Matriz ao ser registrado e tem recebimento e financeiro próprios.
- Documento originado na Matriz não pode ser editado, excluído ou quitado manualmente pelo parceiro; o app da loja confirma somente a quantidade física recebida.
- Cancelar um extra ainda pendente devolve suas unidades à Matriz e cancela compra/conta espelhadas; pedido recebido ou pago bloqueia devolução automática duplicada.
- A migration `0184` permite aceitar ou recusar quantidades por linha na chegada; retirar 1 de uma linha com 10 não cancela os outros 9.
- O pneu recusado continua como carga em trânsito e não reaparece no saldo da Matriz antes do retorno físico.
- A carga recusada pode ser incluída no pedido de outro parceiro sem baixar a Matriz novamente; origem, custo e quantidade ficam auditados.
- Venda, compra espelhada, conta a pagar, relatórios e comissão usam somente as quantidades aceitas.
- O parceiro só recebe depois do acerto da Matriz e deve confirmar exatamente as quantidades finais.

### Evidência atual

| Bateria | Resultado |
|---|---|
| Unitários completos | **1.194/1.194**, 234 arquivos |
| Build e TypeScript | Aprovados |
| Migration `0182` | Dry-run aprovado em `test` e `prod`, ambos com rollback |
| Prova matemática `0182` | **15/15** em PostgreSQL real, com rollback |
| Migration/ponte `0183` | **17/17** em PostgreSQL real: venda, extra, recebimento, finanças, cancelamento e conservação; rollback |
| Migration/acerto `0184` | PostgreSQL real: 31 pneus conservados, recusa individual, redirecionamento, retorno físico, financeiro e rollback aprovados |
| Regressão direcionada `0183` | **43/43** |
| Filme da Matriz | M1–M17 aprovado; limpeza posterior confirmada |
| Manifesto | 185 migrations, última `0184`, gap 0071 documentado |
| Painéis/contratos | 582 propriedades do parceiro, 1.053 da Matriz, 92 contratos e 236 rotas |
| Produção somente leitura | Sem negativo, reserva inválida, custo ausente, identidade duplicada ou ledger desbalanceado |

A suíte Testcontainers completa desta revisão ficou pendente porque o backend do Docker Desktop local não criou o pipe do engine. Os caminhos críticos de Estoque foram substituídos por provas transacionais no PostgreSQL real; essa limitação não está sendo escondida nem contada como teste aprovado.

### Decisão consolidada atual

**Bot + Vendas + Compras:** entrega anterior implantada e tecnicamente aprovada, ainda sujeita ao smoke visual autenticado já documentado.

**Estoque:** **APROVADO EM CÓDIGO E MATEMÁTICA; AINDA NÃO AUTORIZADO EM PRODUÇÃO.**

Pendências obrigatórias do Estoque:

1. [ ] Backup restaurável imediatamente antes da migration.
2. [ ] Publicar o código auditado e registrar o SHA definitivo.
3. [ ] Aplicar, nesta ordem, `0182_stock_end_to_end_integrity.sql`, `0183_matrix_partner_stock_transfer.sql` e `0184_partner_arrival_item_adjustments.sql`, antes do aplicativo novo.
4. [ ] Fazer o deploy do mesmo SHA no Coolify.
5. [ ] Executar smoke autenticado de Estoque, Vendas, Compras, Financeiro, Logística, Catálogo e app Operação, incluindo recusa de apenas um pneu, inclusão de carga de outro parceiro, retorno físico e recebimento exato.
6. [ ] Repetir a reconciliação somente leitura e exigir zero divergência.

- [ ] **AUTORIZO** a entrada em produção do escopo Bot + Vendas + Compras + Estoque.
- [ ] **NÃO AUTORIZO**; registrar o bloqueador observado.

## 9. Adendo — dia comercial único da Matriz e dos parceiros

### Causa e regra adotada

Campos de calendário da interface representavam um **dia**, mas algumas telas os convertiam
para meio-dia. Nas primeiras horas do dia, esse meio-dia ainda estava algumas horas no futuro e
uma proteção baseada no relógio podia recusar uma operação legítima de hoje.

A regra passou a ser única em `America/Sao_Paulo`:

- venda, compra, despesa, documento, pagamento, recebimento e baixa representam fatos já
  ocorridos; aceitam hoje ou passado e recusam um dia realmente futuro;
- quando a tela escolhe **hoje**, o sistema grava o instante real do envio, não o meio-dia;
- vencimento, conta futura e parcela futura continuam permitidos;
- nenhuma data de vencimento recebeu a trava de “máximo hoje”.

### Cobertura

- Matriz: atacado, compras, despesas, baixas do Financeiro, comissões, estornos,
  mensalidades, folha e ledger.
- Parceiro: compra direta via API, despesas, contas a pagar, contas a receber, recebimento de
  parcela e respectivas baixas.
- Banco: 11 triggers novos protegem fatos da Matriz e do parceiro; as guardas anteriores de
  vendas, compras e remessas foram preservadas.
- Interface: limites visuais foram adicionados somente aos campos factuais; vencimentos não
  foram limitados.

### Evidência em 18/08/2026

| Bateria | Resultado |
|---|---|
| Unitários completos | **1.207/1.207**, 238 arquivos |
| Casos direcionados iniciais | **36/36** |
| Build e TypeScript | Aprovados |
| Fiscal de tamanho | Aprovado |
| Manifesto | 187 migrations; última `0186`; gap histórico 0071 documentado |
| Migration `0186` no schema real | Dry-run aprovado com rollback; nenhuma alteração permaneceu |
| PostgreSQL descartável local | Não executado: Docker Desktop sem engine disponível |

### Decisão deste adendo

**APROVADO EM CÓDIGO E EM DRY-RUN DE BANCO. AINDA NÃO IMPLANTADO.**

Ordem segura:

1. publicar somente o pacote versionado e registrar o SHA;
2. fazer backup do banco;
3. aplicar `0186_system_business_fact_dates.sql`;
4. o responsável fazer o deploy do mesmo SHA no Coolify;
5. executar smoke à meia-noite ou com relógio controlado: venda/compra/despesa/baixa de hoje
   deve passar; pagamento de amanhã deve falhar; vencimento/parcela de amanhã deve passar.

## 10. Adendo — acerto financeiro da carga somente na chegada

### Regra operacional consolidada

Uma carga destinada a parceiro não é uma venda concluída quando sai da Matriz. A opção
**à vista** informa como o parceiro pagará, mas o caixa só é reconhecido depois do acerto
físico. Até lá, venda, compra espelhada e pagamento permanecem pendentes.

Na chegada:

- cada linha registra quantos pneus foram aceitos;
- somente pneus aceitos compõem o valor final da venda, receita, custo e pagamento;
- pneus recusados continuam como estoque em trânsito, disponíveis para redirecionamento
  controlado ou retorno físico à Matriz;
- à vista reconhece caixa no acerto; fiado reconhece conta a receber apenas pelo total aceito;
- compra e conta a pagar do parceiro seguem exatamente o mesmo total e estado;
- o histórico financeiro é imutável: lançamentos antigos prematuros são estornados, não apagados.

### Correção da carga aberta anterior

A migration `0187_partner_arrival_financial_settlement.sql` identifica cargas ainda em
trânsito criadas pelo fluxo anterior. Para essas cargas, ela:

1. estorna receita e custo reconhecidos cedo demais;
2. reclassifica o custo físico para `inventory_in_transit`;
3. muda a venda para pendente e limpa a baixa prematura;
4. deixa compra e conta do parceiro abertas até o acerto;
5. instala constraints e triggers que impedem regressão por tela, API ou SQL direto.

### Evidência em 18/08/2026

| Bateria | Resultado |
|---|---|
| Unitários completos | **1.212/1.212**, 239 arquivos |
| Casos direcionados do acerto | **14/14** |
| TypeScript, build e JavaScript | Aprovados |
| Paridade dos painéis | 584 propriedades do parceiro e 1.056 da Matriz; aprovadas |
| Contratos e rotas | 92 contratos e 236 rotas; aprovados |
| Fiscal de tamanho | Aprovado |
| Manifesto | 188 migrations; última `0187`; gap histórico 0071 documentado |
| Migration `0187` no banco real | Dry-run integral aprovado com rollback |
| PostgreSQL descartável local | Não executado: Docker Desktop sem engine; cenário permanece no CI |

### Decisão deste adendo

**APROVADO EM CÓDIGO E EM DRY-RUN DE BANCO; AGUARDA CI, PUBLICAÇÃO E APLICAÇÃO DA
MIGRATION ANTES DO PRÓXIMO DEPLOY.**

Ordem segura:

1. CI executar o cenário à vista com recusa parcial e o cenário fiado;
2. publicar o SHA aprovado;
3. aplicar `0187_partner_arrival_financial_settlement.sql`;
4. confirmar que a carga aberta ficou pendente e sem receita/caixa líquidos;
5. o responsável fazer o deploy do mesmo SHA;
6. executar o acerto pneu por pneu e o smoke financeiro pós-deploy.

## 11. Adendo — preço oficial do dono e preço negociado no caixa

### Regra consolidada

O sistema passou a separar duas verdades que antes ocupavam o mesmo campo lógico:

- **preço oficial:** tabela comercial usada como referência nas próximas vendas; somente o
  proprietário pode alterá-la;
- **preço negociado:** valor efetivamente combinado pelo vendedor com o cliente para uma
  linha daquela venda; pode ser menor ou maior que o oficial e não muda o Catálogo.

O funcionário com acesso a Vendas pode negociar no fechamento. A permissão de alterar o
preço oficial é conferida novamente no servidor; esconder o botão na tela não é a proteção.

### Relações revalidadas nas auditorias existentes

| Auditoria | Efeito comprovado |
|---|---|
| Bot da Matriz | Continua lendo `commerce.matriz_current_prices`, a mesma fonte alterada pelo dono da Matriz; negociação de uma venda não muda resposta futura do Bot |
| Compras | Quantidade, custo de aquisição, custo médio e contas a pagar não usam o preço negociado da venda; nenhuma fórmula de Compras foi alterada |
| Estoque da Matriz | Alterar preço oficial não altera saldo, reserva, custo médio nem filme de movimentos |
| Estoque do parceiro | Alteração grava somente `sale_price`, exige dono, unidade e item válidos e produz `partner_stock_sale_price_changed`; saldo e custo ficam intactos |
| Vendas | Cada item congela `reference_unit_price` e grava em `unit_price` o valor realmente cobrado; preço zero, negativo, com milésimos ou referência antiga é recusado |
| Financeiro e comissão | Receita, caixa/recebível, total do pedido, resultado e comissão continuam derivados do valor efetivamente vendido, não do preço oficial |
| Histórico | Comprovante mostra oficial e negociado quando diferem; vendas antigas não são reprecificadas |
| Concorrência | O fechamento trava os preços oficiais envolvidos e serializa alteração de tabela e venda, evitando mistura de versões |

No parceiro, o Bot comercial central permanece deliberadamente separado do `sale_price`
local da loja, conforme decisão arquitetural anterior. A alteração local muda o caixa da
unidade, não a tabela central da rede.

### Banco e compatibilidade

A migration `0189_checkout_price_negotiation.sql` adiciona
`reference_unit_price NUMERIC(10,2) NOT NULL` a `commerce.order_items` e
`commerce.partner_order_items`. Linhas históricas recebem o próprio `unit_price` como
referência, pois não existe prova confiável do preço oficial vigente no passado. Triggers
mantêm compatibilidade com Bot, Compras e rotinas SQL antigas que ainda inserem itens sem a
nova coluna.

O readiness exige as duas colunas. Portanto, a migration deve ser aplicada **antes** do
deploy; se o schema estiver antigo, a versão nova não se declara pronta.

### Evidência em 20/08/2026

| Bateria | Resultado |
|---|---|
| TypeScript | Aprovado |
| Unitários completos | **1.221/1.221**, 241 arquivos |
| Integração completa | **237/237**, 46 arquivos; 232 passaram na execução longa e o arquivo interrompido pelo worker foi coberto na repetição dos seis candidatos, 30/30 |
| Provas direcionadas Matriz + parceiro | **40/40** em PostgreSQL 17 descartável |
| Migration `0189` no banco de teste | Dry-run integral aprovado com rollback |
| Migration `0189` no banco de produção | **Aplicada materialmente**: colunas, constraints e triggers presentes; 0 referência nula |
| Histórico remoto de migrations | **Incompleto**: `supabase_migrations.schema_migrations` não registra a `0189` e apresenta como última a `0167` |
| Manifesto | 190 migrations; última `0189`; gap histórico 0071 documentado |
| Fiscal de tamanho | Aprovado |

Casos matemáticos explícitos:

- Matriz: preço oficial R$ 120,00, preço negociado R$ 110,00, duas unidades = venda e
  receita de **R$ 220,00**, custo de **R$ 80,00** e referência histórica preservada em
  R$ 120,00;
- parceiro: preço oficial R$ 150,00, preço negociado R$ 135,00, três unidades = pedido de
  **R$ 405,00**, saldo 10 → 7 e referência histórica preservada em R$ 150,00;
- testes unitários cobrem também preço acima do oficial, preço oficial alterado durante o
  fechamento, centavos, zero, milésimos, item de outra unidade e idempotência.

### Decisão deste adendo

**APROVADO EM CÓDIGO, SEGURANÇA, INTEGRAÇÃO E MATEMÁTICA. BANCO DE PRODUÇÃO
MATERIALMENTE PREPARADO; DEPLOY DO SHA ATUAL E SMOKE AUTENTICADO AINDA PRECISAM SER
COMPROVADOS.**

Continuidade segura:

1. [x] publicar o SHA aprovado na `main` (`2064f1a`);
2. [x] confirmar materialmente a `0189` em produção, sem reaplicá-la;
3. [ ] reconciliar futuramente o histórico remoto de migrations por procedimento auditável,
   sem executar novamente o SQL da `0189`;
4. [ ] o responsável confirmar o deploy do SHA atual no Coolify;
5. [ ] smoke autenticado: dono altera preço oficial; funcionário recebe 403 nessa mesma API;
6. [ ] vendedor fecha uma venda com desconto e outra com acréscimo; conferir comprovante,
   estoque, Financeiro, comissão e Bot da Matriz.

## 12. Auditoria concluída — Financeiro da Matriz e dos parceiros

A auditoria percorreu o ledger central, Caixa, contas, despesas, comissões, Financeiro dos
parceiros e as relações com Vendas, Compras, Estoque, Atacado, Logística, Colaboradores,
Catálogo, CRM, Resumo e app.

### Resultado consolidado

| Bateria | Resultado |
|---|---|
| Unitários/regressão | **1.227/1.227**, 243 arquivos |
| Integração PostgreSQL 17 | **243/243**, 46 arquivos |
| TypeScript e build | aprovados |
| Migrations | 191 verificadas; última `0190` |
| Ledger de produção, somente leitura | 325 transações; 0 desbalanceada e 0 mistura de ambiente |
| Integridade causal em produção | 0 fato ausente, divergente, duplicado ou órfão pela régua compatível com fatos novos e legados |
| Backup pré-0190 | 4.953.210 bytes; 2.580 entradas restauráveis; SHA-256 validado |
| Migration `0190` em produção | **COMMIT aprovado** em 20/08/2026 às 23:51; schema material confirmado |
| Reconciliação pós-migration | **PASS**; todos os 21 contadores da Etapa 3 em zero |
| Publicação do código | PR `#61` aprovada pelo CI e incorporada à `main`; SHA `92ae93d73a33780adf801b0e2a33fb16a7f78906` |

### Correções centrais

- carga para parceiro só reconhece receita, CMV e comissão no acerto da chegada e pelos pneus
  aceitos;
- competência da carga passou a usar a data do acerto;
- estorno passou a aparecer junto com o original, produzindo líquido correto;
- entrega e retirada pendentes deixaram de contar como venda/caixa do parceiro;
- venda, despesa, conta e baixa passaram a exigir centavos exatos e valor econômico válido;
- duplo clique e baixas concorrentes produzem somente um efeito;
- mutações financeiras e comerciais sensíveis exigem dono;
- o banco bloqueia confirmação/pagamento direto de carga fora da operação oficial.

### Veredito e continuidade

**APROVADO EM CÓDIGO, BANCO, INTEGRAÇÃO, MATEMÁTICA, SEGURANÇA E CONCORRÊNCIA.** Backup,
migration, reconciliação pós-migration, CI e incorporação à `main` foram concluídos. Restam o
responsável fazer o deploy, executar smoke autenticado e repetir a reconciliação pós-deploy.

Relatório reproduzível: `docs/AUDITORIA_FINANCEIRO_PONTA_A_PONTA_2026-08-20.md`.

## 13. Auditoria concluída — Logística da Matriz, entregador e parceiro

A auditoria percorreu pedido, reserva e baixa de estoque, montagem e fechamento de rota,
app do entregador, entrega local do parceiro, recusas, reentrega, comprovantes, despesa de
combustível, ledger, CMV, comissão, permissões e isolamento entre Matriz e parceiros. O
código auditado foi o SHA `abbcab556cf2a6b32b9a4875fc0d94e9e2479d52`.

### Evidência consolidada

| Bateria | Resultado |
|---|---|
| Unitários direcionados | **50/50**, 13 arquivos |
| Integração logística da Matriz | **32/32**, 4 arquivos |
| Integração parceiro e folha | **40/40**, 2 arquivos |
| Provas descartáveis de matemática, estados e concorrência | **3/3** |
| TypeScript | aprovado |
| Migrations | 191 verificadas; última `0190`; gap histórico `0071` documentado |
| Regressão completa no mesmo SHA | referência anterior de **1.227 unitários + 243 integrações**, aprovada na auditoria financeira |
| Produção somente leitura | nenhuma divergência causal atual em entrega, estoque ou fatos financeiros |

Os cálculos explícitos fecharam em centavos: em uma rota de **R$ 280,02**, os itens
representaram **R$ 240,02**, o frete **R$ 40,00**, o CMV **R$ 150,00**, o lucro dos pneus
**R$ 90,02** e a margem antes das despesas da rota **R$ 130,02**.

### Bloqueadores confirmados

1. repetir uma entrega já recebida pelo parceiro consegue alterar data, pagamento e
   entregador de um recebível histórico;
2. uma venda criada no fim de um mês e entregue no mês seguinte entra na competência
   financeira do mês do pedido, não no mês da entrega;
3. uma rota aberta pela Matriz apenas com o nome livre do entregador não fica vinculada ao
   cadastro dele e pode desaparecer do app e da apuração de desempenho;
4. no parceiro, reportar falha cancela a venda e libera o estoque antes de o pneu voltar
   fisicamente à loja.

Também foram registrados oito problemas relevantes de interface, concorrência, histórico e
recuperação operacional, além de endurecimentos e propostas de funcionalidades. Entre as
melhorias de maior valor estão painel multirrota, retorno físico em duas etapas, aceitação
parcial por pneu, acerto de dinheiro por entregador, prova de entrega, comunicação de
previsão ao cliente, cadastro de veículos e roteirização.

A leitura atual de produção encontrou duas rotas de teste que precisam de decisão humana:
`ROTA-0074`, fechada com comprovante rejeitado e sem despesa aprovada, e `ROTA-0076`, com
R$ 52,00 declarados e R$ 50,00 aprovados. Não houve alteração automática desses dados.

### Veredito desta seção

**AUDITORIA CONCLUÍDA, MAS LOGÍSTICA AINDA NÃO APROVADA COMO SEÇÃO ENCERRADA PARA
PRODUÇÃO.** O fluxo principal está consistente e os dados atuais estão limpos, porém os
quatro bloqueadores acima precisam ser corrigidos e retestados antes da autorização final.
Nenhuma migration, correção de produto, publicação ou deploy foi executado nesta etapa.

Relatório reproduzível:
`docs/AUDITORIA_LOGISTICA_PONTA_A_PONTA_2026-08-21.md`. Auditoria remota somente leitura:
`scripts/auditar-logistica-prod-readonly.cjs`.

### Adendo — correções da Logística concluídas em código

Os quatro bloqueadores e os oito problemas relevantes foram corrigidos. O escopo foi
deliberadamente estrito: **nenhuma sugestão de funcionalidade ou endurecimento opcional da
auditoria foi implementada**.

Principais mudanças: replay terminal do parceiro não reescreve o passado; falha de entrega
preserva a reserva até a confirmação do retorno físico; competência da entrega usa
`delivered_at`; rota administrativa exige colaborador ativo; tela opera múltiplas rotas;
identidade de cliente de balcão e reentrega foram corrigidas; upload possui erros controlados;
o teto concorrente de 50 comprovantes é protegido pelo banco; Histórico usa os sete dias
passados; agregações dos últimos 30 dias não são truncadas; e rota fechada pendente permite
novo comprovante.

| Bateria pós-correção | Resultado |
|---|---|
| Unitários completos | **1.232/1.232**, 244 arquivos |
| Integração completa | **249/249**, 46 arquivos |
| Direcionados da Logística | **19/19 unitários + 62/62 integrações** |
| TypeScript e build | aprovados |
| Migrations | **192 verificadas**; última `0191` |
| Backup pré-`0191` | **4.960.069 bytes**, legível pelo `pg_restore`; SHA-256 `ec08c387b4b9eb600003bb637e9bc1632f13ba83c561d0da932e38b3a6de0f15` |
| Migration `0191` no banco-alvo | **Aplicada com COMMIT** após dry-run com rollback; funções, trigger e permissões confirmados materialmente |
| Reconciliação pós-migration | `prod`: **21/21 contadores zerados**; `test`: nove ajustes históricos sem ledger, isolados e preservados |
| Publicação do código | PR funcional `#63` e PR documental `#64` incorporadas; SHA funcional `86287042f004d8b21cbac4682e1e3a0d83bc4c2b`; `main` consolidada em `a758bb6e17f66d0335ba434799f4917c3f6f9633` antes deste adendo |
| CI da `main` | **PASS** no run `32449374390`: tamanho, migrations, TypeScript, unitários, integrações e build aprovados |
| Estado operacional | Deploy manual ainda não iniciado; usar o `HEAD` atual da `main` e executar smoke autenticado depois |

**Novo veredito:** Logística aprovada no código e no banco para deploy. A migration `0191`
já foi aplicada materialmente após backup validado e o código foi incorporado à `main` pela
PR `#63`; a documentação foi consolidada pela PR `#64` e o CI final da `main` passou. O
deploy manual e o smoke autenticado pós-deploy continuam obrigatórios; este adendo não
declara o runtime novo já implantado.
