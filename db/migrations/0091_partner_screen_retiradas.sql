-- 0091 — Tela própria "Retiradas" no painel do parceiro (separa balcão de rota).
--
-- Decisão Wallace 2026-06-08. A fila de retirada reservada do bot vivia enterrada
-- na aba Entrega; vira tela própria pra casar com a permissão por tela: balconista
-- vê só Retiradas, motorista vê só Entrega.
--
-- Aditivo e seguro: nova coluna allow_retiradas em network.partner_unit_permissions.
-- DEFAULT true = comportamento operacional de hoje (a retirada já era visível pra
-- quem via Entrega). Linhas existentes herdam true; o dono pode desligar depois.
-- Espelha o padrão das outras 8 telas (allow_vendas, allow_entregas, ...).

ALTER TABLE network.partner_unit_permissions
  ADD COLUMN IF NOT EXISTS allow_retiradas boolean NOT NULL DEFAULT true;
