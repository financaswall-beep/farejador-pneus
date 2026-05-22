# Revisao Codex — Plano Etapa 5 RLS

**Data:** 2026-05-21  
**Documento revisado:** `docs/PLANO_ETAPA5_RLS_2026-05-21.md`  
**Parecer:** aprovado como direcao, **nao aprovado para execucao ainda**.  
**Assinatura:** Codex

---

## Parecer executivo

A direcao geral do plano esta correta:

- criar uma role separada para o portal parceiro;
- nao mexer no pool do bot/admin;
- usar `PARTNER_DATABASE_URL`;
- validar token por uma funcao controlada;
- planejar rollback;
- nao aplicar nada em producao antes de revisao.

Porem, existem pontos de seguranca e reprodutibilidade que precisam ser corrigidos antes de implementar. A Etapa 5 mexe no isolamento entre parceiros, entao nao pode ir para producao com falsa sensacao de protecao.

---

## Bloqueios antes da execucao

### 1. Remover `IS NULL OR` das policies do portal parceiro

O plano mantem o padrao:

```sql
network.current_partner_unit() IS NULL
OR unit_id = network.current_partner_unit()
```

Isso e fraco para a role restrita. Se alguma query do portal usar a role `farejador_partner_app` sem setar `app.partner_unit_id`, a policy passa tudo.

O proprio plano reconhece esse problema na secao de testes:

> Sem GUC setado, a policy IS NULL OR... passa por todas.

Para a Etapa 5, as policies usadas pelo portal parceiro devem ser estritas:

```sql
network.current_partner_unit() IS NOT NULL
AND ...
```

Admin e bot continuam usando `postgres` com `BYPASSRLS`, entao nao precisam do buraco `IS NULL OR` para enxergar tudo.

**Pedido:** ajustar o plano para criar/recriar policies estritas nas tabelas usadas pelo portal parceiro.

---

### 2. Resolver claramente `partner_unit_id` vs `unit_id`

O plano propoe:

```ts
withPartnerContext(ctx.partnerUnitId)
```

Mas varias tabelas do parceiro usam `unit_id`, que representa `core.units.id`, nao `network.partner_units.id`.

Exemplo:

- `network.partner_units.id` = id da unidade parceira dentro do modulo network;
- `network.partner_units.unit_id` = id da unidade em `core.units`;
- `commerce.partner_orders.unit_id` = aponta para `core.units.id`;
- `commerce.partner_stock_levels.unit_id` = aponta para `core.units.id`;
- `finance.partner_expenses.unit_id` = aponta para `core.units.id`.

Se `current_partner_unit()` retornar `network.partner_units.id` e a policy comparar direto com `commerce.*.unit_id`, o isolamento quebra funcionalmente: pode bloquear tudo ou comparar IDs de naturezas diferentes.

**Pedido:** escolher uma regra e documentar explicitamente.

Minha recomendacao:

- manter `app.partner_unit_id` como `network.partner_units.id`;
- criar helper:

```sql
network.current_partner_core_unit()
```

que resolve:

```sql
SELECT unit_id
FROM network.partner_units
WHERE id = network.current_partner_unit()
```

E usar:

```sql
unit_id = network.current_partner_core_unit()
```

nas tabelas `commerce.*` e `finance.*`.

---

### 3. Garantir que views nao bypassam RLS

O plano concede `GRANT SELECT` em views:

- `network.partner_unit_summary`;
- `commerce.partner_orders_full`.

Em Postgres, views podem executar com privilegio do dono da view. Se o dono for `postgres` com `BYPASSRLS`, a view pode furar RLS e devolver dados de outras unidades mesmo que a role restrita esteja correta.

**Pedido:** o plano precisa tratar isso explicitamente.

Opcoes aceitaveis:

1. recriar views usadas pelo portal com `security_invoker = true`, se suportado pela versao do Postgres/Supabase;
2. nao usar views no portal restrito e trocar por queries diretas em tabelas com RLS;
3. manter views, mas criar testes explicitos provando que `farejador_partner_app` com contexto da unidade A nao ve dados da unidade B via cada view.

Minha preferencia: usar `security_invoker = true` nas views consumidas pelo portal e ainda manter testes de isolamento.

---

### 4. Revogar `EXECUTE` publico na function `SECURITY DEFINER`

O plano cria:

```sql
CREATE OR REPLACE FUNCTION network.validate_partner_token(...)
SECURITY DEFINER
```

Isso faz sentido, mas function `SECURITY DEFINER` precisa ser tratada como superficie sensivel. Por padrao, o Postgres pode conceder `EXECUTE` para `PUBLIC`.

**Pedido:** adicionar explicitamente:

```sql
REVOKE ALL ON FUNCTION network.validate_partner_token(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION network.validate_partner_token(TEXT, TEXT, TEXT) TO farejador_partner_app;
```

Tambem manter `SET search_path` fixo, como o plano ja propoe.

---

### 5. Nao versionar senha nem placeholder de senha dentro da migration

O plano sugere versionar algo como:

```sql
CREATE ROLE farejador_partner_app LOGIN PASSWORD '<SENHA_GERADA_FORA>' NOBYPASSRLS;
```

Isso e ruim por dois motivos:

- migration versionada passa a depender de substituicao manual;
- clone fresh/CI pode falhar ou aplicar algo invalido;
- aumenta chance de alguem colar senha real no Git sem querer.

**Pedido:** separar em dois artefatos:

1. **Runbook operacional**, nao migration:

```sql
CREATE ROLE farejador_partner_app LOGIN PASSWORD '<senha gerada fora do repo>' NOBYPASSRLS;
ALTER ROLE farejador_partner_app NOSUPERUSER NOBYPASSRLS NOINHERIT;
```

2. **Migration versionada `0044`**, sem senha, contendo apenas:
   - functions;
   - policies;
   - grants;
   - comments;
   - validacoes que nao dependam de segredo.

---

### 6. Reconciliar/versionar policies que existem em prod mas nao aparecem nas migrations locais

Ao revisar o repo local, nao encontrei nas migrations `0035-0043`:

- `ENABLE ROW LEVEL SECURITY`;
- `CREATE POLICY`;
- `network.current_partner_unit()`;
- `app.partner_unit_id`.

O plano e a auditoria dizem que 7 policies ja existem em prod via MCP.

Isso indica drift: o banco de producao tem estado que o repo local nao reproduz completamente.

**Pedido:** antes de executar a Etapa 5, criar uma migration de reconciliacao ou incluir na `0044` todo o estado necessario para que um banco fresh tenha as mesmas RLS/policies.

Sem isso, a seguranca real depende de mudancas manuais em prod e o projeto deixa de ser reprodutivel.

---

## Ajustes recomendados nos testes

Os testes propostos precisam mudar.

O teste que aceita este comportamento:

```ts
// Sem GUC setado, a policy IS NULL OR... passa por todas
```

nao deve existir como comportamento aceito.

O comportamento correto para `farejador_partner_app` sem contexto deve ser:

- retornar zero linhas; ou
- falhar por policy/permissao;
- nunca listar tudo.

Testes minimos esperados:

1. parceiro A com contexto A nao ve `partner_orders` de B, mesmo sem `WHERE`;
2. parceiro A com contexto A nao ve estoque de B, mesmo sem `WHERE`;
3. parceiro A com contexto A nao ve despesas de B, mesmo sem `WHERE`;
4. parceiro A com contexto A nao ve compras de B, mesmo sem `WHERE`;
5. role restrita sem contexto nao ve dados de nenhum parceiro;
6. `validate_partner_token` funciona sem SELECT direto em `partner_access_tokens`;
7. `SELECT * FROM network.partner_access_tokens` falha para `farejador_partner_app`;
8. views do portal tambem respeitam isolamento;
9. venda/cancelamento/compra/despesa continuam funcionando com a role restrita;
10. bot/admin continuam funcionando pelo pool antigo.

---

## Mensagem pronta para o Opus

Pode mandar assim:

> Plano aprovado como direcao, mas nao aprovado para execucao ainda.
>
> Ajusta antes:
>
> 1. Remover `IS NULL OR` das policies do portal parceiro. Policies da role restrita precisam ser estritas.
> 2. Resolver claramente `partner_unit_id` vs `unit_id`. Se o GUC guardar `network.partner_units.id`, criar helper para obter `core.units.id` e usar nas tabelas `commerce.*` e `finance.*`.
> 3. Garantir que views usadas pelo portal nao bypassam RLS, idealmente com `security_invoker = true` ou testes explicitos via role restrita.
> 4. Adicionar `REVOKE EXECUTE FROM PUBLIC` na function `validate_partner_token`.
> 5. Nao colocar senha/placeholder de role em migration versionada. Separar criacao da role/senha em runbook operacional.
> 6. Versionar/reconciliar as policies que hoje parecem existir em prod mas nao aparecem nas migrations locais.
>
> Depois disso, entrega uma V2 do plano. Ainda sem aplicar nada em prod, sem criar role, sem migration, sem Coolify.

---

## Conclusao

A Etapa 5 e a direcao correta para proteger dados entre parceiros antes do primeiro parceiro real.

Mas ela so deve ser implementada depois desses ajustes. O ponto mais perigoso e manter `IS NULL OR`, porque isso preserva exatamente a falha que a Etapa 5 tenta resolver: se o contexto nao for setado, a role restrita ainda pode enxergar dados demais.

**Assinado:** Codex  
**Data:** 2026-05-21
