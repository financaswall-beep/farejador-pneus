# Compra de lote — primeira etapa

Acesso: **Compras → Comprar lote** (proprietário). Página específica para uma compra de lote, com fornecedor, descrição, quantidade, custo total, frete, desconto e datas. Não exige marca ou medida. A divisão por pneu é informativa: o total em centavos permanece como base do estoque e do financeiro.

## Comportamento

- Uma compra gera um lote identificado. Compras recebidas disponibilizam o saldo; compras a caminho aguardam confirmação pelo histórico de Compras.
- Pagamento pode estar realizado ou pendente, com vencimento. Usa as contas e lançamentos existentes; recebimento não cobra novamente.
- Recebimento nesta etapa é integral. Divergência de quantidade/valor exige cancelar e registrar a compra corrigida.
- Cancelamento preserva o histórico e reverte o saldo quando está integralmente disponível. Valores já pagos seguem o fluxo existente de crédito/reembolso do fornecedor.
- Reenvio repete a mesma chave e o mesmo conteúdo; não cria outra compra. O rascunho fica somente na sessão do navegador e não movimenta o banco.
- Lotes ficam em `commerce.tire_lots`, com movimentos imutáveis em `commerce.tire_lot_movements`. Não entram no catálogo nem no estoque por medida consultado pelo bot.
- Histórico e relatórios de compras incluem os lotes. Comparação de preço por medida continua usando somente produtos por medida.

## Publicação

A migration **0230_wholesale_purchase_lots.sql** foi aplicada e registrada em produção antes do envio do código. Versão do banco conferida: **230**, com as tabelas de lotes, movimentos e a visão de relatórios presentes. Não há variável nova; pagamento a prazo segue o sinalizador existente `WHOLESALE_FINANCE` e o livro central segue `MATRIZ_CENTRAL_LEDGER`.

## Verificação

- Typecheck e build completos passaram. 43 testes unitários de lotes, auditoria, datas e relatórios passaram.
- Replay das 231 migrations em PostgreSQL local via PGlite, mais 7 testes de integração (fluxo novo e regressão das compras comuns). Docker não estava disponível; o ensaio não usou o banco online.
- Provados: total com divisão inexata, frete/desconto, quatro combinações pagamento/recebimento, quitação posterior, cancelamento antes/depois da chegada, idempotência, bloqueio de reversão com reserva, movimentos imutáveis, isolamento de ambiente, histórico, relatório e conferência do livro central.
- Navegador com APIs locais de teste: entrada pelo painel, cálculo, rascunho e envio; larguras 1600 e 390 px. A inicialização geral apresentou 13 erros `row is not defined`, reproduzidos também na versão HEAD anterior; a tela nova não acrescentou erros durante as interações.
- Fiscal de tamanho passou nos arquivos desta alteração. O comando global e a prova antiga de paridade continuam com pendências anteriores em outros módulos/snapshot; os limites e a referência não foram ampliados.

As telas **Estoque → Lotes** e **Venda de lote** são as próximas etapas combinadas, ainda não implementadas.
