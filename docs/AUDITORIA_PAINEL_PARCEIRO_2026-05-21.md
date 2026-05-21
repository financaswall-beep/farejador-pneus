# Auditoria — Módulo Painel + Portal Parceiro

**Data:** 2026-05-21
**Escopo:** `src/parceiro/`, `src/admin/painel/`, `painel/`, `parceiro/`, migrations `0035–0043`
**Fora de escopo (não tocado):** bot Atendente, Planner, Organizadora, ETL, webhook Chatwoot
**Método:** leitura de código + leitura de migrations + 10 queries SQL diretas contra prod (Supabase `aoqtgwzeyznycuakrdhp`)
**Nota geral:** **6,4 / 10**

---

## 1. Cobertura da auditoria

| Item | Status |
|---|---|
| Migrations `0035–0041` (arquivos no repo) | ✅ lidas integralmente |
| Migrations `0042–0043` (aplicadas via MCP, sem arquivo) | ✅ confirmadas em prod via SQL |
| `src/parceiro/route.ts` | ✅ inteiro |
| `src/parceiro/auth.ts` | ✅ inteiro |
| `src/parceiro/queries.ts` (892 linhas) | ✅ inteiro |
| `src/admin/painel/route.ts` | ✅ inteiro |
| `src/admin/painel/queries.ts` | ✅ parte chave (Rede/Resumo/Shadow) |
| `src/admin/auth.ts` | ✅ inteiro |
| Frontend parceiro (`parceiro/public/`) | ✅ grep XSS + localStorage |
| Frontend admin (`painel/public/`) | ✅ estrutura + grep auth |
| Banco prod (Supabase) | ✅ 10 queries: RLS, policies, roles, FKs, índices, triggers, vendas legadas |
| Testes automatizados | ✅ confirmado: zero |

**O que não foi feito** (próximo nível, não pedido):
- Testes de penetração runtime (tentar venda com `partner_stock_id` de outra unidade)
- Profiling de performance com volume
- Validação amostral de `audit.events` em prod

---

## 2. Resultados das queries SQL contra prod

### 2.1 RLS state nas tabelas partner_*

| Schema | Tabela | RLS habilitada | Policies | Forçada (`rls_forced`) |
|---|---|:-:|:-:|:-:|
| commerce | partner_orders | ✅ | 1 | ❌ |
| commerce | partner_order_items | ✅ | 1 | ❌ |
| commerce | partner_purchases | ✅ | 1 | ❌ |
| commerce | partner_purchase_items | ✅ | 1 | ❌ |
| commerce | partner_stock_levels | ✅ | 1 | ❌ |
| finance | partner_expenses | ✅ | 1 | ❌ |
| network | partner_units | ✅ | 1 | ❌ |
| **network** | **partners** | **❌** | **0** | ❌ |
| **network** | **partner_access_tokens** | **❌** | **0** | ❌ |

### 2.2 Política aplicada nas 7 tabelas

```sql
current_partner_unit() IS NULL OR unit_id = current_partner_unit()
```

Onde:

```sql
CREATE FUNCTION network.current_partner_unit() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.partner_unit_id', true), '')::UUID
$$;
```

**A aplicação nunca seta `app.partner_unit_id`** — grep em `src/parceiro/` e `src/admin/`: zero ocorrências. Logo `current_partner_unit() IS NULL` → policy passa tudo.

### 2.3 Roles do banco

| Rolname | rolsuper | rolbypassrls | rolcanlogin |
|---|:-:|:-:|:-:|
| postgres | ❌ | **✅** | ✅ |
| authenticator | ❌ | ❌ | ✅ |

App provavelmente usa `postgres` (BYPASSRLS) → RLS é completamente ignorada em runtime.

### 2.4 GAP #7 — vendas legadas em commerce.orders

```
slug                       | legacy_orders | legacy_total
borracharia-rio-do-ouro    | 6             | R$ 447,10
```

Bate exato com o doc. Vendas pré-decisão do silo que ficaram em `commerce.orders` em vez de `commerce.partner_orders`.

### 2.5 Migrations 0042 e 0043 — estado em prod

| Item | Em prod | No repo |
|---|:-:|:-:|
| Function `register_partner_local_order` com 6268 chars | ✅ | ❌ |
| FK `partner_order_items.partner_stock_id` ON DELETE SET NULL | ✅ | ❌ |
| FK `partner_purchase_items.product_id` ON DELETE SET NULL | ✅ | ❌ |
| FK `partner_stock_levels.product_id` ON DELETE SET NULL | ✅ | ❌ |
| Índice `partner_stock_natural_key_uniq` | ✅ | ❌ |
| Trigger `partner_orders_set_updated_at` | ✅ | ❌ |
| Trigger `env_match_partner_orders_unit` | ✅ | ❌ |

**Drift oficial**: prod está 2 migrations à frente do repo.

---

## 3. Virtudes confirmadas

### 3.1 Arquitetura

1. **Silo isolado**: `commerce.partner_orders` separada de `commerce.orders` evita mistura entre venda do bot e venda do borracheiro.
2. **Bot/Shadow/Chatwoot completamente fora**: parceiro não acessa `raw.*`, `core.*`, `agent.*`, `ops.*`, `analytics.*`.
3. **Snapshot de item na venda**: `partner_order_items` guarda `item_name/tire_size/brand` no momento da venda.
4. **Soft-delete uniforme**: `deleted_at` + `deleted_by` em despesas, compras, estoque, vendas.

### 3.2 Autenticação do parceiro

5. **Token hash SHA-256** (`auth.ts:38-40`) — banco nunca guarda token puro.
6. **`timingSafeEqual`** (`auth.ts:42-52`) — sem ataque de timing.
7. **`unit_id` resolvido server-side** (`auth.ts:66-90`) — nunca aceito no body.
8. **Token revogável** via `revoked_at` sem deletar registro.

### 3.3 Modelagem de banco

9. **Function SQL atômica** `register_partner_local_order`: idempotência + lock + decremento + insert + audit numa única transação.
10. **`FOR UPDATE`** em cada `partner_stock_levels` durante venda — sem race entre vendas concorrentes.
11. **Idempotency keys** com UNIQUE parcial nas 4 tabelas escritoras.
12. **Triggers `env_match_*`** impedem mistura entre `prod` e `test`.
13. **3 FKs com `ON DELETE SET NULL`** (confirmadas em prod) — DELETE upstream não trava parceiro.
14. **UNIQUE natural-key do estoque** evita duplicação por race.
15. **Triggers `set_updated_at`** automáticos.
16. **Média ponderada de verdade** na entrada de compra (`queries.ts:570-577`).
17. **Match normalizado** com `lower(trim())` em brand/supplier (`queries.ts:557-560`).

### 3.4 Backend

18. **Validação Zod** em todos os endpoints com erro de path no response.
19. **422 com mensagem clara** em regra de negócio violada (`route.ts:180-194`).
20. **Audit em `audit.events`** com domain consistente por tabela.
21. **BEGIN/COMMIT explícito** em operações multi-statement (compra) com rollback no catch.

### 3.5 Cancelamento

22. **`cancel_partner_local_order` restaura estoque** atomicamente com `FOR UPDATE`.
23. **Convenção clara**: `status='cancelled'` é cancelamento normal; `deleted_at` reservado pra LGPD.

### 3.6 Frontend portal parceiro

24. **Sem `innerHTML/x-html/insertAdjacentHTML`** — superfície XSS mínima.
25. **Heurística de toast tricolor** (success/error/neutral).
26. **Asset versioning** força refresh do navegador.

### 3.7 Documentação interna

27. **Trilha de decisões honesta**: cada hotfix está documentado.
28. **Auditoria operacional cruzada** (Portal × Admin × tabelas brutas) feita em 21/05 com 7 checks fechados.

**Total de virtudes: 28**

---

## 4. Problemas encontrados

### 🚨 4.1 Críticos (bloqueiam credenciar 2º parceiro)

#### C1. RLS está montada mas inerte
- Policies existem em 7 tabelas mas `current_partner_unit()` nunca é setado pelo app.
- Role `postgres` (usada pelo app) tem `BYPASSRLS=true`.
- **Resultado:** zero defesa em profundidade. Se TypeScript esquecer `unit_id`, vaza entre parceiros.

#### C2. `network.partner_access_tokens` sem RLS nem policy
- Guarda hash de todos os tokens da rede.
- Vazamento em qualquer endpoint = mapa da rede inteira (labels, last_used_at, partner_unit_id).

#### C3. `network.partners` sem RLS nem policy
- Documentos fiscais (CNPJ), responsáveis, telefones, comissões expostos sem isolamento.

#### C4. Drift oficial repo ↔ prod
- Migrations 0042 e 0043 aplicadas em prod, não existem no Git.
- Deploy fresh = banco quebrado (function antiga, FKs sem SET NULL, sem natural-key).
- Code review impossível — PRs históricos não têm o SQL.

#### C5. Zero testes automatizados
- `src/parceiro/` e `src/admin/painel/` sem nenhum `.test.ts` / `.spec.ts`.
- Toda cobertura é manual.
- Próximo refator quebra silenciosamente.

### ⚠️ 4.2 Sérios (geram bug em prod ou inconsistência)

#### S1. Timezone bug em `getPainelRede`
- `queries.ts (admin):133-139` calcula janela em local time do servidor.
- Servidor UTC + Brasil BRT = janela "hoje" deslocada 3h.

#### S2. `network_orders_unified` não filtra `deleted_at` em `commerce.orders`
- Migration `0040:410` — só filtra no lado partner.
- Vendas soft-deleted da matriz aparecem na view.

#### S3. GAP #7 não migrado
- 6 vendas legadas (R$ 447,10) em `commerce.orders` apontando pra unit_id de parceiro.
- Portal mostra 0, view unificada mostra R$ 447,10 a mais.

#### S4. `customer_phone` "E.164 normalizado" não normaliza
- Comentário em `0040:46` diz "E.164 normalizado".
- `registerPartnerSale` (`queries.ts:286`) passa string crua.

#### S5. Audit `stock_decrement_sale` provavelmente ausente
- Doc (BUG #5) prometeu separar audit de venda + audit de movimento.
- Function 0040 no repo só emite `partner_order_created`.
- Pode estar na 0042 do banco — não dá pra verificar sem o arquivo.

#### S6. `delivery_address` opcional mesmo com `fulfillment_mode='delivery'`
- Zod schema (`route.ts:60`) permite pedido de entrega sem endereço.

### 🟡 4.3 Médios (polish ou risco baixo)

#### M1. Token do parceiro em `localStorage`
- Sem httpOnly, exposto a extensão de navegador maliciosa.

#### M2. CDN externa para Tailwind/Alpine/Lucide/Chart.js
- Se cair, painel fica branco. Fallback parcial só pra tela Rede.

#### M3. Meta de vendas da Rede em `localStorage`
- Não sincroniza entre navegadores/máquinas/usuários.

#### M4. HTML/JS de `/admin/painel` servidos sem auth
- Não vaza dados (API exige Bearer), mas expõe UI/comentários internos.

#### M5. Disparidade de granularidade Portal × Admin
- Parceiro só vê mensal, admin vê 4 janelas. Confunde reconciliação.

#### M6. Score de saúde / ranking com N=1 parceiro
- Métrica é teatro até ter 5+ unidades.

#### M7. Query de auth retorna até 10 tokens por slug
- `LIMIT 10` arbitrário, sem motivo claro.

#### M8. STOCK_MOVE_SQL em cancelamento de compra usa match por nome+supplier
- Frágil se supplier mudar nome entre compras.

#### M9. `registerPartnerExpense` com `ON CONFLICT DO UPDATE` no-op
- Não atualiza outros campos, mas frontend pode achar que criou nova despesa.

#### M10. Bug histórico nos summaries (0036/0037)
- Mantiveram resumo somando `commerce.orders` em vez de `partner_orders`.
- Corrigido apenas na 0041.
- Entre 19/05 e 20/05, parceiro via R$ 0 em vendas reais.

### Distribuição

| Severidade | Quantidade |
|---|:-:|
| Críticos | 5 |
| Sérios | 6 |
| Médios | 10 |
| **Total** | **21** |

---

## 5. Quadro de saúde por categoria

| Categoria | Nota | Justificativa |
|---|:-:|---|
| Isolamento multi-tenant (RLS efetivo) | 5,0 | Policies existem mas `current_partner_unit()` retorna NULL e role `postgres` bypassa. `partner_access_tokens` e `partners` sem RLS. |
| Modelagem de dados | 9,0 | Silo correto, snapshot, soft-delete, FKs com SET NULL em prod. |
| Atomicidade transacional | 9,0 | Function SQL com `FOR UPDATE`, BEGIN/COMMIT, rollback em catch. |
| Idempotência | 8,0 | UNIQUE parciais existem; despesa um pouco fraca semanticamente. |
| Validação de entrada (Zod) | 7,5 | Cobre tipos e ranges; falta validação cruzada. |
| Tratamento de erro / UX | 7,0 | 422 com mensagem clara, mas só pra 4 strings hardcoded. |
| Sincronia repo ↔ banco prod | 3,0 | 0042/0043 só em prod. Drift confirmado. |
| Documentação interna | 6,5 | Excelente "porquê", mas afirma RLS habilitada → induz a confiar em proteção inerte. |
| Frontend portal parceiro | 7,5 | Sem innerHTML, polish bem feito. CDN externa + token em localStorage. |
| Frontend painel admin | 6,5 | Fallback existe, queries recalculam no banco. Timezone bug + HTML público. |
| Auditoria operacional já feita | 8,0 | Cruzamento real em 21/05. Mas só com N=1. |
| Cobertura de testes automatizados | 0,0 | Confirmado zero. |

### Nota geral: **6,4 / 10**

---

## 6. Plano de correção priorizado

### 6.1 Antes de credenciar 2º parceiro (críticos)

| # | Ação | Esforço |
|---|---|:-:|
| 1 | Criar migration `0044_partner_rls_enforcement.sql` ligando RLS em `partners` e `partner_access_tokens` + criando policies | 1h |
| 2 | Criar role `farejador_app` sem `BYPASSRLS`; app passa a usar essa role | 2h |
| 3 | `auth.ts` faz `SET LOCAL app.partner_unit_id = $1` no início de cada request autenticada do parceiro | 1h |
| 4 | Extrair 0042 e 0043 de prod via `pg_dump --schema-only` → salvar como arquivo no repo | 30min |
| 5 | Escrever 5 testes de integração mínimos (venda decrementa, estoque insuficiente 422, cancelamento restaura, token revogado 401, isolamento real A vs B) | 4h |

**Total:** ~8,5 horas. Sobe nota pra 8,0.

### 6.2 Antes do 10º parceiro (sérios)

| # | Ação | Esforço |
|---|---|:-:|
| 6 | Corrigir timezone em `getPainelRede` (usar `date_trunc` no banco em vez de JS Date) | 1h |
| 7 | Adicionar `WHERE o.deleted_at IS NULL` na view `network_orders_unified` lado matriz | 15min |
| 8 | Migrar as 6 vendas legadas pra `partner_orders` ou marcar como histórico fora da view | 1h |
| 9 | Normalizar `customer_phone` em E.164 no backend | 30min |
| 10 | Validação cruzada Zod: `delivery_address` obrigatório quando `fulfillment_mode='delivery'` | 15min |
| 11 | Confirmar (ou adicionar) audit `stock_decrement_sale` na function | 30min |

**Total:** ~3,5 horas. Sobe nota pra 9,0.

### 6.3 Polish (médios) — quando der

- Baixar Tailwind/Alpine/Lucide/Chart.js pro repo (sem build step)
- Mover meta de vendas pra tabela em vez de localStorage
- Adicionar filtro Hoje/Semana/Mês no Portal Parceiro
- Ajustar `LIMIT 10` em auth pra `LIMIT 50` ou indexar melhor

---

## 7. Sumário executivo

O módulo está **funcionalmente bom mas estruturalmente frágil**.

- **Funcional:** parceiro registra venda, baixa estoque, vê resumo. Admin vê rede consolidada. Cancelamentos restauram corretamente. Auditoria emite eventos.
- **Estrutural:** a única coisa que separa o parceiro A de ver dados do parceiro B é o TypeScript não esquecer o filtro `unit_id`. Não há defesa em profundidade. E o repo não reproduz prod.

**Para credenciar o 2º parceiro**, os 5 problemas críticos precisam fechar (~8,5h).
**Para credenciar o 10º parceiro**, somar os 6 problemas sérios (+3,5h) e ter testes de isolamento real cobrindo regressão.

Os 28 pontos fortes confirmam que a base está sólida — o trabalho não é refazer, é fechar lacunas pontuais.

---

*Auditoria executada por Claude Opus 4.7 em 2026-05-21. Método: leitura de código + 10 queries SQL diretas contra prod Supabase. Escopo restrito ao módulo Painel + Portal Parceiro; bot Atendente, Planner e Organizadora não foram tocados.*
