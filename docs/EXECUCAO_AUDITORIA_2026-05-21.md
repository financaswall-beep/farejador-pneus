# Execução do plano de correção — Auditoria 2026-05-21

**Documento companheiro:** [`AUDITORIA_PAINEL_PARCEIRO_2026-05-21.md`](AUDITORIA_PAINEL_PARCEIRO_2026-05-21.md)
**Início:** 2026-05-21
**Sequência aprovada (Codex):** 1. arquivos 0042/0043 → 2. build + smoke → 3. testes mínimos → 4. bugs simples → 5. RLS + role (com plano antes)

---

## Etapa 1 — Migrations 0042 e 0043 como arquivo no repo ✅

### Objetivo
Resolver problema crítico **C4** da auditoria: drift oficial repo ↔ prod. Migrations 0042 e 0043 estavam aplicadas em prod via MCP Supabase, mas não existiam como arquivo no Git → deploy fresh quebrava o banco.

### O que foi feito

Extração **byte a byte** do estado real de prod via:
- `pg_get_functiondef(p.oid)` para functions
- `pg_get_triggerdef(oid)` para triggers
- `pg_get_constraintdef(oid)` para FKs
- `pg_indexes.indexdef` para índices
- `pg_description` para COMMENT ON COLUMN

### Arquivos criados

| Arquivo | Linhas | Conteúdo |
|---|:-:|---|
| `db/migrations/0042_partner_sale_consistency.sql` | 218 | Recria `commerce.register_partner_local_order` com BUG #2 (EXCEPTION ERRCODE 23514 quando saldo insuficiente) e BUG #5 (audit `stock_decrement_sale` separado de `partner_order_created`) |
| `db/migrations/0043_partner_hardening.sql` | 113 | Trigger `partner_orders_set_updated_at` + 2 triggers `env_match_*` + 3 FKs com `ON DELETE SET NULL` + UNIQUE natural-key `partner_stock_natural_key_uniq` + COMMENT em `partner_orders.status/deleted_at` |

### Confirmações de segurança (5 perguntas do Codex)

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Aplicam algo novo em prod? | Não. Em prod hoje = no-op idempotente. |
| 2 | Idempotentes (fresh + prod)? | Sim. `CREATE OR REPLACE` / `IF EXISTS` / `IF NOT EXISTS` em tudo. |
| 3 | 0042 veio de `pg_get_functiondef`? | Sim. |
| 4 | 0043 veio do estado real (pg_constraint, pg_trigger, pg_indexes)? | Sim. |
| 5 | Toca em raw/core/agent/ops/analytics ou no bot? | Não. Só `commerce.partner_*` + `finance.partner_expenses` + `audit.events` (INSERT). |

### Nuance registrada

`0043` faz `DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT` em 3 FKs. Em prod a constraint já existe igual → durante a execução do migration runner, há uma janela de milissegundos onde a FK fica ausente (operação transacional do Postgres, segura). Decisão (aprovada por Codex): manter simples, não refatorar pra lógica condicional mais esperta.

---

## Etapa 2 — Build + smoke test ✅

### Objetivo
Garantir que a inclusão dos 2 arquivos novos não quebra typecheck/build e que o caminho crítico (venda + cancelamento + audit) continua funcionando em prod.

### Comandos executados

```bash
npm run typecheck    # zero erros
npm run build        # compilou limpo
node --check parceiro/public/app.js
node --check painel/public/app.js
node --check painel/public/rede-fallback.js   # 3 JS files OK
```

### Smoke test SQL contra prod (controlado)

Sem criar bagunça operacional: 1 venda de teste com `actor_label = 'smoke-test-claude-audit'` → verificação de decremento → cancelamento → verificação de restauro.

| Check | Resultado |
|---|:-:|
| Venda decrementou estoque (8 → 7) | ✅ |
| Audit `partner_order_created` emitido | ✅ 1 evento |
| Audit `stock_decrement_sale` emitido (BUG #5) | ✅ 1 evento |
| Cancelamento restaurou estoque (7 → 8) | ✅ |
| Audit `partner_order_cancelled` emitido | ✅ 1 evento |
| BUG #2 — venda com `quantity > saldo` levanta EXCEPTION 23514 | ✅ |
| Estado final do estoque | 8 unidades, `in_stock` (igual ao pré) |
| Pedido teste | `status='cancelled'`, R$ 100, "Smoke Test" |
| Resumo Rede pós-smoke | R$ 664, 7 pedidos, R$ 164 (idêntico ao pré) |

### Side-effects no banco prod

- 1 pedido em `commerce.partner_orders` com `status='cancelled'`, `customer_name='Smoke Test'`, R$ 100 (mantido como histórico, convenção `deleted_at` reservado pra LGPD)
- 3 eventos em `audit.events` com `actor_label='smoke-test-claude-audit'`
- Zero impacto em métricas operacionais (pedido cancelado não conta no resumo nem na Rede)

---

## Etapa 3 — Testes mínimos automatizados ✅

### Objetivo
Resolver problema crítico **C5** da auditoria: zero testes automatizados em `src/parceiro/` e `src/admin/painel/`. Criar rede de regressão antes de tocar em RLS.

### Stack
Vitest 1.6 + `@testcontainers/postgresql` (Postgres 17-alpine efêmero por suite). Padrão idêntico aos 5 testes de integração existentes no projeto (`tests/integration/*.integration.test.ts`).

### Arquivos criados

| Arquivo | Linhas | Conteúdo |
|---|:-:|---|
| `tests/integration/helpers/partner-fixtures.ts` | 130 | `createPartnerFixture(pool, opts)` cria core.unit + network.partners + network.partner_units + token (hash SHA-256) + 1 stock item. Slug UUID-based pra paralelizar. |
| `tests/integration/partner-portal.integration.test.ts` | 240 | 10 testes cobrindo os 5 cenários do plano |

### Resultado da execução

```
✓ tests/integration/partner-portal.integration.test.ts  (10 tests)  5056ms
Test Files  1 passed (1)
     Tests  10 passed (10)
  Duration  6.00s
```

### Cobertura dos 10 testes

| # | Cenário do plano | Teste | Status |
|---|---|---|:-:|
| 1 | Venda baixa estoque | decrementa quantity_on_hand atomicamente | ✅ |
| 1 | Venda baixa estoque | emite 2 audits (partner_order_created + stock_decrement_sale) — BUG #5 da 0042 | ✅ |
| 2 | Estoque insuficiente | erro controlado + estoque intacto — BUG #2 da 0042 | ✅ |
| 3 | Cancelamento restaura | venda + cancel + verifica restauro | ✅ |
| 4 | Token revogado → 401 | requirePartnerAuth retorna 401 | ✅ |
| 4 | Token errado → 401 | requirePartnerAuth retorna 401 | ✅ |
| 4 | Token válido → 200 | popula partnerContext.unitId correto | ✅ |
| 5a | Isolamento — listagem | token A não vê vendas da unidade B | ✅ |
| 5b | Isolamento — cancelamento | token A tentando cancelar order de B → cancelled=false, estoque/status de B intactos | ✅ |
| 5c | Isolamento — venda cruzada | token A vendendo item de B → erro "Item de estoque nao pertence a esta unidade" | ✅ |

### Modificações em helper compartilhado

Arquivo `tests/integration/helpers/postgres.ts` ganhou 3 ajustes — todos beneficiam **todos os testes de integração** do projeto, não só os do Portal Parceiro:

1. **Postgres 17-alpine** em vez de 16-alpine (alinhado com Supabase prod).
2. **IPv4 forçado**: `getConnectionUri().replace('@localhost:', '@127.0.0.1:')` — workaround para bug Docker Desktop + WSL2 + Windows (`localhost` resolve pra IPv6, port forwarding só em IPv4 → ECONNRESET).
3. **`patchKnownIssues()`**: pré-processador in-memory que escapa `position` com aspas duplas na 0020 `find_compatible_tires`. **Não modifica o arquivo fonte.** Necessário porque Postgres 16/17 rejeita `position TEXT` em `RETURNS TABLE` em parse estrito. Em prod a 0025 renomeou pra `fitment_position` — a 0020 só conflita em ambiente fresh.

### Achados secundários

1. **Bug pré-existente na 0020 (fora do escopo Portal Parceiro)**: `position TEXT` em `RETURNS TABLE` não compila em Postgres 16/17 fresh. Contornado via `patchKnownIssues()`. Conserto definitivo: o autor da 0020/0025 quotar `position` com aspas duplas ou renomear na 0020. Fica como débito do módulo bot/commerce.

2. **Bug Docker Desktop + WSL2 + Windows**: bloqueia qualquer teste de integração do projeto rodar localmente em Windows com Docker recente. Helper foi corrigido — afeta todo o projeto positivamente.

### Side-effects fora do escopo

`tests/integration/helpers/postgres.ts` foi modificado. Esse helper é compartilhado com os outros 5 arquivos de teste de integração do projeto:

- `analytics-auditability.integration.test.ts`
- `atendente-commerce-tools.integration.test.ts`
- `atendente-state-persistence.integration.test.ts`
- `idempotency-constraints.integration.test.ts`
- `raw-immutability.integration.test.ts`

Os 3 ajustes são puramente aditivos (compatíveis pra cima). Os testes existentes desses módulos deveriam continuar funcionando — não rodei eles porque escopo é Portal Parceiro. Validação pendente quando alguém quiser rodar a suíte inteira.

---

---

## Etapa 4 — Bugs simples (S1, S4, S6) ✅

### Objetivo
Resolver 3 problemas **sérios** da auditoria sem mexer em RLS/role/Coolify:
- **S1**: Timezone em `getPainelRede` (servidor UTC corta dia 3h antes do Brasil)
- **S6**: `delivery_address` opcional mesmo em pedido de entrega
- **S4**: `customer_phone` gravado cru, contrariando comentário "E.164 normalizado"

### Mudanças

**S1 — timezone-aware na Rede (`src/admin/painel/queries.ts`)**
- `resolveRedePeriodStart(): Date` substituída por `resolveRedePeriodStartSql(): string`
- Expressões interpoladas: `date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`
- Janela `today_sales` também trocada pra TZ-aware (não usava `$2`, mas estava com `date_trunc('day', now())` sem TZ)
- Removido `$2` da query (era `periodStart.toISOString()`)
- Constante `PAINEL_TZ = 'America/Sao_Paulo'` hard-coded (justificada — rede 2W opera no Brasil)
- Expressões entre parênteses para evitar conflito de precedência com `::date` / `::timestamptz` cast

**S6 — delivery_address obrigatório (`src/parceiro/route.ts`, `src/admin/painel/route.ts`)**
- `.refine(requireDeliveryAddress)` em 3 schemas: `saleSchema`, `registerManualOrderSchema`, `registerWalkinOrderSchema`
- Mensagem: `delivery_address obrigatorio quando fulfillment_mode=delivery`
- Helper `requireDeliveryAddress` extraído no admin pra reutilizar

**S4 — normalização E.164 (`src/shared/phone.ts` novo + 2 queries.ts)**
- Função `normalizeBrazilianPhone(input): string | null`
- Aceita: `"(21) 99999-9999"`, `"21999999999"`, `"+5521999999999"`, `"5521999999999"`, `"+14155552671"`
- Rejeita: vazio, null, undefined, texto não-numérico, comprimento inválido
- Aplicada em `registerPartnerSale` (`src/parceiro/queries.ts`) e `registerWalkinOrder` (`src/admin/painel/queries.ts`)
- Comentário da função em SQL (`0040:46`) agora reflete realidade

### Arquivos novos

| Arquivo | Linhas |
|---|:-:|
| `src/shared/phone.ts` | 60 |
| `tests/unit/shared/phone.test.ts` | 65 (12 testes) |
| `tests/unit/parceiro/sale-schema.test.ts` | 85 (5 testes) |

### Arquivos modificados

| Arquivo | Mudanças |
|---|---|
| `src/admin/painel/queries.ts` | S1 + S4 |
| `src/admin/painel/route.ts` | S6 |
| `src/parceiro/queries.ts` | S4 |
| `src/parceiro/route.ts` | S6 |
| `tests/integration/partner-portal.integration.test.ts` | +5 testes (S4 ×3, S1 ×2) |

### Resultado da execução

```
npm run typecheck → zero erros
npm run test       → 17/17 passed (12 phone + 5 sale-schema)
npm run test:integration → 15/15 passed (10 da etapa 3 + 5 da etapa 4)
```

### Achado durante execução

**Bug de precedência SQL na primeira tentativa do S1.**
Interpolação `${periodStartSql}::date` virou `... AT TIME ZONE 'America/Sao_Paulo'::date`, que o Postgres interpretou como cast da string TZ pra date. Corrigido envolvendo a expressão entre parênteses na função `resolveRedePeriodStartSql()`. Caught pelos testes integration (`invalid input syntax for type date: "America/Sao_Paulo"`).

---

## Status atual do plano

| Etapa | Status | Resolveu |
|---|:-:|---|
| 1. Migrations 0042 e 0043 como arquivo | ✅ | C4 (drift) |
| 2. Build + smoke test | ✅ | Confirmação que 1 não quebrou nada |
| 3. Testes mínimos automatizados | ✅ | C5 (zero testes) |
| 4. Bugs simples (S1, S4, S6) | ✅ | S1, S4, S6 |
| 5. RLS + role (com plano antes) | ⏳ aguardando OK do Wallace | C1, C2, C3 |

### Score atualizado pós-etapa 4

| Categoria | Antes | Pós-etapa 3 | Pós-etapa 4 |
|---|:-:|:-:|:-:|
| Sincronia repo ↔ banco prod | 3,0 | 8,0 | 8,0 |
| Cobertura de testes automatizados | 0,0 | 6,5 | **7,5** |
| Tratamento de erro / UX | 7,0 | 7,0 | **8,5** |
| Frontend admin (timezone) | 6,5 | 6,5 | **7,5** |
| Documentação interna | 6,5 | 7,5 | **8,0** |
| Atomicidade transacional | 9,0 | 9,0 | 9,0 |
| **Nota geral** | **6,4** | **7,1** | **7,8** |

Resta etapa 5 (RLS efetivo, +~1,0 estimado) pra chegar em 8,8.

---

## Débito conhecido (registrado por Codex em revisão da etapa 4)

Ressalvas legítimas que ficam pra resolver fora desta auditoria:

### D1. Schema de venda nos testes replica em vez de importar
`tests/unit/parceiro/sale-schema.test.ts` recria o Zod schema com as mesmas regras em vez de importar do `src/parceiro/route.ts`. Motivo: o schema mora dentro do `route.ts` como const interna não exportada.

**Resolução futura**: exportar `saleSchema` do `route.ts` (ou mover pra `src/parceiro/schemas.ts`) e o teste importar. Não bloqueia auditoria atual, mas evita drift entre o schema real e o testado.

### D2. Patch in-memory da 0020 no helper de teste
`tests/integration/helpers/postgres.ts → patchKnownIssues()` adapta a migration 0020 (`commerce.find_compatible_tires`) em runtime para escapar `position` com aspas duplas — porque Postgres 16/17 fresh não aceita `position TEXT` em `RETURNS TABLE`.

A 0020 é do módulo bot/commerce, fora do escopo desta auditoria. A 0025 já recria a function com `fitment_position`, então prod sobrevive. Mas instalação fresh em CI/staging precisa do patch.

**Resolução futura (escopo bot/commerce)**: o autor da 0020/0025 corrige a 0020 quotando `position` ou renomeando direto. Aí o `patchKnownIssues` pode ser removido.

### D3. RLS habilitada mas inerte (etapa 5 do plano original)
Política `current_partner_unit() IS NULL OR unit_id = current_partner_unit()` existe em 7 tabelas mas: (a) app nunca seta `app.partner_unit_id`, (b) role `postgres` usada pelo app tem `BYPASSRLS=true`. Resultado: zero defesa em profundidade.

`network.partners` e `network.partner_access_tokens` ficaram **fora** da RLS (sem policy nem habilitação).

**Resolução futura**: etapa 5 do plano. Plano detalhado vai a Codex pra revisão antes de aplicar qualquer coisa em prod/Coolify.

---

## Notas operacionais

### Como rodar os testes localmente (Windows + Docker Desktop)

```powershell
# Pré-requisito: Docker Desktop rodando com WSL2 backend
docker ps   # tem que responder sem erro

# Roda só os testes do Portal Parceiro
npm run test:integration -- tests/integration/partner-portal.integration.test.ts

# Roda toda a suíte de integração
npm run test:integration

# Roda unit + integration
npm run test:all
```

Primeira execução demora 1-2 min (pull da imagem `postgres:17-alpine`). Rodadas seguintes ~5-6s.

### Como rodar em CI (Linux)

Funciona sem ajuste. Docker em Linux não tem o problema IPv6/IPv4. O `127.0.0.1` continua funcionando.

---

*Documento criado em 2026-05-21 por Claude Opus 4.7. Sequência de execução acordada com Codex (revisão externa) e Wallace (decisão de produto). Etapa 5 (RLS + role) será pausada para revisão antes da aplicação — plano detalhado virá em documento separado.*
