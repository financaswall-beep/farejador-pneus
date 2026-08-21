# Auditoria do Financeiro ponta a ponta — Matriz e parceiros

**Data:** 20/08/2026
**Escopo:** Financeiro da Matriz, Financeiro dos parceiros e relações com Vendas,
Compras, Estoque, Atacado, Logística, Colaboradores, Catálogo, CRM, Resumo e app.
**Método:** leitura linha a linha dos caminhos financeiros, recálculo independente,
testes unitários, integrações com PostgreSQL 17 descartável, concorrência, permissões,
build, migrations e auditoria somente leitura em produção.

## 1. Veredito executivo

**O pacote está APROVADO EM CÓDIGO para preparar o próximo deploy.**

**A migration `0190_finance_audit_consistency.sql` foi aplicada e reconciliada em produção
em 20/08/2026, às 23:51 (America/Sao_Paulo).** A produção ainda não está homologada com o
pacote completo porque o código desta auditoria ainda não foi implantado e o smoke
autenticado pós-deploy ainda não foi executado.

Não foi preciso refazer o Financeiro. A arquitetura existente foi preservada e foram
corrigidos somente os pontos em que fontes de verdade, datas, estados, permissões ou
cálculos não fechavam.

## 2. Como o Financeiro está organizado

O sistema tem dois motores financeiros relacionados, mas deliberadamente separados:

1. **Matriz:** usa o ledger central de partidas dobradas. Cada fato gera uma transação e
   lançamentos de débito e crédito; a soma dos débitos precisa ser igual à soma dos
   créditos.
2. **Parceiro:** usa pedidos, contas a pagar, contas a receber, despesas e comissões da
   própria unidade, protegidos por unidade e por ambiente.

A carga Matriz → parceiro é a ponte entre eles. A Matriz reconhece a venda e o custo
somente no acerto da chegada; o parceiro recebe a compra e a conta correspondente. Isso
evita misturar o caixa da Matriz com o caixa de cada borracharia.

Essa arquitetura é válida para o estágio atual do produto. A auditoria não criou um
terceiro motor nem duplicou regras corretas.

## 3. Matriz causal conferida

| Origem | Documento/fato | Efeito financeiro esperado | Momento correto | Tela/consumidor |
|---|---|---|---|---|
| Venda varejo Matriz | `commerce.orders` | receita, caixa ou recebível, CMV e comissão | confirmação/realização | Vendas, Caixa, Financeiro, Colaboradores e CRM |
| Cancelamento/devolução | transação de estorno ligada à original | neutraliza exatamente o fato original sem apagá-lo | cancelamento efetivo | Extrato, Caixa e reconciliação |
| Venda atacado comum | `commerce.wholesale_orders` | receita, recebível/caixa, CMV e comissão | venda confirmada | Atacado, Financeiro e Colaboradores |
| Carga para parceiro | pedido + compra espelhada + acerto | receita e CMV somente dos pneus aceitos | acerto na chegada | Atacado, Estoque, Financeiro da Matriz e parceiro |
| Compra Matriz | `commerce.wholesale_purchases` | estoque/trânsito contra caixa ou obrigação | compra, recebimento e pagamento | Compras, Estoque e Financeiro |
| Despesa Matriz | despesa/obrigação central | despesa por competência e caixa na baixa | fato e pagamento separados | Despesas, Contas e Caixa |
| Ajuste de estoque | ajuste de inventário | ganho/perda contra estoque | data do ajuste | Estoque, Resultado e ledger |
| Comissão/folha | regra + fato + liquidação | despesa/obrigação e depois saída de caixa | competência e pagamento separados | Colaboradores e Financeiro |
| Venda do parceiro | `commerce.partner_orders` | receita local; caixa na retirada/entrega ou recebível | realização física | Frente de Caixa e Financeiro do parceiro |
| Compra/despesa local | compra, conta ou despesa da unidade | custo/despesa local e caixa/obrigação | competência e baixa separadas | Compras/Financeiro do parceiro |

## 4. Problemas encontrados e correções

### 4.1 Carga Matriz → parceiro

- Uma carga em trânsito podia ser alcançada por rotinas de reconciliação antigas antes do
  acerto. Agora receita e CMV só nascem quando a Matriz confirma os pneus aceitos.
- A data econômica usava a data original de saída. Agora usa `partner_settled_at`, o instante
  real do acerto, em Financeiro, Atacado, comissão e gestão de colaboradores.
- O monitor antigo não entendia `arrival_revenue` e `arrival_cogs` e acusava falsamente
  lançamentos ausentes. O monitor e o backfill agora aceitam fatos novos e legados sem
  duplicá-los.
- O banco agora impede alteração direta de status, pagamento, data, valor aceito ou condição
  comercial fora da operação oficial de chegada. A confirmação final do recebimento pelo
  parceiro continua permitida somente para a própria unidade e depois da conferência física.

### 4.2 Estornos da Matriz

- Extrato, entradas, saídas e resumo de Caixa removiam a transação original quando existia
  estorno, mas mantinham o estorno. Exemplo antigo: entrada de R$ 125,00 e devolução de
  R$ 125,00 podiam aparecer como apenas **−R$ 125,00**.
- Agora as duas movimentações aparecem: entrada R$ 125,00, saída R$ 125,00 e efeito líquido
  R$ 0,00. A trilha contábil é preservada.

### 4.3 Caixa e competência do parceiro

- Pedido de entrega ainda não entregue e retirada ainda não confirmada podiam aparecer como
  venda/caixa do mês.
- Agora entrega usa `delivered_at`; retirada reservada usa `retrieved_at`. Antes da realização,
  o valor é zero no caixa e no resultado realizado.
- Entrega local passou a ser obrigatoriamente contra entrega: nasce “a receber” e registra o
  dinheiro uma única vez, quando a entrega é confirmada com a forma de pagamento real.

### 4.4 Matemática monetária

- Venda do parceiro agora é recalculada em centavos inteiros antes de tocar no estoque.
- Quantidade inválida, preço zero/negativo, desconto maior que a linha, total zero, fração de
  centavo e estouro do campo do banco são recusados.
- Venda à vista não aceita valor recebido menor que o total.
- Despesa, conta a pagar e conta a receber do parceiro exigem valor positivo e centavos exatos
  na tela/API e no banco.
- Baixas do ledger central recusam valores como R$ 1,001; pagamento parcial válido em centavos
  continua permitido.
- Vencimentos e parcelas podem estar no futuro. O bloqueio de futuro vale para a data do fato
  ou pagamento já realizado, não para uma dívida que ainda vencerá.

### 4.5 Segurança e concorrência

- Criar/arquivar categoria, lançar/quitar/remover despesa, conciliar custo, quitar comissão,
  alterar condição comercial e alterar preço oficial passaram a exigir perfil de dono.
- Leituras administrativas permanecem disponíveis aos perfis autorizados, sem liberar
  mutações financeiras.
- Duas vendas simultâneas com a mesma chave são serializadas; a segunda devolve o mesmo pedido
  sem nova baixa de estoque.
- Retirada, entrega, conta a pagar e conta a receber usam trava transacional. Duas confirmações
  concorrentes produzem apenas um efeito financeiro e um evento de auditoria.
- RLS, papel restrito e contexto de unidade continuam isolando os dados dos parceiros.

## 5. Auditoria matemática independente

Foram comprovadas as seguintes invariantes:

- débito = crédito em todas as transações do ledger;
- venda/compra/ajuste = valor registrado no ledger;
- carga em trânsito = zero receita e zero CMV reconhecido;
- carga acertada = receita e CMV somente da quantidade aceita;
- comissão da carga = percentual sobre o valor aceito e no mês do acerto;
- entrega/retirada pendente = zero caixa local;
- entrega/retirada concluída = uma única entrada de caixa;
- cancelamento/estorno = efeito líquido zero, mantendo original e reversão;
- parcelas existentes somam exatamente o documento pai;
- nenhum fato financeiro ativo aceita valor zero, negativo ou fração de centavo;
- baixa repetida ou concorrente não duplica caixa, conta ou auditoria.

Exemplos exercitados:

- carga de 3 pneus a R$ 100,00 com somente 2 aceitos: receita R$ 200,00; se o custo é
  R$ 80,00, CMV R$ 160,00;
- comissão de 3% sobre R$ 300,00 efetivamente aceitos: R$ 9,00 no mês do acerto;
- venda e estorno de R$ 125,00: entradas R$ 125,00, saídas R$ 125,00, líquido R$ 0,00;
- entrega de R$ 100,00 mais retirada de R$ 100,00: antes da conclusão R$ 0,00; depois,
  exatamente R$ 200,00 em duas entradas.

## 6. Evidências automatizadas

| Bateria | Resultado |
|---|---|
| TypeScript | aprovado |
| Build completo | aprovado |
| Unitários/regressão de código | **1.227/1.227**, 243 arquivos |
| Integrações PostgreSQL 17 | **243/243**, 46 arquivos |
| Teste direcionado final da carga | **2/2**, incluindo tentativa de confirmação direta bloqueada pelo banco |
| Migrations | **191 verificadas**, última `0190`, gap histórico `0071` documentado |
| Manifesto/hash | íntegro |
| Formatação de diff | aprovada |

As integrações recriaram um PostgreSQL vazio, aplicaram todas as migrations e exercitaram
Vendas, Compras, Estoque, Caixa, contas, ledger, parceiros, concorrência, estornos e
permissões. Mensagens PostgreSQL `57P01` ao final dos testes são o encerramento esperado dos
containers descartáveis, não falhas da aplicação.

## 7. Auditoria somente leitura em produção

A leitura foi executada em transação `REPEATABLE READ READ ONLY`, com timeout e `ROLLBACK`.
Nenhum dado foi alterado.

Resultado sobre os dados existentes:

- 0 pedidos, despesas, contas a pagar ou contas a receber com valor financeiro inválido;
- 0 divergência de parcelas;
- 3 cargas para parceiro já acertadas;
- 0 receita ausente e 0 CMV ausente, considerando fatos de chegada e fatos legados;
- 0 divergência entre valor aceito e receita/CMV registrado;
- 0 carga em trânsito com receita ou CMV reconhecido;
- 0 entrega/retirada pendente marcada como caixa;
- 0 fonte duplicada, 0 estorno órfão e 0 despesa duplicada por conta;
- 0 incompatibilidade entre status de pagamento/recebimento e sua data;
- 325 transações do ledger, 0 desbalanceada e 0 mistura de ambiente.

Depois da `0190`, o próprio monitor do banco passou a reconhecer fatos de chegada e legados.
Todos os 21 contadores da Etapa 3 retornaram zero, inclusive receita, CMV, pagamento,
despacho, cancelamento, estoque e duplicidade de reconhecimento.

O histórico remoto `supabase_migrations.schema_migrations` continua atrasado em relação ao
schema material. Essa pendência de governança não autoriza reaplicar migrations já presentes.

## 8. Migration 0190

A migration:

- adiciona e retropreenche `partner_settled_at` nas cargas já acertadas;
- instala a proteção de transição da carga na camada do banco;
- atualiza reconciliação e conferência matemática do ledger;
- impede novos fatos financeiros locais sem valor econômico real;
- corrige o resumo mensal do parceiro para usar a data de realização.

Foi executado dry-run integral com `ROLLBACK`, seguido de backup lógico completo e somente
depois o `COMMIT`. Backup validado:

- arquivo: `farejador-prod-pre-0190-20260820-234753.dump`;
- tamanho: 4.953.210 bytes;
- 2.580 entradas reconhecidas por `pg_restore --list`;
- SHA-256: `B9F8CBEBF6EA5FEA00DFE6745EA234EE7B142514B7A19C14E6B2FE9852C76149`.

Depois do `COMMIT`, schema obrigatório, funções, trigger e constraints foram confirmados.
Os dados de produção satisfizeram todas as novas proteções sem limpeza ou reparo.

## 9. O que ainda falta para homologar em produção

1. [x] Fazer e validar backup restaurável.
2. [x] Aplicar `0190_finance_audit_consistency.sql` e confirmar materialmente o schema.
3. [x] Repetir reconciliação somente leitura: `PASS`, com todos os contadores financeiros e
   da Etapa 3 em zero.
4. [ ] Publicar e implantar o mesmo SHA aprovado. O deploy é feito pelo responsável do sistema.
5. [ ] Executar smoke autenticado em desktop e celular:
   - Matriz: Caixa, Contas, Despesas, Vendas, Atacado, Compras e Colaboradores;
   - parceiro: venda à vista, fiado, entrega, retirada, conta a pagar/receber e relatório;
   - carga: saída, recusa parcial, acerto, recebimento e quitação.
6. [ ] Repetir a reconciliação somente leitura depois do deploy e exigir todos os contadores
   em zero.

O smoke público atual abriu o painel e a tela de login em desktop e celular sem erro de
console. O smoke autenticado da versão corrigida só pode existir depois do deploy.

## 10. Decisão

**Financeiro da Matriz e dos parceiros: APROVADO EM CÓDIGO, INTEGRAÇÃO, MATEMÁTICA,
SEGURANÇA E CONCORRÊNCIA.**

**Banco de produção com a `0190`: APROVADO. Produção com o pacote completo: AINDA NÃO
HOMOLOGADA**, exclusivamente porque o código ainda precisa ser implantado e o smoke
pós-deploy ainda não aconteceu.
