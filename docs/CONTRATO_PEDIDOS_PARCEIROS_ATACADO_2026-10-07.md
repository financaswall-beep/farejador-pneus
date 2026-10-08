# Pedido do parceiro → aprovação → despacho → recebimento → pagamento

Contrato aprovado pelo usuário em 07/10/2026 e implementado localmente. A migration de produção, push e deploy são etapas posteriores à preparação e aos testes deste lote.

## O que existe e será reaproveitado

- `src/parceiro/operation-buy-catalog.ts`: consulta as ofertas publicadas; envio habilitado quando a migration está instalada e o financeiro de atacado existente está ativo.
- `db/migrations/0267_catalog_wholesale_prices.sql` e `0268_partner_wholesale_catalog.sql`: preço de atacado separado do varejo/bot; consulta do parceiro expõe somente ofertas inequívocas e saldo físico menos reservas.
- `src/admin/painel/queries-atacado-vendas.ts`: uma venda atual já baixa estoque físico, congela custo, cria compra vinculada ao parceiro e registra a transferência em trânsito. Não deve ser chamada ao enviar ou aprovar o carrinho.
- `src/admin/painel/wholesale-partner-bridge.ts`: vincula uma venda a uma única compra e obrigação do parceiro.
- `src/admin/painel/queries-partner-transfer-arrival.ts`: calcula quantidades aceitas, ajusta total e cria carga recusada. Pneus recusados continuam em trânsito até retorno físico comprovado.
- `src/parceiro/operation-purchase-receipt.ts`: entrada física no estoque do parceiro com custo médio, auditoria e idempotência. Atualmente exige acerto prévio da matriz e bloqueia quantidades divergentes.
- `src/admin/painel/queries-financeiro-integridade.ts`: confirmação de pagamento existente sincroniza matriz e parceiro, sem alterar estoque.

## Contrato proposto

| Ação | Estoque matriz | Estoque parceiro | Financeiro |
|---|---|---|---|
| Enviar carrinho | Sem reserva ou baixa física | Sem entrada | Sem venda/obrigação/caixa |
| Confirmar e separar | Reserva somente saldo livre | Sem entrada | Sem recebimento ou venda concluída |
| Registrar saída do galpão | Consome a própria reserva e baixa o físico em uma única transação | Cria compra pendente de recebimento | Usa a transferência existente; sem marcar dinheiro recebido |
| Confirmar recebimento | Acerta quantidades aceitas; recusadas permanecem como carga em trânsito | Entrada somente das quantidades aceitas | Reconhece o valor efetivamente aceito a receber; pagamento segue pendente |
| Confirmar pagamento pela matriz | Sem nova saída | Sem nova entrada | Liquida a obrigação existente e registra caixa uma única vez |

O motor atual `cash_on_arrival` marca pagamento durante o acerto. Os pedidos originados no app precisam usar pagamento pendente nesse momento, para recebimento físico não virar comprovação de dinheiro. Datas e condição de cobrança serão explicitadas pela matriz; não copiar o vencimento solicitado pelo cliente sem validação.

## Estrutura nova necessária

Migration prevista `0271_partner_wholesale_requests.sql`, sem alterar os dados atuais:

- `commerce.partner_wholesale_requests`: unidade e ambiente, chave de idempotência, data, estado, total cotado, vínculo único com a venda de atacado no despacho e auditoria das decisões.
- `commerce.partner_wholesale_request_items`: produto/oferta, medida canônica, marca, condição, tipo carro/moto, quantidade e preço cotado em centavos.
- Estados: aguardando aprovação, em separação, recusado/cancelado antes da saída e despachado. Recebimento/pagamento serão derivados dos documentos existentes, evitando manter dois controles concorrentes.
- Unidade e ambiente derivados da sessão; acesso do parceiro somente aos próprios pedidos; sem acesso direto a custo/margem ou tabelas financeiras da matriz.
- Função de envio com privilégios limitados, contexto obrigatório e validação do catálogo. Nenhuma escrita genérica concedida ao parceiro nas tabelas centrais.

## Invariantes de implementação

1. Envio valida oferta publicada, preço esperado, quantidade inteira e ausência de itens duplicados; o servidor calcula o total. Uma mesma chave com corpo diferente é conflito.
2. Aprovação revalida preço e disponibilidade sob bloqueio de linhas. Oferta ou preço alterado exige nova concordância do parceiro; a matriz não cobra outro valor silenciosamente.
3. Reservas usam `commerce.wholesale_stock.quantity_reserved`, já respeitado pelo varejo, atacado, catálogo e contagem física. Cada pedido guarda a variante e quantidade reservada; cancelamento libera somente sua própria reserva.
4. Despacho libera a reserva própria e chama o motor de venda existente dentro da mesma transação. Falha em qualquer etapa reverte todas as alterações. Reenvio não cria segunda venda, compra ou baixa.
5. Entrada do parceiro preserva produto e tipo carro/moto provenientes da oferta; a ponte atual preenche `product_id` vazio e precisa ser ajustada apenas para pedidos vinculados a essa origem. Isso evita perder a classificação no estoque e sua leitura pelo bot.
6. Recebimento com divergência usa o acerto existente e a entrada física na mesma transação, com todos os itens identificados. Quantidade excedente não entra sem documento complementar. Recusa não aumenta estoque da matriz antes do retorno.
7. Recebimento e pagamento são confirmações distintas. Não aceitar `paid` informado pelo app como comprovação. Reusar os lançamentos e liquidações existentes, incluindo idempotência e trava contra cancelamento concorrente.
8. O preço de venda do bot continua vindo da tabela central de varejo. Atacado da compra é custo de aquisição do parceiro, sem substituir o preço ofertado ao consumidor.
9. Mudanças em funções existentes devem permitir compartilhar a transação sem substituir os endpoints atuais de venda, acerto ou recebimento. As chamadas antigas mantêm seu comportamento.

## Interface funcional desta etapa

- Matriz: bloco "Pedidos dos parceiros" dentro de `Vendas → Atacado`, com ações distintas "Confirmar e separar", "Registrar saída" e recusa/cancelamento anterior à saída. Usar o visual atual durante o fechamento do motor.
- Parceiro: habilitar o envio do carrinho após a migration e apresentar seus pedidos e confirmação do recebimento dentro da área Comprar.
- Manter o pagamento nas ações financeiras existentes da matriz; a nova tela deve mostrar seu estado e vínculo, sem lançar um segundo financeiro.
- O redesign metálico aprovado é uma etapa visual posterior, sem misturar sua implementação com o contrato de estoque/dinheiro.

## Verificação

- 36 testes unitários existentes passaram: estoque de atacado, ponte matriz/parceiro, interface de transferência, recebimento, custo médio, catálogo e carrinho.
- 11 testes de integração passaram em PostgreSQL local descartável: transferência matriz/parceiro, pagamento versus cancelamento concorrentes e isolamento do catálogo. Total desta investigação: 47 testes aprovados (36 unitários + 11 de integração), sobre o código atual, antes da implementação nova.
- Testes novos cobrem concorrência entre aprovações, recusa versus despacho, venda contra saldo reservado, reenvio após timeout, falha no despacho e na entrada, recebimento parcial de duas variantes, retorno físico, pagamento separado sem duplicação, isolamento de unidade e carro/moto.
- Rodada final da implementação: 42 testes unitários e 22 testes de integração aprovados (64 no total), com PostgreSQL local descartável. Typecheck, teto de módulos, manifesto de migrations, paridade de montagem/rotas e isolamento de pools verificados.
- A prova de pools continua com as mesmas 14 exceções herdadas. A ponte de recebimento fica no módulo administrativo e é injetada explicitamente pelo bootstrap; o catálogo/envio/leitura do parceiro continuam na conexão restrita.
- O documento vinculado à compra mantém a identidade física do despacho. A entrada no estoque parceiro usa os nomes normalizados congelados na solicitação, sem relaxar o guard dos documentos vinculados.
- Nenhuma flag nova: o envio exige `WHOLESALE_FINANCE`; os lançamentos reaproveitam o comportamento de `MATRIZ_CENTRAL_LEDGER`. A recusa anterior à saída pode liberar reserva mesmo se o financeiro for desabilitado.

## Situação da entrega

Migration `0271_partner_wholesale_requests.sql` criada, com tabelas, validação de ambiente, RLS, envio idempotente e consulta limitada aos documentos da própria unidade. O código conecta aprovação, despacho e recebimento aos motores existentes. Interface funcional dentro de Vendas → Atacado e acompanhamento dentro de Comprar. A produção permanece sem alterações deste lote até a solicitação de migration e push/deploy.
