# Plano de execução — Integração financeira 100% da Matriz

Data de início: 2026-07-27
Estado atual: Etapas 0–8 e backfill concluídos; deploy do código pendente; flags da aplicação desligadas
Escopo: financeiro gerencial da Matriz, sem contabilidade fiscal ou emissão de documentos fiscais

## 1. Objetivo

Fazer com que todo evento operacional com efeito monetário produza um fato
financeiro rastreável, idempotente e reversível, sem substituir de uma vez a
arquitetura operacional existente.

O Financeiro será considerado 100% integrado quando:

1. nenhuma operação financeira esperada estiver sem lançamento;
2. nenhum lançamento estiver sem origem;
3. nenhuma repetição de requisição duplicar valores;
4. cancelamentos preservarem o histórico e criarem estornos;
5. competência, contas a pagar/receber e caixa forem distinguíveis;
6. todas as divergências tiverem caminho operacional de resolução;
7. `prod` e `test` permanecerem estritamente separados;
8. a comparação entre o cálculo atual e o novo livro não apresentar diferença
   sem justificativa.

## 2. Decisões travadas

- Não haverá reescrita geral nem exclusão antecipada da arquitetura atual.
- As tabelas operacionais continuam sendo a origem dos eventos.
- O livro financeiro central será aditivo e viverá no mesmo Postgres.
- Durante a migração, somente um caminho poderá escrever cada fato financeiro.
- O cálculo antigo continuará disponível para comparação e rollback.
- Fato financeiro confirmado não será apagado; correção será feita por estorno.
- Nenhuma limpeza de dados de produção será executada sem autorização específica.
- Código e gatilhos antigos somente serão removidos depois da paridade comprovada.

## 3. Arquitetura de transição

```text
operação atual
    ├── tabelas operacionais atuais
    └── adaptador financeiro idempotente
             └── livro financeiro central

cálculo financeiro atual ───────┐
                                ├── comparador de paridade
livro financeiro central ───────┘
```

O novo livro ficará inicialmente atrás de feature flag. Ele não substituirá o
Financeiro atual até que a paridade seja comprovada por módulo.

## 4. Caminhos financeiros obrigatórios

| Origem | Fatos esperados |
|---|---|
| Venda varejo/atacado | receita, custo vendido, recebível ou caixa |
| Compra de pneus | ativo de estoque, contas a pagar ou caixa |
| Perda/quebra/ajuste de estoque | ganho ou perda de inventário |
| Logística | despesa aprovada, contas a pagar ou caixa |
| Rede | comissão/mensalidade a receber, recebimento e eventual devolução |
| Colaboradores | despesa de folha, contas a pagar e pagamento |
| Marketing | despesa aprovada; atribuição de venda apenas analítica |
| Cancelamento | estorno ligado ao lançamento original |

## 5. Etapas

### Etapa 0 — Baseline, contrato e guardas

Entregas:

- este plano executivo;
- mapa operação → fato financeiro;
- inventário dos writers atuais;
- testes de caracterização dos comportamentos vigentes;
- feature flags novas desligadas por padrão;
- relatório read-only de órfãos, duplicidades e operações sem financeiro.

Gate de saída:

- typecheck e testes unitários verdes;
- testes de integração executando em ambiente descartável;
- nenhum comportamento atual alterado.

### Etapa 1 — Corrigir furos críticos na arquitetura atual

Status: **concluída em 2026-07-27**.

1. Comissão recebida e depois cancelada:
   - preservar a entrada de caixa;
   - criar obrigação de devolução ou crédito;
   - não reescrever o período histórico.
2. Comprovante logístico:
   - impedir exclusão de despesa vinculada;
   - oferecer reparo idempotente para vínculo quebrado.
3. Estoque:
   - entrada avulsa exige natureza/origem;
   - perda, quebra e baixa manual geram perda financeira;
   - devolução de cancelamento falha se o estoque não for restaurado.
4. Folha:
   - considerar vigência do vínculo, inclusive desligados;
   - bloquear fechamento com eventos comissionáveis sem atribuição exigida.

Gate de saída:

- criação, repetição, cancelamento pré-pagamento e pós-pagamento cobertos;
- zero exclusão destrutiva de fatos confirmados;
- cálculo atual continua conciliando.

### Etapa 2 — Fundação do livro central

Status: **concluída em 2026-07-27; writer operacional desligado**.

Criar, por migration aditiva:

- cabeçalho imutável da transação financeira;
- linhas por natureza financeira;
- pagamentos parciais e seus estornos;
- chave única por ambiente + tipo de origem + origem;
- vínculo explícito entre lançamento original e estorno;
- trilha em `audit.events`;
- zero acesso do papel do parceiro às tabelas internas da Matriz.

O modelo final do banco deverá ser fechado somente depois dos testes de contrato
da Etapa 1, para não transportar ambiguidades operacionais para o livro.

### Etapa 3 — Vendas, Compras e Estoque

Status: **concluída em 2026-07-27**.

Ordem:

1. compras formais;
2. vendas atacado;
3. vendas varejo;
4. custo vendido;
5. entradas e perdas manuais de estoque;
6. cancelamentos e devoluções.

Gate por origem:

- backfill idempotente;
- execução incremental;
- diferença zero entre fonte e livro;
- rollback por feature flag.

### Etapa 4 — Logística e Marketing

Status: **concluída em 2026-07-27**.

- comprovante aprovado gera despesa uma única vez;
- combustível informado sem comprovante permanece como pendência operacional;
- despesa vinculada não pode ser apagada;
- gasto de marketing entra como despesa;
- atribuição de campanha não duplica receita de venda.

### Etapa 5 — Rede e Colaboradores

Status: **concluída em 2026-07-27**.

- comissão e mensalidade geram recebíveis por competência;
- baixa parcial e total preservam caixa;
- cancelamento pós-recebimento gera devolução/crédito;
- folha fechada gera despesa e obrigação;
- desligamento respeita período trabalhado;
- vendedor e entregador são exigidos quando a regra de comissão depender deles.

### Etapa 6 — Paridade e monitor de integração

Status: **concluída em 2026-07-27**.

Criar painel/read model com:

- operações sem lançamento;
- lançamentos sem origem;
- duplicidades;
- estornos ausentes;
- comprovantes quebrados;
- atribuições ausentes;
- competência ou data de caixa pendente;
- diferença entre cálculo atual e livro novo.

Estados:

- verde: conciliado;
- amarelo: pendente de informação/decisão;
- vermelho: inconsistente ou sem lançamento.

### Etapa 7 — Troca controlada da leitura

Status: **concluída em ambiente simulado em 2026-07-27; flag desligada por
padrão em produção**.

- Financeiro novo atrás de feature flag;
- alternância imediata para cálculo antigo;
- listas `A receber` e `A pagar` derivadas do livro central quando a leitura nova
  estiver ativa;
- baixas ausentes cobertas para varejo, marketing e devoluções, inclusive parcial;
- comparação registrada por pelo menos duas competências simuladas completas;
- somente depois, novo livro vira leitura padrão.

### Etapa 8 — Prova ponta a ponta e higiene dos ambientes

Status: **prova técnica concluída em ambiente descartável em 2026-07-27;
backup, rollout e higiene de produção ainda não executados**.

Cenário obrigatório:

```text
compra
→ estoque
→ venda
→ custo vendido
→ entrega
→ despesa logística
→ comissão da Rede
→ comissão do colaborador
→ folha
→ pagamentos
→ cancelamentos
→ estornos
→ conciliação final
```

Depois da prova:

- backup dos dados atuais;
- inventário dos registros de teste em `prod`;
- limpeza somente com autorização explícita;
- bloqueio permanente de seeds de teste em `prod`.

### Etapa 9 — Aposentadoria do código antigo

Somente após paridade e período de segurança:

- remover consultas financeiras duplicadas;
- remover gatilhos substituídos que possam duplicar lançamentos;
- remover feature flags de transição;
- preservar tabelas históricas e auditoria;
- registrar a remoção em ADR e migration quando houver objeto de banco.

## 6. Checklist obrigatório por operação

- [x] criação normal;
- [x] repetição/idempotência;
- [x] pagamento imediato;
- [x] pagamento pendente;
- [x] pagamento parcial;
- [x] cancelamento antes do pagamento;
- [x] cancelamento depois do pagamento;
- [x] estorno de pagamento;
- [x] mudança de competência;
- [x] tentativa de exclusão;
- [x] falha no meio da transação;
- [x] separação `prod`/`test`;
- [x] trilha de auditoria;
- [x] paridade com o cálculo anterior.

## 7. Política de parada

Uma etapa não avança se houver:

- teste de integração sem executar;
- diferença financeira sem explicação;
- escrita duplicada;
- migração sem rollback lógico;
- possibilidade de misturar ambientes;
- caminho de cancelamento incompleto;
- alteração destrutiva não autorizada.

## 8. Estado observado no início

- Estoque: compras e vendas formais integradas; caminhos manuais incompletos.
- Logística: aprovação de comprovante integrada; vínculo quebrado não reparável.
- Rede: ledger causal existe; estorno pós-recebimento reescreve indevidamente
  receita/caixa; mensalidade ainda não gera cobrança.
- Colaboradores: fechamento e pagamento da folha integrados no código; produção
  sem configuração e com atribuições incompletas.
- Regressão unitária completa: 810 testes aprovados.
- TypeScript: aprovado.
- Testes de integração dos dois primeiros lotes: 11 aprovados em PostgreSQL 17
  descartável.

## 9. Próximo passo executável

Preparar o rollout de produção, sem ligar a leitura central:

1. [x] obter e verificar um backup restaurável do banco atual;
2. [x] aplicar `0145`–`0151` com `MATRIZ_CENTRAL_LEDGER=false` e
   `MATRIZ_CENTRAL_LEDGER_READ=false`;
3. [x] executar o backfill e o monitor em produção;
4. [ ] ligar somente o writer e observar;
5. [x] consultar o portão de duas competências;
6. [ ] ligar a leitura central somente depois de monitor e portão verdes;
7. [ ] manter retorno imediato para `MATRIZ_CENTRAL_LEDGER_READ=false`.

Em 2026-07-27, `0145`–`0151` foram instaladas e o backfill foi executado em
produção por processo controlado, sem ligar as flags da aplicação. A segunda
passagem processou zero registros, os nove módulos ficaram verdes e o portão de
junho/julho fechou com diferença `0,00`. Writer permanente e leitura central
continuam pendentes.

## 10. Diário de execução

### 2026-07-27 — Etapa 0 e lotes 1–2 da Etapa 1

- Etapa 0 concluída: arquitetura de transição, contrato financeiro, riscos,
  gates e ordem de execução definidos.
- Logística: migration `0145` impede excluir despesa ligada a comprovante e
  adiciona reparo idempotente, restrito ao dono, para restaurar a mesma despesa.
- Rede: migration `0146` preserva receita e caixa históricos no cancelamento
  pós-recebimento e cria devolução pendente, com baixa auditada e idempotente.
- O Financeiro passa a separar a devolução de comissão entre competência,
  contas a pagar e saída de caixa.
- Nenhuma migration foi aplicada em produção e nenhum registro foi alterado.
- Validações: typecheck, manifesto de 147 migrations, fiscal de tamanho,
  810 testes unitários e 11 testes de integração aprovados.
- Próximos lotes da Etapa 1: Estoque e Folha.

### 2026-07-27 — Lotes 3–4 e fechamento da Etapa 1

- Estoque: migration `0147` cria ajustes financeiros imutáveis para entradas,
  perdas, quebras, consumo interno, definição e remoção manual.
- Entrada e baixa manual agora exigem natureza, justificativa e chave de
  idempotência; repetição da mesma operação não duplica estoque nem financeiro.
- Cancelamento de venda agora falha e desfaz a transação se não conseguir
  restaurar fisicamente o estoque.
- O lucro confirmado passou a considerar perdas e ganhos de inventário sem
  confundir movimento patrimonial com receita de venda.
- Folha: migration `0148` calcula elegibilidade pela vigência do vínculo na
  competência, inclusive para colaborador desligado depois de trabalhar no mês.
- O fechamento da folha é bloqueado quando há venda ou entrega comissionável sem
  vendedor/entregador exigido pelas regras vigentes.
- Ajustes de folha continuam possíveis para colaborador desligado, desde que ele
  tenha sido elegível na competência ajustada.
- Nenhuma migration foi aplicada em produção e nenhum registro de produção foi
  alterado.
- Validações finais: typecheck, manifesto de 149 migrations, sintaxe do painel,
  fiscal de tamanho, 818 testes unitários e 33 testes de integração críticos
  aprovados em PostgreSQL descartável.
- Etapa 1 encerrada; próximo lote: fundação imutável e aditiva do livro central.

### 2026-07-27 — Etapa 2 concluída

- Migration `0149` cria o livro central de forma exclusivamente aditiva e sem
  conectar writers operacionais.
- Cada fato tem origem única por `environment + source_type + source_id`,
  fingerprint da requisição, competência, eventual vencimento/caixa e trilha
  automática em `audit.events`.
- As partidas exigem débito e crédito exatamente iguais ao valor do cabeçalho;
  até inserção direta desbalanceada é rejeitada no fechamento da transação.
- Cabeçalhos, partidas e pagamentos são imutáveis. Correção financeira cria
  nova transação, nunca `UPDATE` ou `DELETE` do fato anterior.
- Estorno só é aceito quando referencia um original e espelha exatamente suas
  contas, lados e valores; estorno de estorno e segundo estorno são bloqueados.
- Pagamentos parciais são ligados à obrigação, excesso é bloqueado e o estorno
  integral reabre o saldo.
- `prod` e `test` aceitam a mesma identidade de origem sem se misturar.
- O papel `farejador_partner_app` não acessa tabelas nem funções novas; a
  migration preserva as permissões antigas fora desse escopo.
- A flag `MATRIZ_CENTRAL_LEDGER` existe e permanece `false` por padrão.
- Nenhuma migration foi aplicada em produção e nenhuma leitura da tela atual
  foi trocada.
- Validações: typecheck, manifesto de 150 migrations, fiscal de tamanho,
  819 testes unitários e 40 testes críticos de integração aprovados.
- Próximo lote: compras formais no livro central, começando em ambiente de
  teste e sem big bang.

### 2026-07-27 — Etapas 3–6 concluídas e Etapa 7 implementada

- Compras, vendas de atacado, vendas de varejo, custo vendido, estoque manual e
  cancelamentos passaram a escrever no livro central com idempotência.
- Despesas gerais, comprovantes aprovados, folha e gasto de campanha Meta
  passaram a produzir fatos financeiros sem duplicar a receita atribuída.
- Comissões preservam caixa histórico e geram devolução quando necessário.
- A mensalidade da Rede deixou de ser somente configuração e virou recebível
  imutável por parceiro e competência, com baixa auditada.
- O monitor geral atribui estado e nota a Financeiro, Compras, Atacado, Varejo,
  Estoque, Logística, Marketing, Rede e Colaboradores; também detecta órfãos,
  duplicidades, partidas desbalanceadas e datas de caixa ausentes.
- A leitura do livro central ficou atrás de `MATRIZ_CENTRAL_LEDGER_READ`, com
  comparação contra o cálculo anterior e fallback automático se o writer
  estiver desligado ou o monitor ficar vermelho.
- A tela Financeiro identifica qual leitura está ativa, eventual fallback e a
  diferença observada entre os dois cálculos.
- Foi corrigido um furo comum às leituras: o recorte mensal agora possui limite
  superior e não inclui lançamentos de competências futuras.
- Nenhuma migration foi aplicada em produção, nenhuma flag foi ligada em
  produção e nenhum registro foi limpo.
- Validações do lote: 152 migrations íntegras, typecheck aprovado, fiscal de
  tamanho aprovado, 823/823 testes unitários e 33/33 testes críticos do livro
  central aprovados em oito bancos PostgreSQL descartáveis.

### 2026-07-27 — Agenda central e caminhos de baixa

- Quando `MATRIZ_CENTRAL_LEDGER_READ=true`, as filas `A receber` e `A pagar`
  passam a vir do livro central, sem depender das somas antigas.
- A agenda agora inclui fiado, varejo a receber, comissão, mensalidade,
  fornecedor, despesa, folha, marketing e todas as devoluções.
- Fiado, fornecedor, despesa, folha, comissão, mensalidade e estorno de comissão
  continuam baixando pela operação da aba de origem, preservando uma única
  verdade operacional.
- Varejo, marketing e devoluções receberam baixa central auditada, idempotente,
  restrita ao dono e com suporte a pagamento parcial.
- No varejo, a forma de pagamento da venda só muda quando o saldo chega a zero.
- O pagamento de devolução de comissão passou a ser alocado contra a obrigação,
  eliminando saldo fantasma no livro.
- A rota HTTP foi provada com autenticação, rejeição sem credencial e replay da
  mesma chave retornando exatamente o resultado original.
- Nenhuma migration foi aplicada em produção e nenhuma flag foi ligada.
- Validações: 152 migrations íntegras, typecheck, sintaxe do painel, paridade de
  899 propriedades e 196 rotas, fiscal de tamanho, 824/824 testes unitários e
  35 testes críticos do livro central em PostgreSQL descartável.

### 2026-07-27 — Gates finais das Etapas 7 e 8

- O portão por competência compara fonte operacional e livro central,
  separadamente, para atacado, varejo, comissões, mensalidades, despesas,
  marketing, compras e estoque.
- Duas competências completas (`2026-06` e `2026-07`) foram simuladas com compra,
  entrada em estoque, venda, custo, frete e marketing; ambas terminaram com
  diferença absoluta `0,00`.
- A prova criou deliberadamente uma despesa sem lançamento: o portão ficou
  vermelho com diferença `1,00`; após o reparo idempotente, voltou a verde.
- O portão ficou disponível ao dono em
  `GET /admin/api/integrity/matriz-ledger/competences`, exigindo no mínimo duas
  competências no formato `YYYY-MM-01`.
- Um único cenário E2E percorreu compra, estoque, venda a receber, recebimento,
  entrega, despesa logística, marketing, comissão da Rede, mensalidade,
  comissão do colaborador, folha, pagamentos, cancelamentos, estornos e
  devoluções.
- O E2E terminou com agenda a pagar/receber zerada, zero partida desbalanceada,
  zero pagamento sem alocação, zero órfão e monitor geral verde.
- Validações finais: typecheck, 152 migrations íntegras, 899 propriedades e 197
  rotas em paridade, fiscal de tamanho, 824/824 testes unitários e 38/38 testes
  críticos em dez suítes PostgreSQL descartáveis.
- A auditoria de produção foi estritamente read-only: `0145`–`0151` ausentes,
  writer desligado e leitura central desligada. Nenhuma migration, flag ou dado
  de produção foi alterado.

### 2026-07-27 — Backup restaurável e preflight da produção

- O banco observado tinha aproximadamente 58 MB; o dump custom comprimido ficou
  com 3.306.535 bytes e SHA-256
  `B14A6581E64EF5183430EC71CD77A78C90070FB90DF9C103B47837FC2CB2D744`.
- O arquivo foi armazenado fora do repositório, com herança de ACL removida e
  acesso limitado ao usuário local e ao `SYSTEM`.
- A restauração em PostgreSQL 17 reproduziu 147 tabelas da aplicação e as
  contagens de `prod`: 6 vendas de atacado, 7 de varejo, 7 compras, 8 despesas,
  1 comissão, 0 itens de folha e 188 fatos diários de marketing.
- O primeiro ensaio encontrou três regras incorretas antes do rollout: limite de
  competência em UTC para compras, conta de devolução contada como despesa e
  três pedidos cancelados sem movimento físico tratados como baixa ausente.
- As regras foram corrigidas e receberam testes de regressão específicos.
- No segundo ensaio, `0145`–`0151` foram aplicadas somente à cópia restaurada;
  o backfill carregou todas as fontes e uma segunda execução processou zero.
- Resultado final da cópia: todos os módulos com nota 10, zero órfãos, zero
  duplicidades, zero partidas desbalanceadas, zero datas de caixa ausentes e
  portão de junho/julho verde com diferença `0,00`.
- Produção permaneceu sem qualquer escrita. O próximo passo destrava somente com
  autorização explícita para aplicar as migrations mantendo as duas flags
  desligadas.

### 2026-07-27 — Fundação instalada em produção

- Após autorização explícita, `0145`–`0151` foram aplicadas em uma única
  transação com advisory lock, `lock_timeout`, `statement_timeout` e rollback
  integral em caso de falha.
- Antes da escrita foram revalidados: SHA-256 do backup, manifesto das 152
  migrations, ambiente `prod`, flags desligadas e ausência de instalação parcial.
- A transação foi commitada com os sete gates de objeto presentes.
- As contagens das fontes operacionais permaneceram exatamente iguais às do
  backup; nenhuma venda, compra, despesa, comissão, folha ou fato de marketing
  foi alterado.
- O livro central nasceu vazio: zero transações, zero partidas e zero pagamentos.
- `MATRIZ_CENTRAL_LEDGER=false` e `MATRIZ_CENTRAL_LEDGER_READ=false` continuam
  confirmadas. Naquele ponto, backfill, writer e leitura ainda não haviam sido
  ativados.
- O passo seguinte foi o backfill controlado descrito abaixo.

### 2026-07-27 — Backfill concluído em produção

- O backfill foi executado com o writer habilitado somente no processo
  operacional e a leitura central desligada.
- Primeira passagem: 7 compras, 6 vendas de atacado, 7 vendas de varejo,
  4 ajustes de estoque, 8 despesas e 76 fatos diários de marketing.
- Foram criadas 134 transações, 268 partidas dobradas e 1 pagamento no ledger.
- A segunda passagem processou zero em todos os módulos, confirmando
  idempotência.
- Financeiro, compras, atacado, varejo, estoque, logística, marketing, rede e
  colaboradores ficaram verdes, nota 10 e zero sinais de erro.
- As reconciliações das etapas 3, 4 e 5 ficaram verdes.
- O portão das competências de junho e julho ficou verde, com diferença
  absoluta total de `0,00`.
- As flags permanentes da aplicação continuam desligadas. Próximo passo:
  publicar o código dormente e, depois, ligar somente o writer sob observação.
