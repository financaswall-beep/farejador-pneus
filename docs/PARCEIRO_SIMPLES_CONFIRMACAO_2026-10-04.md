# App simples do parceiro

O acesso de parceiro em `/operacao` usa a interface simples. O acesso da Matriz
continua com a operação completa. O menu simples não encaminha ao painel antigo.

Na página inicial aparecem apenas ações existentes: cliente esperando confirmação,
foto solicitada, retirada pendente e entrega pendente. Uma categoria sem pendências
some. Os números contam pedidos, não categorias. Os avisos se atualizam enquanto
o app estiver aberto; esta etapa não implementa push com o app fechado.

## Confirmação do estoque do parceiro

1. A busca comercial elege a loja pelos motores atuais de localização e estoque.
2. Quando a loja escolhida é parceira, o bot registra a consulta e informa ao cliente
   que está confirmando. O texto final tem trava determinística contra a promessa antecipada.
3. O parceiro vê medidas, condição, quantidade e prazo real de cinco minutos. Nome,
   telefone e IDs da conversa não fazem parte dessa fila pública.
4. TENHO confirma por dez minutos. Isso ainda não reserva: a reserva continua no
   fechamento já existente do pedido. NÃO TENHO e prazo vencido excluem essa loja
   daquela consulta e tentam outra que atenda o conjunto completo.
5. A resposta ao cliente usa a outbox existente. Se já havia dados completos e
   autorização para fechar, a continuação usa o mesmo criar_pedido, com suas
   validações e idempotência. Uma mensagem nova impede esse fechamento automático.
6. A Matriz não recebe a consulta. Se a próxima opção válida for Matriz, o bot
   apresenta essa alternativa ao cliente, sem trocar silenciosamente a loja.

Não dividimos o conjunto entre lojas. A resposta NÃO TENHO não zera todos os SKUs:
num conjunto com duas medidas, isso não informa qual delas faltou. Quantidade parcial
e correção automática do cadastro ficam para o fluxo específico de quantidade.

As consultas de medidas de um mesmo turno são agrupadas antes de publicar a tela.
Se o cliente pede foto durante a espera, o pedido fica associado à consulta e só
é encaminhado à loja que confirmar. Rerotear preserva esse pedido de foto.
Uma nova quantidade, loja ou conjunto exige nova confirmação. Fotos continuam nos
endpoints existentes, com compressão e até três imagens. Retirada e entrega usam
os motores atuais de conclusão e baixa; cancelamento de retirada pede confirmação.

## Implantação

Na instalação atual, a migration 0261 foi aplicada em produção em 04/10/2026.
O executor registrou a versão 261 e o checksum foi conferido após o commit.
O código ainda exige deploy e ativação da flag abaixo para habilitar o novo fluxo.

- Aplicar `db/migrations/0261_partner_stock_confirmation.sql` pelo aplicador oficial,
  depois de `npm run check:migrations`. Nenhuma migration histórica foi alterada.
- Fazer deploy do código e configurar `PARTNER_STOCK_CONFIRMATION=true`.
- A continuação depende dos workers atuais `AGENT_V2_WORKER_ENABLED=true` e
  `BOT_OUTBOX=true`, respeitando o escopo de conversas já configurado.
- Sem a nova flag, a mudança do bot permanece desligada. O app simples continua
  atendendo foto, retirada e entrega existentes. Com a flag ligada e a migration
  ausente, o servidor recusa iniciar e informa exatamente a migration faltante.

Vendas e Meus pneus já têm vistas simples de leitura dos motores atuais. Cadastro,
ajustes de quantidade, compra na 2W e configurações completas continuam etapas
posteriores; a compra fica indisponível em vez de abrir a interface da Matriz.

Prévia local, sem banco e sem Chatwoot: `node scripts/prova-parceiro-inicio.cjs`.
Use `/_preview/parceiro?cenario=avisos#pedidos`, `cenario=esperando`, `cenario=foto`,
`cenario=retirada` ou `cenario=entrega`. Esses dados são explicitamente fictícios.
