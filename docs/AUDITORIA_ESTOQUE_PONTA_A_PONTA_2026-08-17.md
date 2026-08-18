# Auditoria do Estoque — ponta a ponta e matemática

**Data:** 17/08/2026
**Escopo:** Matriz, galpão, estoque local dos parceiros, app Operação, Compras, Vendas, Financeiro, Logística, Catálogo, Bot e banco.
**Estado da entrega:** código e migrations `0182`–`0184` aprovados localmente; ainda não aplicados nem implantados em produção.

## Veredito executivo

O Estoque ficou **aprovado em código e nas provas matemáticas em PostgreSQL real**. Não restou bloqueador lógico conhecido dentro do escopo auditado.

Isso ainda não equivale a autorizar produção. A entrada em produção exige, nesta ordem: backup, publicação do código, aplicação das migrations `0182`, `0183` e `0184`, deploy do mesmo SHA, smoke autenticado e reconciliação somente leitura pós-deploy.

## 1. Fontes de verdade mapeadas

| Domínio | Fonte oficial | Responsabilidade |
|---|---|---|
| Galpão da Matriz | `commerce.wholesale_stock` | Saldo físico por ambiente, medida, marca e condição; custo médio, mínimo e reserva |
| Filme do galpão | `commerce.wholesale_stock_movements` | História imutável de entradas, vendas, devoluções, contagens, baixas e remoções |
| Catálogo legado | `commerce.stock_levels` | Compatibilidade e conciliação; não é a fonte física oficial do galpão |
| Estoque da loja parceira | `commerce.partner_stock_levels` | Saldo, reserva, custo médio, preço, posição e status por unidade |
| Compra da loja | `commerce.partner_purchases` e `partner_purchase_items` | Documento esperado, recebimento físico e vínculo causal com a ficha exata de estoque |
| Envio Matriz → parceiro | `wholesale_orders.parent_order_id/partner_unit_id` + `partner_purchases.source_wholesale_order_id` | Liga venda, acréscimos, saída da Matriz, recebimento da loja e financeiro sem duplicar documentos |
| Carga recusada ainda no veículo | `commerce.matrix_partner_cargo_lots` e `matrix_partner_cargo_events` | Mantém os pneus fora do saldo disponível, permite redirecionamento sem nova baixa e registra o retorno físico ao galpão |
| Reservas | eventos/pedidos abertos + colunas `quantity_reserved` | Impedir que venda, entrega, ajuste ou remoção usem a mesma unidade duas vezes |
| Financeiro da Matriz | `finance.matriz_inventory_adjustments` + ledger central | Valor de ganho/perda por ajuste físico manual |
| Custo realizado | snapshots dos itens vendidos | Preservar o custo da venda mesmo que o custo médio mude depois |

Todos esses caminhos continuam separados por `environment`; os estoques de `prod` e `test` não se misturam.

## 2. Relações cruzadas verificadas

| Relação | Regra comprovada |
|---|---|
| Varejo da Matriz → galpão | Venda baixa a variante correta; cancelamento devolve pela trilha causal |
| Atacado → galpão | Venda e cancelamento alteram medida, marca e condição exatas |
| Atacado da Matriz → parceiro | Venda para parceiro cria remessa pendente; na chegada, cada linha aceita de zero até a quantidade enviada, e somente o aceito compõe a venda final |
| Compras da Matriz → galpão | Recebimento aumenta saldo e recalcula custo médio; cancelamento restaura quantidade e custo |
| Ajuste/contagem → Financeiro | Ganho ou perda física produz ajuste financeiro e lançamento balanceado quando o ledger está habilitado |
| Logística → reservas | Pedido aberto reserva; conclusão/cancelamento libera; estoque disponível é físico menos reservado |
| Bot/Demanda → estoque | Leitura usa saldo disponível e não grava no estoque |
| Catálogo → estoque | Identidade comercial e identidade física são conciliadas sem transformar o catálogo legado em fonte de saldo |
| Compra do parceiro → app Operação | A compra nasce pendente; o funcionário confirma a quantidade; somente o recebimento incrementa o estoque |
| Remessa da Matriz → app Operação | O parceiro só enxerga o documento depois do acerto da Matriz, não altera valores e precisa receber exatamente a quantidade final confirmada |
| Carga no veículo → outro parceiro | Pneu recusado pode entrar no pedido seguinte sem uma segunda baixa da Matriz; quantidade e custo permanecem causais |
| Compra do parceiro → Financeiro | Compra à vista ou conta a pagar usa somente os pneus aceitos; recusa e extra produzem ajustes balanceados no ledger da Matriz |
| Venda do parceiro → estoque | Venda baixa a ficha da própria unidade, congela custo e respeita reserva |
| App → Matriz/loja | Dono altera saldo/custo; funcionário operacional recebe compra sem enxergar valores protegidos |

## 3. Subabas e superfícies conferidas

- Matriz: Visão geral, Movimentações, Reposição, Custos e Conciliação.
- Parceiro: lista, busca, filtros, cadastro, edição, detalhe, alertas, aprovações e indicadores.
- Operação/Caixa: estoque disponível, detalhe, contagem e recebimento de compras.
- Relações externas: Vendas, Compras, Financeiro, Logística, Catálogo, Bot e Demanda.
- APIs e banco: autenticação, perfil de dono, RLS, ambiente, constraints, triggers, idempotência e concorrência.

## 4. Problemas encontrados e corrigidos

| Antes | Agora |
|---|---|
| Administrador não proprietário conseguia chamar mutações do galpão | Entrada, ajuste, baixa, remoção e contagem exigem dono no servidor e na tela |
| Algumas telas usavam saldo físico mesmo quando parte estava reservada | Venda, reposição, filtros, status e cards usam saldo disponível |
| Giro de 30 dias somava vendas brutas e ignorava cancelamentos | Giro usa movimentos líquidos de venda e devolução, limitado a no mínimo zero |
| Remoção da variante da Matriz não exigia motivo/idempotência e podia esconder saldo reservado | Remoção trava a linha, exige motivo/chave, bloqueia reserva, audita e concilia o valor |
| Contagem física abaixo da reserva falhava apenas com erro genérico | Servidor rejeita explicitamente e informa conflito; marca é canonizada |
| Ajuste da Matriz aceitava custo omitido como zero | Custo virou obrigatório e é comparado com precisão de seis casas |
| Cancelar compra do parceiro retirava quantidade, mas deixava custo médio errado | Cancelamento retira quantidade e o valor causal da compra usando inteiros com seis casas |
| Cancelamento procurava uma ficha parecida e podia escolher a errada | Cada item recebido grava o `received_stock_id` exato e snapshots antes/depois |
| Um recebimento poderia ser ligado manualmente ao estoque de outra loja | Trigger da migration `0182` exige que compra e estoque pertençam à mesma unidade |
| Detalhe do app podia casar o movimento com o item errado quando outro item recebeu zero | Casamento passou a ser por `item_id` e quantidade efetivamente recebida |
| Cabeçalho da compra podia divergir da soma dos itens por fração/float | API calcula centavos inteiros e o banco exige cabeçalho = soma dos itens |
| A mesma chave idempotente colidia entre lojas diferentes | Unicidade passou a ser `(environment, unit_id, idempotency_key)` |
| Custo médio com seis casas podia ser recusado ao editar outro campo no app | Edição preserva até seis casas; preço e custo digitado de compra continuam em centavos |
| Item com saldo positivo podia ser inativado e desaparecer dos indicadores | Aplicação e trigger recusam inativação enquanto houver saldo ou reserva |
| Compra futura podia contaminar estoque/financeiro | Tela/servidor e trigger recusam data futura; vencimento não pode anteceder a compra |
| Bot podia resolver duplicidade por ordem arbitrária | Consulta agrupa por unidade/produto e usa o maior saldo disponível de forma determinística |
| KPIs contavam compra pendente como estoque recebido | Indicadores usam somente compras recebidas, quantidade real e data de recebimento |
| Duas variantes antigas da Matriz não tinham movimento de abertura | `0182` cria abertura somente quando a primeira movimentação prova matematicamente o saldo anterior |
| Processo novo poderia subir antes do schema novo | Readiness agora exige as colunas e a precisão da migration `0182` |
| A venda da Matriz e a compra do parceiro eram dois cadastros sem vínculo automático | `0183` cria o documento pendente do parceiro na mesma transação da venda de atacado |
| Não havia forma segura de acrescentar pneus depois de o pedido sair | A tela permite **Adicionar pneus**; nasce uma venda complementar ligada ao pedido original, com estoque, recebimento e financeiro próprios |
| O parceiro podia tentar editar/excluir/quitar manualmente um documento criado pela Matriz | API e triggers reservam esses documentos à Matriz; o parceiro somente confirma o recebimento físico |
| Cancelar um complemento poderia devolver estoque duas vezes | Só complemento ainda pendente e não pago pode ser cancelado; recebido ou pago bloqueia a devolução automática |
| Um acréscimo recusado poderia ficar sem retorno causal | Cancelar o complemento pendente devolve exatamente suas unidades à Matriz e cancela o documento e a conta espelhados |
| Processo novo poderia subir antes do schema da ponte | Readiness agora exige também as colunas da migration `0183` |
| Um pedido de 30 pneus era tratado como um bloco na chegada | A migration `0184` permite informar a quantidade aceita por linha; por exemplo, aceitar 9 de uma linha com 10 retira somente 1 |
| Pneu recusado poderia voltar ao saldo da Matriz sem ter voltado ao galpão | Recusado vira carga em trânsito e permanece indisponível até o retorno físico registrado |
| Pneu que sobrou de outro parceiro poderia exigir uma segunda baixa ou ajuste manual | A tela permite incluir a carga disponível no pedido seguinte, preservando origem, quantidade, custo e auditoria |
| Pedido/financeiro poderiam continuar com o valor despachado | Venda, compra espelhada, conta a pagar, relatórios e comissão passam a usar o total efetivamente aceito |
| Parceiro podia confirmar recebimento antes do acerto da Matriz | Banco e API exigem acerto concluído e confirmação exata das quantidades finais |
| Cancelamento comum poderia devolver uma remessa ainda dentro do veículo | Remessa de parceiro usa obrigatoriamente o acerto de chegada; o cancelamento genérico é bloqueado |
| Processo novo poderia subir antes do schema do acerto | Readiness agora exige também as tabelas, colunas e funções da migration `0184` |

## 5. Auditoria matemática

### Custo médio do parceiro

Caso executado no PostgreSQL real:

- saldo inicial: 3 unidades × R$ 100,000000 = R$ 300,000000;
- recebimento: 2 unidades × R$ 200,00 = R$ 400,000000;
- saldo final: 5 unidades;
- valor final: R$ 700,000000;
- custo médio: R$ 700 ÷ 5 = **R$ 140,000000**.

No cancelamento da mesma compra:

- quantidade: 5 − 2 = **3**;
- valor: R$ 700 − R$ 400 = **R$ 300**;
- custo restaurado: R$ 300 ÷ 3 = **R$ 100,000000**.

Também foi provado que 3 × R$ 19,99 + 2 × R$ 0,10 resulta exatamente em **R$ 60,17**, sem erro binário de JavaScript.

### Filme da Matriz

A prova M1–M17 executou o código real contra o banco de `test`:

1. abertura 0 → 10;
2. contagem 10 → 8;
3. alteração somente de mínimo/nota sem movimento falso;
4. entrada 8 → 16 com custo 20 → 30;
5. atacado 16 → 13;
6. cancelamento do atacado 13 → 16;
7. compra 16 → 20 com custo 30 → 29;
8. cancelamento da compra 20 → 16 com custo restaurado a 30;
9. varejo 16 → 14;
10. cancelamento do varejo 14 → 16;
11. baixa manual 16 → 13;
12. baixa acima do disponível recusada sem rastro;
13. motivo vazio recusado;
14. atualização crua registrada como `sem_rotulo`;
15. soma dos deltas = saldo 12;
16. remoção 12 → 0 com movimento e motivo;
17. filtros e limite do filme preservados.

A prova limpou seus próprios dados. A auditoria posterior voltou exatamente ao baseline de teste anterior.

### Conservação Matriz → parceiro e acréscimo depois da saída

A prova da migration `0183` executou o fluxo real dentro de uma transação descartável:

1. Matriz começou com 20 pneus a custo de R$ 100;
2. venda original enviou 2 pneus por R$ 150 cada: Matriz ficou com 18;
3. o parceiro recebeu automaticamente um documento pendente de R$ 300, com custo unitário de aquisição de R$ 150;
4. Financeiro registrou R$ 300 a receber na Matriz e R$ 300 a pagar no parceiro;
5. o CMV da Matriz ficou congelado em 2 × R$ 100 = R$ 200;
6. depois da saída, um acréscimo de 1 pneu foi ligado ao pedido original: Matriz passou de 18 para 17;
7. o acréscimo ganhou documento, recebimento e financeiro próprios;
8. o parceiro confirmou os 2 pneus originais e o banco recusou quantidade acima do enviado;
9. a quitação na Matriz quitou também a conta espelhada do parceiro;
10. o extra recusado foi cancelado antes do recebimento e voltou à Matriz: 17 + 1 = 18;
11. o banco bloqueou cancelar a venda original já recebida, impedindo devolução duplicada;
12. conservação final: **18 na Matriz + 2 no parceiro = 20 pneus iniciais**.

A transação externa foi revertida; a prova não deixou venda, compra, estoque nem financeiro fictícios no banco.

### Acerto individual na chegada, redirecionamento e retorno físico

A prova da migration `0184` executou o caso real de pneus usados em uma transação descartável:

1. a Matriz começou com **31 pneus**;
2. 30 saíram para o parceiro A, deixando 1 disponível na Matriz;
3. o parceiro A aceitou 27 e recusou individualmente 3;
4. os 3 recusados ficaram na carga do veículo: o saldo da Matriz continuou em 1, sem retorno fictício;
5. a conta do parceiro A caiu de R$ 4.500 para **R$ 4.050**;
6. o parceiro B aceitou 1 pneu do próprio pedido e incluiu 2 dos recusados pelo parceiro A;
7. o redirecionamento não baixou a Matriz uma segunda vez e deixou 1 pneu na carga;
8. o banco bloqueou o recebimento do parceiro antes da confirmação exata;
9. o último pneu só voltou ao saldo da Matriz depois do registro de retorno físico ao galpão;
10. o ledger registrou R$ 450 de recusa e R$ 340 de pneus extras;
11. a conservação final fechou em **Matriz 1 + parceiro A 27 + parceiro B 3 = 31 pneus**.

A prova aplicou `0182`, `0183` e `0184` juntas, executou as constraints e triggers reais e encerrou com rollback externo. Nenhum dado fictício permaneceu no banco.

## 6. Auditoria somente leitura dos dados existentes

### Produção antes da migration 0182

- Matriz: 6 variantes, 123 unidades físicas/disponíveis e valor de R$ 2.026,40.
- Zero saldo negativo, reserva inválida, custo ausente, mínimo inválido ou identidade duplicada.
- Zero ajuste financeiro sem ledger e zero transação desbalanceada.
- Duas variantes tinham movimentos iniciados depois do saldo de abertura. A primeira linha prova aberturas de 37 e 35 unidades; o dry-run de `0182` reconstruiu ambas e levou a divergência a zero.
- Parceiros: 7 fichas, 18 unidades e valor de R$ 865,00; zero negativo, reserva, status ou identidade divergente.
- Uma compra recebida: R$ 675,00 no cabeçalho, R$ 675,00 nos itens e R$ 675,00 fisicamente recebido.
- Três itens vendidos com custo histórico pendente pertencem a dados identificados como teste (`codex_visual_test`, `demo_codex` e `outro`). Conforme declaração do responsável, os dados atuais de Estoque são de teste; eles não foram alterados automaticamente.

### Ambiente de teste

- 41 fichas de parceiro, 410 unidades e valor de R$ 49.200,00.
- Zero saldo, reserva, custo, status, identidade, compra ou venda causal divergente.
- Sete movimentos/ajustes históricos de fixtures já existiam sem ledger; a prova atual não acrescentou resíduos.

## 7. Evidências de execução

| Bateria | Resultado |
|---|---|
| TypeScript | Aprovado |
| Build | Aprovado |
| Testes unitários completos | **1.194/1.194**, 234 arquivos |
| Regressão direcionada da ponte, Vendas e schema | **43/43** |
| Prova transacional `0182` em PostgreSQL real | **15/15**, rollback confirmado |
| Prova transacional `0183` Matriz → parceiro | **17/17**, conservação física e rollback confirmados |
| Prova transacional `0184` acerto na chegada | **12/12 verificações**, retirada individual, redirecionamento, financeiro, conservação e rollback aprovados |
| Filme do galpão M1–M17 | **17/17**, limpeza confirmada |
| Migrations | 185 verificadas; última `0184`; gap histórico 0071 documentado |
| Dry-run da `0182` no banco de teste | Aprovado com rollback |
| Dry-run da `0182` no banco de produção | Aprovado com rollback |
| Painéis e contratos | 582 propriedades do parceiro, 1.053 da Matriz, 92 contratos e 236 rotas aprovados |
| Fiscal de tamanho | Aprovado |
| Produção somente leitura | Aprovada, com as duas aberturas históricas explicadas acima |

### Limitação de infraestrutura

A suíte Testcontainers completa não pôde ser repetida nesta máquina porque a interface do Docker Desktop abriu, mas o backend não criou o pipe `dockerDesktopLinuxEngine`. O erro é de infraestrutura local, não uma reprovação funcional. Para não declarar uma aprovação fictícia, esse item permanece explicitamente pendente.

Os caminhos críticos de Estoque foram, porém, exercitados no PostgreSQL real remoto dentro de transações descartáveis, inclusive constraints, triggers, custo, idempotência, isolamento, datas e reconstrução do filme.

## 8. Ordem segura para entrega

1. Fazer backup restaurável do banco.
2. Publicar somente os arquivos desta auditoria e obter o SHA definitivo.
3. Aplicar `0182_stock_end_to_end_integrity.sql`.
4. Aplicar `0183_matrix_partner_stock_transfer.sql`.
5. Aplicar `0184_partner_arrival_item_adjustments.sql`.
6. Confirmar que as três concluíram e que o readiness aceita o schema.
7. Fazer o deploy do mesmo SHA no Coolify.
8. Executar smoke autenticado de Estoque, Vendas, Compras, Financeiro, Logística, Catálogo e app Operação, incluindo: envio com vários pneus, recusa de apenas um, inclusão de carga recusada por outro parceiro, retorno físico ao galpão e recebimento exato no app.
9. Repetir a auditoria somente leitura e exigir zero nas métricas de integridade.

Não aplicar o aplicativo novo antes da migration: o readiness foi intencionalmente atualizado para recusar o schema antigo.

## 9. Decisão

**Auditoria técnica do Estoque:** **APROVADA EM CÓDIGO E MATEMÁTICA.**
**Autorização de produção neste momento:** **AINDA NÃO**, porque as migrations `0182`–`0184` não foram aplicadas, o código não foi publicado/implantado e o smoke pós-deploy ainda não existe.

Após a sequência da seção 8, o responsável pode registrar:

- [ ] **AUTORIZO** Estoque em produção.
- [ ] **NÃO AUTORIZO**; registrar o bloqueador observado no smoke ou na reconciliação.
