-- 0099 — Carimbo do OPERADOR na venda (tijolo-mestre da comissão por pessoa, Bloco 2).
--
-- Contexto (decisão do dono 2026-06-12): a comissão passa a ser POR PESSOA, e a regra
-- fechada é "quem FINALIZA a venda ganha". Hoje a venda só registra a LOJA
-- (commerce.partner_orders.closed_by = 'partner:<slug>') — não a pessoa que operou.
-- Sem saber QUEM finalizou, não há como somar comissão por funcionário. Este é o
-- alicerce: passa a anotar o operador. NÃO muda nada pro cliente nem pro estoque.
--
-- Por que SÓ uma coluna (e não mexer em register_partner_local_order):
--   - O login já identifica a pessoa: network.partner_access_tokens.id é o vínculo
--     pessoa↔loja (tem person_id [0095] e role). Esse id já vive em ctx.tokenId no
--     backend. Então basta GUARDAR esse id na venda — a pessoa sai por JOIN.
--   - A função-contrato register_partner_local_order (estoque+reserva) fica
--     BYTE-IDÊNTICA. O carimbo é um UPDATE no app layer, na MESMA transação da venda
--     (withPartnerContext = BEGIN/COMMIT), igual ao que já é feito com notes/received_amount.
--   - Loose coupling proposital (como closed_by é texto): SEM FK cross-schema
--     commerce→network. Token é revogado (revoked_at), nunca deletado → o id é estável;
--     uma venda antiga nunca deve quebrar por causa de um login removido.
--
-- Semântica do valor:
--   NULL  = venda criada pelo BOT/Rede, ou anterior a esta migration (operador desconhecido = a LOJA).
--   <uuid>= o login (pessoa+loja) que FINALIZOU a venda no balcão. Base da comissão por pessoa.
--   (Para pickup/entrega, o "finaliza" é o passo "marcar retirado/entregue" — carimbo de
--    um tijolo irmão, não deste; a coluna é genérica e serve aos dois.)
--
-- ADITIVA e dormente: enquanto o backend não passar o operador, a coluna fica NULL e
-- NADA muda. Nenhum dependente, nenhum backfill (vendas antigas = NULL = honesto).
--
-- ─────────────────────────────────────────────
-- ROLLBACK (reverter o backend primeiro; o código antigo não lê esta coluna):
--   DROP INDEX IF EXISTS commerce.partner_orders_operator_token_idx;
--   ALTER TABLE commerce.partner_orders DROP COLUMN IF EXISTS operator_token_id;
-- ─────────────────────────────────────────────

ALTER TABLE commerce.partner_orders
  ADD COLUMN IF NOT EXISTS operator_token_id UUID;

COMMENT ON COLUMN commerce.partner_orders.operator_token_id IS
  'Login (network.partner_access_tokens.id = vínculo pessoa↔loja) que FINALIZOU a venda. Base da comissão por pessoa (Bloco 2, 0099). NULL = bot/Rede ou pré-0099 (operador = a loja). Sem FK de propósito (loose coupling, como closed_by): token é revogado, não deletado.';

-- Índice parcial: a tela "Comissão da equipe" soma vendas POR operador no mês.
-- Só as linhas carimbadas importam (NULL = loja, não entra na soma por pessoa).
CREATE INDEX IF NOT EXISTS partner_orders_operator_token_idx
  ON commerce.partner_orders (environment, unit_id, operator_token_id)
  WHERE operator_token_id IS NOT NULL AND deleted_at IS NULL;
