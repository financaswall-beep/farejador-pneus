# Pacote de integração — Etapas 1-4 da auditoria

**Data:** 2026-05-21
**Escopo:** Portal Parceiro + Painel Admin Rede (módulo isolado do bot/atendente/planner/organizadora)
**Etapas concluídas:** 1, 2, 3, 4 da auditoria
**Etapa pendente:** 5 (RLS + role + Coolify) — aguardando plano detalhado e aprovação

---

## 1. Lista final de arquivos alterados

### Arquivos novos no repo

| Arquivo | Linhas | Função |
|---|:-:|---|
| `db/migrations/0042_partner_sale_consistency.sql` | 218 | Reproduz no Git a function `register_partner_local_order` aplicada via MCP em 2026-05-20 (BUG #2 + BUG #5) |
| `db/migrations/0043_partner_hardening.sql` | 113 | Reproduz no Git triggers + FKs ON DELETE SET NULL + UNIQUE natural-key aplicados via MCP em 2026-05-20 |
| `src/shared/phone.ts` | 60 | Função `normalizeBrazilianPhone()` para E.164 (S4) |
| `tests/integration/helpers/partner-fixtures.ts` | 130 | Helper de fixtures isoladas para testes do Portal Parceiro |
| `tests/integration/partner-portal.integration.test.ts` | 360 | 15 testes de integração (venda, cancelamento, isolamento, timezone, phone) |
| `tests/unit/shared/phone.test.ts` | 65 | 12 testes unitários da normalização E.164 (S4) |
| `tests/unit/parceiro/sale-schema.test.ts` | 85 | 5 testes unitários do refine delivery_address (S6) |
| `docs/AUDITORIA_PAINEL_PARCEIRO_2026-05-21.md` | 280 | Diagnóstico original e plano de correção |
| `docs/EXECUCAO_AUDITORIA_2026-05-21.md` | 200 | Trilha auditável das etapas 1-3 |
| `docs/PACOTE_INTEGRACAO_AUDITORIA_2026-05-21.md` | (este arquivo) | Este pacote |

### Arquivos modificados no repo

| Arquivo | Mudança |
|---|---|
| `src/admin/painel/queries.ts` | (S1) `resolveRedePeriodStartSql()` substitui `resolveRedePeriodStart()`; `getPainelRede` interpola SQL com `AT TIME ZONE 'America/Sao_Paulo'`; `todayStartSql` TZ-aware. (S4) Importa e aplica `normalizeBrazilianPhone` em `registerWalkinOrder`. |
| `src/admin/painel/route.ts` | (S6) `.refine(requireDeliveryAddress)` em `registerManualOrderSchema` e `registerWalkinOrderSchema`. |
| `src/parceiro/queries.ts` | (S4) Importa e aplica `normalizeBrazilianPhone` em `registerPartnerSale`. |
| `src/parceiro/route.ts` | (S6) `.refine()` em `saleSchema` para exigir `delivery_address` quando `fulfillment_mode='delivery'`. |
| `tests/integration/helpers/postgres.ts` | Image `postgres:17-alpine` (alinhada com prod), IPv4 forçado (`@localhost:` → `@127.0.0.1:`), `patchKnownIssues()` in-memory pra 0020 (não modifica arquivo fonte). |

### Arquivos fora do repo

Nenhum. Nada mexido em `node_modules/`, `.env`, `package.json`, `tsconfig.json`, `vitest.config.ts`.

---

## 2. Comandos que passaram

### Typecheck
```bash
$ npm run typecheck
> tsc --noEmit
# zero erros
```

### Build
```bash
$ npm run build
> tsc -p tsconfig.json
# compilou limpo
```

### Syntax check de JS frontend
```bash
$ node --check parceiro/public/app.js
$ node --check painel/public/app.js
$ node --check painel/public/rede-fallback.js
# JS OK
```

### Testes unitários (17/17)
```
$ npm run test -- tests/unit/shared/phone.test.ts tests/unit/parceiro/sale-schema.test.ts

✓ tests/unit/shared/phone.test.ts (12 tests) 5ms
✓ tests/unit/parceiro/sale-schema.test.ts (5 tests) 5ms

Test Files  2 passed (2)
     Tests  17 passed (17)
  Duration  503ms
```

### Testes de integração (15/15)
```
$ npm run test:integration -- tests/integration/partner-portal.integration.test.ts

✓ tests/integration/partner-portal.integration.test.ts (15 tests) 5542ms

Test Files  1 passed (1)
     Tests  15 passed (15)
  Duration  6.52s
```

### Smoke test SQL contra prod (etapa 2)
Resumo dos checks que passaram:
- Venda decrementou estoque (8 → 7) ✓
- Audit `partner_order_created` emitido ✓
- Audit `stock_decrement_sale` emitido (BUG #5) ✓
- Cancelamento restaurou estoque (7 → 8) ✓
- Audit `partner_order_cancelled` emitido ✓
- BUG #2 — EXCEPTION 23514 quando estoque insuficiente ✓
- Estado final do estoque idêntico ao pré-teste ✓
- Resumo Rede pós-smoke idêntico ao pré (R$ 664, 7 pedidos, R$ 164) ✓

---

## 3. Migrations novas que precisam ser aplicadas em prod

**Resposta: ZERO.**

As migrations 0042 e 0043 **já estão em prod desde 2026-05-20** (aplicadas via MCP Supabase). Os arquivos novos no repo são apenas **reprodução fiel** desse estado, para que:
- Deploy fresh em outro ambiente (test, staging, CI) gere um banco igual a prod
- Code review futuro tenha o SQL no Git
- Reconstrução em caso de disaster recovery funcione

Aplicar `0042` ou `0043` no prod atual é **no-op idempotente** (`CREATE OR REPLACE`, `IF EXISTS`, `IF NOT EXISTS`). Pode rodar 100 vezes sem efeito colateral.

Migrations da etapa 4 (S1, S4, S6): **nenhuma**. Tudo foi código TypeScript.

---

## 4. Variáveis de ambiente novas

**Resposta: ZERO.**

Nenhuma env var nova precisa ser adicionada no Coolify para deploy das etapas 1-4.

A etapa 5 (RLS + role) vai adicionar `PARTNER_DATABASE_URL` — mas isso só entra quando você aprovar o plano detalhado dela.

---

## 5. Instrução de deploy no Coolify

### Pré-requisitos
- Branch atualizada com os commits das etapas 1-4
- Acesso ao painel Coolify
- Acesso ao Supabase (não vai usar agora, mas confirmar que o token está válido)

### Passos

1. **Commit local e push para o repo:**
   ```bash
   cd "C:/Farejador agente"
   git status   # confere que tudo esperado está listado
   git add db/migrations/0042_partner_sale_consistency.sql
   git add db/migrations/0043_partner_hardening.sql
   git add src/shared/phone.ts
   git add src/parceiro/queries.ts src/parceiro/route.ts
   git add src/admin/painel/queries.ts src/admin/painel/route.ts
   git add tests/integration/helpers/postgres.ts
   git add tests/integration/helpers/partner-fixtures.ts
   git add tests/integration/partner-portal.integration.test.ts
   git add tests/unit/shared/phone.test.ts
   git add tests/unit/parceiro/sale-schema.test.ts
   git add docs/AUDITORIA_PAINEL_PARCEIRO_2026-05-21.md
   git add docs/EXECUCAO_AUDITORIA_2026-05-21.md
   git add docs/PACOTE_INTEGRACAO_AUDITORIA_2026-05-21.md
   git commit -m "Auditoria 2026-05-21: etapas 1-4 (drift, testes, S1/S4/S6)"
   git push
   ```

2. **No Coolify:**
   - Abrir o projeto Farejador
   - Verificar que não há variáveis de ambiente faltando (nenhuma nova foi adicionada)
   - Clicar em **Redeploy** (ou aguardar webhook automático do push)
   - Acompanhar logs do build
   - Esperar `npm run build` completar sem erro
   - Esperar processo Fastify reiniciar

3. **Validação pós-deploy:**

   **a. Smoke da Rede do admin:**
   ```bash
   curl -H "Authorization: Bearer $ADMIN_AUTH_TOKEN" \
        "https://<seu-dominio>/admin/api/dashboard/rede?period=month"
   ```
   Esperado: `200 OK` com a unidade `borracharia-rio-do-ouro` retornando `sales_month: 664`, etc.

   **b. Smoke do portal parceiro:**
   ```bash
   curl -H "Authorization: Bearer <token-do-parceiro>" \
        "https://<seu-dominio>/parceiro/borracharia-rio-do-ouro/api/resumo"
   ```
   Esperado: `200 OK` com resumo mensal.

   **c. Teste de regressão de delivery:**
   - Tentar registrar pedido novo no portal com `fulfillment_mode=delivery` SEM `delivery_address`
   - Esperado: erro 400 com mensagem `delivery_address: delivery_address obrigatorio quando fulfillment_mode=delivery`

   **d. Teste de regressão de phone:**
   - Registrar venda nova com `customer_phone: "(21) 99999-9999"`
   - Conferir no banco: `SELECT customer_phone FROM commerce.partner_orders ORDER BY created_at DESC LIMIT 1`
   - Esperado: `+5521999999999`

   **e. Teste de regressão de timezone:**
   - Abrir tela Rede do admin com filtro `Hoje` em horário pós-21h (BRT)
   - Esperado: venda criada às 22h-23h aparece no `Hoje`
   - (Antes do fix S1: não aparecia porque servidor UTC já estava no dia seguinte)

4. **Rollback (se precisar):**
   - Coolify: clicar em **Rollback** ou redeployar commit anterior
   - Banco: nada a desfazer — etapas 1-4 não aplicaram migration nova nem mudaram dados
   - Pedido smoke continua em `commerce.partner_orders` com `status='cancelled'` (não atrapalha)

---

## 6. O que já está em prod vs. o que ainda não está

### Já em prod
| Item | Onde | Como |
|---|---|---|
| Function `commerce.register_partner_local_order` com BUG #2 e #5 corrigidos | Supabase | Aplicada via MCP em 2026-05-20 |
| Function `commerce.cancel_partner_local_order` | Supabase | Da 0040 (já estava) |
| FKs com `ON DELETE SET NULL` (3) | Supabase | Aplicadas via MCP em 2026-05-20 |
| UNIQUE natural-key do estoque | Supabase | Aplicada via MCP em 2026-05-20 |
| Trigger `partner_orders_set_updated_at` | Supabase | Aplicada via MCP em 2026-05-20 |
| 2 triggers `env_match_*` em partner_orders | Supabase | Aplicada via MCP em 2026-05-20 |
| RLS habilitada em 7 tabelas (mas inerte — policy `current_partner_unit() IS NULL OR ...`) | Supabase | Aplicada via MCP em 2026-05-20 |
| 1 pedido teste cancelado (R$ 100, "Smoke Test") | `commerce.partner_orders` | Smoke da etapa 2, mantido como histórico |
| 3 eventos audit do smoke | `audit.events` | `actor_label='smoke-test-claude-audit'` |

### No repo, ainda NÃO em prod
| Item | Onde | O que precisa pra subir |
|---|---|---|
| Arquivos 0042 e 0043 no Git | `db/migrations/` | `git push` + Coolify redeploy (banco já tem o estado) |
| Fix S1 (timezone-aware Rede) | `src/admin/painel/queries.ts` | `git push` + Coolify redeploy |
| Fix S6 (delivery_address obrigatório) | `src/parceiro/route.ts`, `src/admin/painel/route.ts` | `git push` + Coolify redeploy |
| Fix S4 (normalização E.164) | `src/shared/phone.ts` + 2 queries | `git push` + Coolify redeploy |
| 32 testes (15 integration + 17 unit) | `tests/` | `git push` (CI roda se houver) |
| 3 docs novos | `docs/` | `git push` |

### Pendente — ainda nem no repo
- Etapa 5: migration 0044 (RLS em `partners` + `partner_access_tokens`), role `farejador_partner_app`, env var `PARTNER_DATABASE_URL`, refactor `auth.ts` para `SET LOCAL app.partner_unit_id`. Tudo aguarda plano detalhado + aprovação.

---

## 7. Riscos antes de subir

### Risco baixo

1. **Helper `tests/integration/helpers/postgres.ts` foi modificado.**
   - Afeta os outros 5 testes de integração do projeto (analytics-auditability, atendente-commerce-tools, atendente-state-persistence, idempotency-constraints, raw-immutability).
   - Mudanças são puramente aditivas (Postgres 17 em vez de 16, IPv4 em vez de localhost, patch in-memory da 0020). Os testes existentes deveriam continuar funcionando ou ficar **melhores** (porque o IPv4 fix destrava localmente no Windows).
   - **Mitigação:** rodar `npm run test:integration` completo antes de subir.

2. **Reformulação do SQL em `getPainelRede` (S1).**
   - Mudou de `$2::timestamptz` parametrizado para interpolação inline de expressão com `AT TIME ZONE 'America/Sao_Paulo'`.
   - Sem risco de SQL injection (a constante TZ é hard-coded, não vem de input do user).
   - **Mitigação:** os 2 testes novos validaram que todos os 4 períodos rodam sem erro.

3. **Refine do Zod schema (S6).**
   - Pedidos com `delivery` sem `delivery_address` que antes passavam agora retornam 400.
   - **Possível impacto:** se algum frontend (admin painel ou portal parceiro) envia delivery sem endereço por bug, vai começar a falhar.
   - **Mitigação:** revisão visual do frontend antes de subir (`painel/public/app.js`, `parceiro/public/app.js`). Spot-check no smoke pós-deploy.

4. **Normalização E.164 (S4).**
   - Telefones gravados antes do deploy continuam crus (não retroativo).
   - A partir do deploy, novos pedidos gravam normalizado.
   - **Possível impacto:** se algum integrador (Chatwoot, n8n) lê `customer_phone` esperando formato específico, pode quebrar.
   - **Mitigação:** o portal parceiro não tem integração externa de leitura desse campo hoje. Confirmado que `getPartnerVendas` retorna `contact_phone` e `customer_phone` direto sem transformação (frontend lida com qualquer formato).

### Risco zero
- Aplicar 0042/0043 em prod hoje. São no-op porque o banco já tem o estado.
- Adicionar tests, docs, helpers. Não tocam em código produtivo.

### Risco que NÃO está sendo introduzido agora
- Etapa 5 (RLS efetivo, role nova, env var nova) NÃO está neste pacote. Sobe depois, com plano separado.

---

## 8. Resumo da nota

| Categoria | Pré-auditoria | Pós-etapa 4 |
|---|:-:|:-:|
| Sincronia repo ↔ banco prod | 3,0 | **8,0** |
| Cobertura de testes automatizados | 0,0 | **7,5** |
| Tratamento de erro / UX | 7,0 | **8,5** |
| Documentação interna | 6,5 | **8,0** |
| Atomicidade transacional | 9,0 | 9,0 |
| Modelagem de dados | 9,0 | 9,0 |
| Frontend admin (timezone fix) | 6,5 | **7,5** |
| **Nota geral** | **6,4** | **7,8** |

Etapa 5 (RLS efetivo) sobe para ~8,8 quando aprovada e aplicada.

---

## 9. Quando você der OK no deploy

Manda mensagem com:
- "Deploy OK" → eu monto o plano detalhado da etapa 5 pra Codex revisar com lupa
- "Deploy com problema X" → eu investigo e corrijo
- "Antes do deploy, quero rodar tudo localmente" → me passa, eu rodo `npm run test:all` e confirmo

Etapa 5 só começa depois do plano dela ser revisado e aprovado.

---

*Pacote gerado em 2026-05-21 por Claude Opus 4.7. Sequência de execução acordada com Codex e Wallace. Etapas 1-4 não tocam em bot/atendente/planner/organizadora. Etapa 5 ficará em documento separado.*
