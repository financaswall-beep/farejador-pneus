# Lista de espera

Acesso: **Bot → Lista de espera** no painel e **Atendimento → Lista de espera** no `/operacao`.

O recurso reaproveita `ops.stock_interests`. O bot oferece aviso pelo WhatsApp somente após constatar falta de estoque. O cliente precisa aceitar; um “sim” só vale após uma oferta real enviada na conversa. Em canais sociais, o número deve ter sido informado pelo cliente. Na conversa WhatsApp, pode ser reutilizado o telefone válido do contato. A ferramenta recebe medida, condição, tipo de veículo e quantidade. Não cria pedido nem reserva estoque.

O painel consulta o estoque físico da loja principal com as mesmas travas de venda de `matrizStockForMeasure`, descontando reservas e separando carro/moto e condições. A região é reaproveitada da análise de demanda. **Saldo disponível não confirma entrega para a região:** a equipe deve conferir entrega ou retirada antes da oferta. Não são somados estoques de parceiros ou lotes sem medida.

As telas atualizam a cada 30 segundos enquanto abertas. A abertura do WhatsApp reconsulta o saldo, usa o número autorizado e prepara a mensagem editável. Não envia automaticamente. “Já enviei · marcar como avisado” exige confirmação do operador e registra a declaração com autor e data. Os registros antigos sem quantidade ficam sinalizados e fora dos totais de quantidade/disponibilidade até nova confirmação.

A consulta respeita ambiente, conta Chatwoot e contatos/conversas não apagados. O painel exige proprietário; o app segue a proteção de acesso às conversas. Transições usam versão para evitar alterações simultâneas e produzem eventos técnicos em `ops.stock_interest_events`. O registro do bot roda em transação e evita duplicação do mesmo interesse/WhatsApp em canais diferentes. Dados de teste nunca são inseridos em produção.

## Publicação

- Aplicar `0245_stock_waitlist.sql` antes de publicar o código. O manifesto registra o checksum.
- Não há variável nova. O recurso deixa de depender do botão de atribuição de campanhas orgânicas.
- Nenhuma mudança em Chatwoot, Meta ou envio de mensagens é necessária para abrir a lista.

## Validação

`tests/integration/stock-waitlist.integration.test.ts` cobre consentimento real, telefone, duplicidade concorrente, reservas, veículo, custo, isolamento, revogação, auditoria e concorrência nas alterações. A regressão orgânica mantém o comportamento dos interesses já existentes.
