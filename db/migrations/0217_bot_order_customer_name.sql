-- O fechamento do Bot V2 (matriz E espelho dos parceiros) já grava/lê este
-- retrato do nome informado na conversa, mas a coluna nunca foi versionada.
-- Aditiva: não altera pedidos existentes, estoque, reservas ou contatos.
ALTER TABLE commerce.orders ADD COLUMN IF NOT EXISTS customer_name TEXT;

COMMENT ON COLUMN commerce.orders.customer_name IS
  'Nome informado no fechamento pelo bot. Snapshot opcional do pedido, sem alterar core.contacts.';
