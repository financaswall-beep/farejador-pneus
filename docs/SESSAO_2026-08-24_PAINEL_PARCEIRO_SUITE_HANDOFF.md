# Handoff — suíte operacional do parceiro no painel único

Data: 2026-08-24

## Resultado

O mesmo casco moderno da Matriz agora contém projeções próprias do parceiro para
**Vendas, Compras, Estoque, Logística, Financeiro, Colaboradores e Catálogo**.
Não foi criado outro sistema nem outro banco. A interface escolhe a projeção pelo
tipo da sessão e cada tela do parceiro usa somente `/parceiro/:slug/api/*`.

Marketing, Bot, Rede, galpão central, custos da Matriz, livro financeiro central
e dados de outras unidades continuam fora do menu e fora das respostas do
parceiro. As telas originais da Matriz permanecem montadas somente no escopo
`matrix`; seus loaders e contratos não foram trocados.

O `/operacao` móvel continua ativo e usa as mesmas rotas transacionais do
parceiro. Esta entrega amplia o desktop moderno; não cria um segundo motor de
venda, estoque ou financeiro.

## O que foi entregue

- **Vendas:** histórico, busca, cancelamento e nova venda com preço negociado,
  retirada ou entrega, pagamento recebido ou fiado. A soma usa centavos
  inteiros; o caso `2 × 45,01 + 45,00` fecha em `R$ 135,02`.
- **Compras:** histórico, nova compra e cancelamento. Custo em branco é recusado;
  registrar a compra não finge recebimento físico no estoque.
- **Estoque:** saldo físico, reservado e disponível, filtros, detalhe,
  movimentações e solicitação de contagem sujeita à aprovação.
- **Logística:** fila ativa e histórico paginado, despacho, entrega, falha,
  retorno confirmado, comprovante e contato pelo WhatsApp.
- **Financeiro:** competência, caixa realizado, contas a receber e a pagar,
  despesas, baixas, perda e recuperação de crédito. O navegador apresenta os
  valores do servidor e não recompõe lucro ou caixa por conta própria.
- **Colaboradores:** cadastro, acesso, permissões, remuneração, comissão,
  redefinição de senha, revogação e reativação. A tela é exclusiva do dono.
- **Catálogo:** produtos e serviços, preço e saldo local, filtros e motos
  compatíveis. A tela é exclusiva do dono e não expõe custo, margem,
  proveniência interna nem estoque da Matriz.

## Segurança e isolamento

- sessão do parceiro continua com prefixo `ps_`;
- toda chamada nova passa pelo cliente escopado do parceiro;
- o servidor planta `partner_unit_id` no pool restrito antes das consultas;
- Vendas e produtos deixam de devolver snapshots de custo ao painel parceiro;
- Compras reutiliza a permissão financeira já exigida pelas rotas existentes;
- Logística reutiliza a permissão de entregas;
- Colaboradores e Catálogo são `owner-only` até existir permissão canônica
  específica;
- Marketing, Bot e Rede não são derivados nem liberados implicitamente.

## Banco

- `0205_partner_stock_panel_canary.sql`: amplia somente a telemetria técnica do
  canário para Estoque. Não altera saldo, custo, reserva ou venda.
- `0206_partner_panel_catalog_read_grants.sql`: concede apenas `SELECT` em
  `commerce.vehicle_models` e `commerce.vehicle_fitments` e revoga explicitamente
  todas as escritas nessas duas relações.
- o contrato do papel `farejador_partner_app` passa conscientemente de 71 para
  **73 grants**, com hash novo e as tabelas sensíveis da Matriz ainda na denylist.

As migrations `0205` e `0206` foram aplicadas no projeto novo de produção em
`sa-east-1` e verificadas numa segunda conexão. O pós-estado comprovou:

- telemetria com `estoque`, `load_stock`, `load_stock_detail` e
  `request_stock_count`;
- dois grants de `SELECT` para o catálogo técnico;
- zero grants de escrita nessas duas relações.

Antes da aplicação foi gerado um dump completo em formato custom do PostgreSQL,
validado com `pg_restore --list` e conferido por SHA-256. O arquivo permanece
somente em `.codex-tmp/backups/` e não faz parte do Git.

O executor versionado `scripts/aplicar-0205-0206-prod.cjs` exige autorização
explícita, ambiente `prod`, região e referência exata do projeto Supabase,
manifesto íntegro e hash do backup. Ele executa as duas migrations em uma única
transação, com lock, timeouts, dry-run, rollback e pós-verificação.

## Provas concluídas

- build CSS + TypeScript: aprovado;
- 1.385 testes unitários em 279 arquivos: aprovados;
- prova completa do painel: aprovada;
- roteamento: `/operacao` e desktop parceiro convergem no mesmo motor com RLS;
- paridade do painel legado móvel: 599 propriedades, aprovada;
- painel moderno: 1.343 propriedades, sem remoção ou mudança de tipo;
- contratos de rede: 95 itens, aprovados;
- rotas da Matriz: 267, sem remoção ou alteração; seis arquivos estáticos novos
  registrados conscientemente;
- fiscal de tamanho: 562 arquivos, todos dentro do teto;
- manifesto: 207 migrations, checksums íntegros;
- `git diff --check`: aprovado.
- pós-migration: 49 testes focados da suíte moderna do parceiro, aprovados.

A bateria PostgreSQL/Testcontainers foi iniciada, mas o executor desta estação
ficou sem espaço no disco C: e o daemon não respondeu: os testes expiraram como
**pulados**. A execução foi encerrada e não é contabilizada como aprovação nem
como falha do sistema. O workflow de CI executa `npm run test:integration` em
ambiente limpo; seu resultado é portão obrigatório para incorporar a entrega à
`main`.

## Estado de publicação

O banco já está preparado com `0205` e `0206`. O código correspondente deve ser
incorporado à `main` somente após o CI, e o deploy continua manual, sob controle
do proprietário. Depois do deploy, o fechamento exige smoke autenticado de
Matriz e parceiro.
