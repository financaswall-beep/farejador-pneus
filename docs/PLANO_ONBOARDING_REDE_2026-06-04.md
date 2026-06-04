# Plano — Onboarding da Rede (cadastro de parceiros, login, níveis de acesso)

**Data:** 2026-06-04 · **Autor:** Claude (Sonnet 4.6) sob direção do Wallace
**Status:** PLANO (pré-implementação) — nenhum código escrito ainda.
**Branch:** `feat/fundacao-bot-partner-orders` (trilho de expansão; só abrir quando recrutar o 2º parceiro real)
**Companheiro:** `docs/SISTEMA_ANTIFRAUDE_REDE_2026-06-02.md` (antifraude, para depois do volume).
**Pré-requisito:** Redeploy do SEC-001 (commit `1d79735`) feito no Coolify antes de abrir esta frente.

---

## 0. Objetivo e princípio-mestre

Permitir que a Rede cresça com novos parceiros **sem mexer em código a cada um**. Adicionar parceiro
= criar cadastro/dado, não programação. Modelo análogo ao "Uber": a plataforma existe; o motorista
(parceiro) só precisa ser admitido.

**LEI do onboarding:**
> **O portão de aprovação é SEMPRE do dono (Wallace). Nenhum parceiro entra sem aprovação manual.**

---

## 1. Estado atual — o que já existe (não recriar)

### 1.1 Modelo multi-tenant — PRONTO

O banco já é multi-tenant: **mesmo banco, mesmas tabelas, isolado por `unit_id` + RLS**.
Parceiro novo herda o isolamento automaticamente. Não criar banco ou schema por parceiro.

| Tabela | O que guarda |
|---|---|
| `network.partners` | Pessoa jurídica: `legal_name`, `trade_name`, `document_number`, `responsible_name`, `whatsapp_phone`, `email`, `address`, `status`, `commercial_model`, `commission_percent`, `monthly_fee`, `notes` |
| `network.partner_units` | Unidade física: `partner_id`, `unit_id`, `slug`, `display_name`, `address`, `phone`, `status`, `deleted_at` |
| `network.partner_access_tokens` | Login por token: `partner_unit_id`, `token_hash` (sha256), `label`, `created_by`, `last_used_at`, `revoked_at` |

### 1.2 Função de autenticação — PRONTA

`network.validate_partner_token(environment, slug, token)`: valida slug + token, exige `unit` e
`partner` com `status='active'` e token não revogado. **Não tem conceito de papel/pessoa ainda.**

### 1.3 Portais — PRONTOS

- **Portal do parceiro:** `src/parceiro/` (`auth.ts`, `route.ts`, `queries.ts`) + `parceiro/public/`.
  Autenticação via `requirePartnerAuth`.
- **Painel da matriz:** `src/admin/painel/` + `painel/public/`.

### 1.4 Cobertura de região — HOJE HARDCODED

`PARTNER_COVERAGE` em `src/atendente-v2/fulfillment.ts` (~linha 225). Função `partnerCoversRegion`
lê dela. Trocar para leitura de tabela é a primeira tarefa da Etapa 1.

---

## 2. Modelo de cadastro escolhido: HÍBRIDO com aprovação

Decisão do Wallace (2026-06-04):

```
Interessado preenche formulário público
          ↓
    lead entra na fila (status=pending)
          ↓
  Wallace aprova na matriz (portão manual)
          ↓
  Sistema cria conta + gera token
          ↓
  Wallace manda o login pelo WhatsApp
```

- **Cadastro manual direto** (sem lead) também existe: Wallace pode criar o parceiro diretamente
  pela tela da matriz (útil para os primeiros parceiros em que o contato já foi feito off-line).
- **Antifraude** fica para depois (já desenhado em `docs/SISTEMA_ANTIFRAUDE_REDE_2026-06-02.md`);
  só faz sentido com volume.

---

## 3. Etapas

> Cada etapa é útil sozinha e sem retrabalho. Ordem recomendada: 1 → 2 (dão cadastro manual
> funcionando) → 3 (formulário público, quando houver volume) → 4 (papéis, quando o parceiro
> tiver equipe). Antifraude depois de tudo.

---

### ETAPA 1 — Motor de criação + cobertura por tabela

**Objetivo:** a Rede consegue cadastrar um parceiro pela matriz e o bot já roteia para ele
automaticamente, sem alterar `fulfillment.ts` a mão.

#### 1.1 Migration: `network.unit_coverage`

Criar tabela:

```sql
network.unit_coverage (
  id            uuid primary key default gen_random_uuid(),
  environment   text not null,
  unit_id       uuid not null references network.partner_units(unit_id),
  municipio     text not null,  -- normalizado: sem acento, minúsculo
  created_at    timestamptz default now()
)
```

Adicionar constraint para evitar duplicatas de cobertura:

```sql
UNIQUE (environment, unit_id, municipio)
```

Migrar a configuração atual: inserir linha `(environment, unit_id de Borracharia Rio do Ouro,
'itaborai')` para que a cobertura que hoje está hardcoded passe a viver nos dados.

#### 1.2 Migration: coluna `role` em `network.partner_access_tokens`

```sql
ALTER TABLE network.partner_access_tokens
  ADD COLUMN role text NOT NULL DEFAULT 'owner'
    CHECK (role IN ('owner', 'funcionario'));
```

Reserva o conceito de papel desde já. Barato agora; caro depois. `validate_partner_token` passa a
retornar o `role` junto com os dados do token. O `CHECK` evita valores arbitrários desde a origem.

#### 1.3 Função `network.create_partner_unit(...)`

Cria em uma chamada: `partner` + `unit` + token inicial (retorna o token em texto **uma única vez**)
+ linhas de cobertura em `unit_coverage`. **Idempotente apenas para evitar duplicação em
duplo-clique:** se o `slug` já existir retorna `already_exists: true` sem tentar devolver o token
(impossível — só o hash está no banco). Emitir ou rotacionar token é uma ação separada e explícita
("gerar novo token"), chamada depois da criação quando necessário.

Parâmetros mínimos: `environment`, `slug`, `display_name`, `legal_name`, `trade_name`,
`document_number`, `responsible_name`, `whatsapp_phone`, `email`, `address`, `municipios[]`,
`commercial_model`, `commission_percent`, `monthly_fee`.

#### 1.4 Backend matriz: `POST /admin/api/partners`

Endpoint admin-only que chama `network.create_partner_unit`. Retorna o token gerado para o Wallace
copiar e enviar ao parceiro via WhatsApp.

#### 1.5 Bot: trocar `PARTNER_COVERAGE` por leitura de `network.unit_coverage`

Em `src/atendente-v2/fulfillment.ts`, substituir a constante `PARTNER_COVERAGE` por uma consulta
à tabela `network.unit_coverage`. A assinatura de `decideStoreForItems` e `partnerCoversRegion`
**não muda** — só a fonte dos dados muda.

**Resultado da Etapa 1:** dá para cadastrar um parceiro pela matriz e o bot já roteia para ele.

**Data-alvo:** junto com o 2º parceiro real (não antes).

---

### ETAPA 2 — Tela "Novo parceiro" + fila de candidaturas na matriz

**Objetivo:** o Wallace tem interface visual para criar parceiros e para aprovar candidatos.

#### 2.1 Migration: `network.partner_applications`

```sql
network.partner_applications (
  id               uuid primary key default gen_random_uuid(),
  environment      text not null,
  trade_name       text not null,
  responsible_name text not null,
  whatsapp         text not null,
  email            text,
  address          text,
  municipio        text,           -- cobertura desejada (normalizado)
  status           text not null default 'pending',  -- pending | approved | rejected
  notes            text,
  reviewed_by      text,
  reviewed_at      timestamptz,
  created_at       timestamptz default now()
)
```

#### 2.2 Front matriz: tela "Novo parceiro"

No painel da matriz (`painel/public`), nova tela com duas abas:

- **Aba "Cadastro manual":** formulário completo → chama o motor da Etapa 1 → exibe o token gerado
  para Wallace copiar.
- **Aba "Candidaturas pendentes":** lista os registros com `status='pending'`. Para cada um:
  - **Aprovar** → chama o motor da Etapa 1 com os dados da candidatura, muda `status='approved'`,
    exibe o token gerado.
  - **Recusar** → muda `status='rejected'`, permite adicionar nota.

**Resultado da Etapa 2 (junto com Etapa 1):** cadastro manual funcionando + fila de aprovação pronta
para receber leads do formulário público.

---

### ETAPA 3 — Formulário público "Quero ser parceiro"

**Objetivo:** candidatos entram na fila sem precisar falar com Wallace antes.

#### 3.1 Página pública (sem login)

Página acessível sem autenticação (ex.: `/parceiro/quero-ser-parceiro`) com campos:

- Nome fantasia, responsável, WhatsApp, e-mail, endereço, cidade/cobertura desejada.

Ao enviar: insere em `network.partner_applications` com `status='pending'`.

#### 3.2 Anti-spam básico

Rate-limit por IP (ex.: 3 submissões / hora) no servidor. Não construir sistema complexo — a
aprovação manual já é o filtro principal.

**Resultado da Etapa 3:** o modelo híbrido está completo. Candidato preenche → Wallace aprova →
sistema cria conta → Wallace manda login.

**Quando construir:** quando houver volume ou campanha de recrutamento. Etapas 1 + 2 bastam para os
primeiros parceiros.

---

### ETAPA 4 — Níveis de acesso (dono vs funcionário)

**Objetivo:** o dono do parceiro consegue criar tokens para seus funcionários, com acesso restrito.

#### 4.1 Portal do parceiro: tela de gestão de tokens

Tela visível apenas para `role='owner'`. Permite:

- Criar token de funcionário: label (ex.: "João – Balcão"), gera token com `role='funcionario'`.
- Listar tokens ativos.
- Revogar token (preenche `revoked_at`).

O token é mostrado em texto **uma única vez** na criação; depois só o hash fica no banco.

#### 4.2 Gateamento de telas no portal

`validate_partner_token` já retorna `role`; `src/parceiro/auth.ts` expõe o campo. Regra:

| Tela | `owner` | `funcionario` |
|---|---|---|
| Vendas / Estoque / Atendimento | acesso | acesso |
| Financeiro (caixa, lucro, custos, margem) | acesso | bloqueado |
| Gestão de tokens | acesso | bloqueado |

#### 4.3 Hierarquia

```
Matriz (Wallace)
  └── cria DONO do parceiro (role='owner', 1 token inicial)
        └── DONO cria FUNCIONÁRIOS (role='funcionario', N tokens)
```

A matriz **não** cria tokens de funcionário — só o dono do parceiro faz isso.

**Resultado da Etapa 4:** cada parceiro tem acesso granular; o dono gerencia a própria equipe.

**Quando construir:** quando o primeiro parceiro tiver equipe real.

---

## 4. Guardas e cuidados

| # | Guarda | Razão |
|---|---|---|
| G1 | **Isolamento multi-tenant garantido por `unit_id` + RLS (automático).** Parceiro novo herda sem configuração extra. | Novo parceiro não enxerga dados de outro. |
| G2 | **Token sempre armazenado como hash sha256.** Texto em claro só na criação (tela ou resposta da API). | Igual ao padrão atual; segurança em caso de vazamento de banco. |
| G3 | **Endpoints de criação/aprovação são admin-only.** Usa a autenticação admin existente do painel da matriz. | Nenhum externo cria parceiro diretamente. |
| G4 | **Coluna `role` com `DEFAULT 'owner'` e `CHECK (role IN ('owner','funcionario'))`.** Tokens existentes continuam funcionando sem migration de dado. | Etapa 1 não quebra o parceiro-teste atual. |
| G5 | **Migrations aditivas.** Nenhum DROP ou rename de coluna existente. | Rollback seguro sem perda de dado. |
| G6 | **Função `create_partner_unit` idempotente por `slug`.** Retry não duplica parceiro. | Seguro para re-rodar em caso de erro de rede. |
| G7 | **Aprovação é sempre manual.** Formulário público só cria lead (`status='pending'`); quem cria conta é o Wallace. | Nenhum concorrente ou spammer entra na rede automaticamente. |

---

## 5. Dependências entre etapas

```
[Etapa 1] Motor de criação + unit_coverage
      ↓ (backend pronto para receber aprovações)
[Etapa 2] Tela da matriz + fila de candidaturas
      ↓ (fila existe, aceita leads externos)
[Etapa 3] Formulário público (quando volume)
      ↓ (parceiros com equipe)
[Etapa 4] Níveis de acesso
      ↓ (só com volume real)
[Antifraude] docs/SISTEMA_ANTIFRAUDE_REDE_2026-06-02.md
```

---

## 6. Cronograma indicativo

| Etapa | Quando abrir | Gatilho |
|---|---|---|
| **Etapa 1 + 2** | Ao recrutar o 2º parceiro real | Necessidade operacional real |
| **Etapa 3** | Quando houver campanha ou volume de leads | Mais de 2–3 candidatos/semana |
| **Etapa 4** | Quando 1º parceiro tiver funcionário | Parceiro pede acesso para equipe |
| **Antifraude** | Depois de todas as etapas | Volume justifica |

**Pré-requisito absoluto:** antes de abrir qualquer etapa desta frente, o Redeploy do SEC-001
(commit `1d79735`) precisa estar feito no Coolify.

---

## 7. O que NÃO está neste plano

- **Contrato digital / assinatura eletrônica:** processo comercial, fora do escopo técnico agora.
- **Onboarding guiado no portal do parceiro** (tour, checklist): UX, para depois.
- **Notificação automática por e-mail/WhatsApp ao aprovar candidatura:** útil, mas não bloqueia.
  Wallace manda o login manualmente pelo WhatsApp no início.
- **Multi-nível de hierarquia** (supervisor de rede, regional): não existe demanda hoje.
- **Antifraude automático:** ver `docs/SISTEMA_ANTIFRAUDE_REDE_2026-06-02.md`.

---

## 8. Resumo executivo

O modelo multi-tenant já existe e funciona — a única coisa que falta é a interface de admissão de
novos parceiros. O plano tem quatro etapas progressivas: a Etapa 1 cria o motor SQL de cadastro e
migra a cobertura de hardcoded para tabela; a Etapa 2 coloca uma tela no painel da matriz para
cadastro manual e aprovação de candidaturas; a Etapa 3 abre o formulário público (quando houver
volume); e a Etapa 4 granulariza o acesso por papel (dono vs funcionário). **Etapas 1 + 2 juntas
são suficientes para os primeiros parceiros reais.** O portão de aprovação é sempre do Wallace —
nenhum parceiro entra automaticamente.

---

## Ajustes e decisões pós-revisão (2026-06-04)

**Plano APROVADO pelo dono (Wallace) em 2026-06-04** com os ajustes abaixo incorporados.

---

### Ajustes técnicos na Etapa 1

**1. Token não-recuperável — idempotência de criação redefinida**

A função `create_partner_unit` armazena apenas o **hash sha256** do token — o texto em claro
nunca é persistido. Por isso:

- Se o `slug` já existir → retornar `already_exists: true` sem tentar devolver o token (impossível
  recuperar o texto do hash).
- Emitir ou rotacionar token é uma **ação separada e explícita** ("gerar novo token"), não parte
  do fluxo de criação.
- O token em texto claro aparece **uma única vez**: no momento da emissão, na resposta da API ou
  na tela. Depois disso, perdeu.
- A idempotência da criação serve exclusivamente para evitar parceiro duplicado num duplo-clique.

**2. Constraint UNIQUE em `network.unit_coverage`**

```sql
UNIQUE (environment, unit_id, municipio)
```

Impede que a mesma cobertura seja inserida mais de uma vez para a mesma unidade/ambiente.
Deve ser criada junto com a tabela na migration.

**3. CHECK na coluna `role` de `network.partner_access_tokens`**

```sql
ADD COLUMN role text NOT NULL DEFAULT 'owner'
  CHECK (role IN ('owner', 'funcionario'))
```

Garante que só valores conhecidos entrem no banco desde a origem. Nenhum valor arbitrário de
papel é aceito silenciosamente.

**4. SECURITY DEFINER — decidir na hora de codar**

Preferência: **não usar SECURITY DEFINER** se o role do endpoint admin já tiver privilégio direto
nas tabelas `network.*`. Sumir com o footgun é melhor do que blindá-lo.

Se, ao inspecionar os privilégios do role admin, o SECURITY DEFINER for mesmo necessário, então
**obrigatoriamente**:
- Fixar `search_path` na função.
- Validar `environment` e `slug` dentro da função.
- Garantir que a função só seja chamável pelo endpoint admin (sem exposição pública via RPC).

Decisão adiada para o momento de codar, quando os privilégios estiverem visíveis.

---

### Decisões do dono sobre pontos que estavam em aberto

**5. Notificação de candidatura nova**

Começa simples: **badge/contador na própria tela da matriz** ("N candidaturas pendentes").
Aviso por WhatsApp ou e-mail fica para depois, quando houver volume que justifique.

**6. Termos comerciais no formulário público**

`commission_percent`, `monthly_fee` e `commercial_model` **não entram no formulário público**.
O formulário coleta apenas identidade e contato: nome fantasia, responsável, WhatsApp, e-mail,
endereço e cidade/cobertura desejada.

Os termos comerciais são preenchidos pelo Wallace **na hora de aprovar**, na tela de aprovação
da Etapa 2 (que terá esses campos).

**7. Geração do slug**

O slug é **gerado automaticamente** a partir do `trade_name`:
- Regra: lowercase, sem acento, espaços viram hífens (ex.: "Borracharia Rio do Ouro" →
  `borracharia-rio-do-ouro`).
- Em caso de colisão: acrescentar sufixo numérico (`-2`, `-3`, …).
- O Wallace pode **editar o slug antes de confirmar** a criação (campo editável na tela).

---

### Primeiro pedaço a codar (quando a frente abrir)

Sequência mínima para a Etapa 1 funcionar, nesta ordem:

1. Migration `unit_coverage` (tabela + constraint UNIQUE + seed com cobertura atual do Itaboraí).
2. Migration coluna `role` com `CHECK` em `partner_access_tokens`.
3. Função `create_partner_unit` (criar + emitir token, lógica de `already_exists`, sem SECURITY
   DEFINER se os privilégios permitirem).
4. Endpoint admin `POST /admin/api/partners` que chama a função e devolve o token para o Wallace.
5. Substituir `PARTNER_COVERAGE` hardcoded em `src/atendente-v2/fulfillment.ts` por leitura de
   `network.unit_coverage`.
