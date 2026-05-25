-- 0057_order_number_sequential.sql
-- Adiciona order_number amigavel (PED-0001, PED-0002, ...) em commerce.orders
-- pra ser citado pro cliente no resumo de fechamento.
--
-- Antes: orders identificadas so por UUID (a7b3c9d2-...), imprestavel pra falar com cliente.
-- Depois: cada order tem order_number text UNIQUE NOT NULL com default da sequence.
--
-- Funcoes que ja inserem em commerce.orders nao precisam ser tocadas — DEFAULT cobre.

BEGIN;

-- 1. Sequence dedicada
CREATE SEQUENCE IF NOT EXISTS commerce.order_number_seq START 1 INCREMENT 1;

-- 2. Adicionar coluna nullable primeiro (pra backfill)
ALTER TABLE commerce.orders
  ADD COLUMN IF NOT EXISTS order_number text;

-- 3. Backfill orders existentes (se houver)
UPDATE commerce.orders
   SET order_number = 'PED-' || lpad(nextval('commerce.order_number_seq')::text, 4, '0')
 WHERE order_number IS NULL;

-- 4. Aplica NOT NULL + DEFAULT pra inserts futuros
ALTER TABLE commerce.orders
  ALTER COLUMN order_number SET NOT NULL,
  ALTER COLUMN order_number SET DEFAULT ('PED-' || lpad(nextval('commerce.order_number_seq')::text, 4, '0'));

-- 5. Unique constraint
ALTER TABLE commerce.orders
  ADD CONSTRAINT orders_order_number_unique UNIQUE (order_number);

-- 6. Indice na sequencia ja existe via UNIQUE constraint acima.

COMMIT;
