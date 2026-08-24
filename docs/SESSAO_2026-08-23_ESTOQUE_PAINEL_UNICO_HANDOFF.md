# Handoff — Estoque no painel único do parceiro

Data: 2026-08-23

## Resultado

O módulo **Estoque** foi habilitado no mesmo painel moderno usado pela Matriz,
mas com apresentação e permissões próprias da unidade parceira. O Estoque da
Matriz continua intacto: galpão, custos, conciliação e ações administrativas só
são montados quando a sessão é `matrix`.

No parceiro, a tela consome exclusivamente as rotas já auditadas de
`/parceiro/:slug/api/operacao/estoque`. Essas rotas exigem sessão `ps_`, a
permissão `estoque`, plantam `partner_unit_id` no contexto restrito e consultam
somente `environment + unit_id` da unidade autenticada.

## O que a unidade passa a ver

- saldo físico, reservado e disponível;
- itens críticos e serviços cadastrados;
- busca por medida, marca, produto ou código;
- filtros de críticos, reservados e serviços;
- logotipo da marca quando reconhecido;
- preço de venda, localização, código e histórico de movimentações;
- solicitação de contagem para aprovação do proprietário.

A contagem não altera saldo diretamente. Quantidade menor que a reserva é
recusada na interface e a solicitação válida segue pelo fluxo pendente e
idempotente já existente. Custos da Matriz nunca são enviados para essa tela.

## Banco e telemetria

A operação de estoque reutiliza as tabelas e regras existentes. A única migration
nova é a `0205_partner_stock_panel_canary.sql`, aditiva, que amplia a telemetria
técnica do painel para `estoque`, `load_stock`, `load_stock_detail` e
`request_stock_count`. Ela não altera estoque, reservas, custos, vendas ou
permissões.

## Provas concluídas

- build TypeScript e CSS: aprovado;
- prova completa do painel: aprovada;
- paridade do painel moderno: 1.251 propriedades, aprovada;
- paridade de rotas da Matriz: 261 rotas, aprovada;
- fiscal de tamanho: aprovado;
- manifesto: 206 migrations, aprovado;
- suíte unitária: 275 arquivos e 1.361 testes, aprovada;
- navegador local desktop (1280 px): sem overflow horizontal;
- navegador local mobile (390 px): sem overflow horizontal, cards e menu inferior aprovados;
- detalhe e histórico pela rota escopada: aprovados;
- bloqueio de contagem abaixo da reserva e idempotência: aprovados.

## Pendência antes do deploy

O replay PostgreSQL em banco limpo não rodou nesta estação porque o Docker
Desktop não respondeu nem a `docker version`. Isso não reprova o código, mas a
migration 0205 ainda deve passar pelo CI PostgreSQL ou por replay local antes de
ser aplicada. Não houve commit, push, aplicação em produção ou deploy nesta
etapa.
