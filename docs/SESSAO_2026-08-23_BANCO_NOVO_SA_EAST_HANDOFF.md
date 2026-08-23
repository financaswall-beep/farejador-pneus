# Sessão 2026-08-23 — Banco NOVO em São Paulo (virada de produção)

> **Para quem chega agora (Codex, Claude, ou humano):** o Farejador ganhou um
> banco de dados **novo, vazio e provado**, num projeto Supabase diferente. O
> banco antigo **continua intacto** e ainda é o que está em produção até o dono
> trocar duas variáveis no Coolify. Leia a seção **Estado atual** antes de
> tocar em qualquer coisa.

---

## 1. Por que isso aconteceu

O dono pediu: *"finalizamos o sistema, como zerar sem quebrar nada?"*

Premissa dele, **reconfirmada três vezes** (06-22, 08-21 e 08-22, esta última na
forma mais ampla): **TODO dado existente é teste** — conversas, unidades/lojas,
pneus, estoque, catálogo. Nenhum cliente real passou pelo sistema. Nada de
negócio precisa sobreviver.

Depois surgiu o motivo maior: ele vai **vender o Farejador para outros
atacadistas**. Cada comprador terá o próprio projeto Supabase (US$ 10/mês,
dado isolado). Isso transformou "zerar o banco" em **"tornar a instalação
reprodutível"** — que é o entregável real desta sessão.

> ⚠️ Borracharia nova entrando na rede de um cliente **NÃO** precisa de projeto
> novo — é um `partner_unit` no banco existente. Um projeto por borracharia
> seria dinheiro jogado fora e quebraria o roteamento da rede.

---

## 2. Decisão de caminho (e por que a alternativa foi recusada)

Uma LLM externa propôs: criar projeto novo, rodar as 201 migrations, pronto.
**Recusei o plano como estava** e o verifiquei antes de opinar. Os furos:

1. O banco tinha **103 migrations registradas** em `supabase_migrations`, contra
   **201 arquivos** no repo. O banco não foi construído só por esses arquivos.
2. O próprio `scripts/replay-migrations.cjs` **remenda 3 migrations em memória**
   (`migration-compat.cjs`) e **finge o `cron.schedule`** pra rodar em banco
   vazio. Replay ≠ cópia fiel.
3. `test` e `prod` são o **mesmo banco físico**, separados só pela coluna
   `environment` — projeto novo significa refazer os dois e repontar tudo.
4. ~30 tabelas **recusam DELETE** por gatilho de imutabilidade (raw, ledger da
   matriz, comissões, histórico de preço). O plano não mencionava isso.

**Conclusão adotada:** o projeto novo é viável, mas só depois de **provar** que
a planta reconstrói o sistema — e de consertar o que ela não cobria.

---

## 3. A prova de reconstrução (custo zero)

Postgres 17 vazio em Docker local → `replay-migrations.cjs --commit
--bootstrap-local` → comparação de **impressão digital** com a produção:
tabelas, colunas, funções, gatilhos, índices, constraints, views e **grants**,
cada grupo reduzido a um md5.

**Resultado que matou o maior medo:** os **69 grants** de
`farejador_partner_app` reconstroem com hash **`d718da85…` idêntico ao de
produção**. A trava que impede o parceiro de enxergar o galpão da matriz vem
das migrations, fielmente — **não precisa de mão humana**.

---

## 4. Os quatro furos encontrados (e consertados)

### 4.1 🔴 Duas peças de analytics que o código lê e nenhuma migration cria

| objeto | quem consome | o que quebrava num banco novo |
|---|---|---|
| `analytics.customer_journey_mv` | `src/atendente-v2/agent.ts:54` | **o BOT**, no meio do atendimento |
| `analytics.v_clientes_pra_recuperar` | `src/admin/painel/queries-rede-resumo.ts:160` | a aba Resumo / Rede |

Foram criadas à mão em produção, um dia, e nunca versionadas. Junto ia embora o
cron `analytics-journey-refresh` (03:15 UTC) — sem ele a matview nasce e
**congela**, e o bot passa a ler um retrato velho pra sempre.

**Não é teoria:** a migration `0177` existe **exatamente por causa desse bug**.
O cabeçalho dela documenta que a `0134` só recriava `v_daily_metrics` quando uma
view histórica já existia, então *"um banco novo terminava sem o resumo
consumido pela Matriz"*. Alguém consertou **uma** peça e foi embora.

→ Conserto: **`db/migrations/0201_analytics_greenfield_views.sql`**. Definições
copiadas **verbatim** de `pg_get_viewdef`, idempotente (no-op em prod), índice
único pro `REFRESH CONCURRENTLY`, cron no padrão da 0096, e **smoke dentro da
própria migration** (se qualquer peça não subir, aborta).

⚠️ **A 0201 ainda NÃO foi aplicada no banco antigo (produção atual).** Lá ela é
no-op, mas registra em código duas peças que hoje não existem em lugar nenhum.

### 4.2 🔴 A role `farejador_partner_app` não nasce de migration

**89 migrations dão GRANT pra ela. Nenhuma a cria.** No teste local ela só
existiu porque `--bootstrap-local` a criou — e esse modo é **recusado fora de
loopback**, de propósito.

Perfil exato conferido em produção (replicado no banco novo):

```
LOGIN · NOSUPERUSER · NOBYPASSRLS · NOINHERIT · NOCREATEDB · NOCREATEROLE
```

`NOBYPASSRLS` é a alma: as regras de isolamento valem pra ela sem exceção.

### 4.3 🟠 `pg_cron` não é criada por migration

Mas a `0096` (partições automáticas) e a `0201` chamam `cron.schedule`. Sem
ligar **antes**, a instalação falha no meio.

### 4.4 🟡 O dicionário de bairros é regional

624 bairros do Rio não servem pra um cliente de Belo Horizonte. Não cabe numa
migration, que é igual pra todo mundo. Virou **semente** (`db/seeds/`).

---

## 5. O que foi construído (a "receita")

| arquivo | o que faz |
|---|---|
| `scripts/instalar-projeto.ts` | banco vazio → zero km num comando. Recusa banco já instalado; `--local` ensaia em laboratório |
| `scripts/prova-instalador.ts` | prova que o banco nasceu **usável**, não só "sem erro" — 15 checagens |
| `scripts/criar-conta-dono.ts` | cria/repõe conta de dono em banco já instalado (também é o resgate se ninguém logar) |
| `scripts/gerar-seed-regiao.cjs` | gera a semente de qualquer região a partir de um banco que já a tenha |
| `db/seeds/regiao-rio-de-janeiro.sql` | 624 bairros + 141 modelos de moto |
| `docs/INSTALAR_CLIENTE_NOVO.md` | runbook passo a passo, com tabela "quando der errado" |

Comandos: `npm run instalar-projeto`, `npm run prova-instalador`,
`npm run gerar-seed-regiao`.

**PRs mergeados na `main`:** [#82](https://github.com/financaswall-beep/farejador-pneus/pull/82) e [#83](https://github.com/financaswall-beep/farejador-pneus/pull/83).

> Nenhuma linha de `src/` mudou. **Não precisa de Deploy** por causa disso.

---

## 6. O catálogo de pneus NÃO foi copiado (achado importante)

Auditei antes de copiar. O "catálogo de 74 medidas" da produção é **resto de
teste**:

| | |
|---|---|
| produtos apagados (soft delete) | **68 de 74** |
| medidas vivas | **6** — e três são o mesmo `90/90-18` |
| compatibilidades apontando pra produto apagado | **163 de 200** |
| motos com compatibilidade viva | **18** de 141 |

Confirma a palavra do dono. **Ficou de fora de propósito.** Bônus: no banco novo
a trava `validate_tire_catalog_variant` (0156) passa a valer de verdade — em
produção ela está *grandfathered* pelo dado herdado que a violaria.

**Copiado (dicionário puro):** 624 bairros + 141 modelos de moto.
**Já vem das migrations:** os 92 municípios (`network.municipality_catalog`).

---

## 7. Estado atual

### Projetos Supabase

| projeto | ref | região | papel |
|---|---|---|---|
| **Farejador** | `aoqtgwzeyznycuakrdhp` | us-west-2 | **produção HOJE** — intacto, é o plano B |
| **farejador-matriz** | `beisgivepyfhgcujsqan` | **sa-east-1** | o banco novo, pronto e vazio |
| ~~betaAgente~~ | — | — | **apagado pelo dono** (era o protótipo v1) |

A mudança de região é ganho real: o bot vive de milissegundo e hoje toda
consulta atravessa o continente.

### Banco novo — `prova-instalador` 15/15 contra o Supabase real

```
156 tabelas · 69 grants do parceiro (hash igual ao de prod) · 4 crons ativos
624 bairros · 141 motos · 92 municípios
unidade main (Loja Principal) — criada pelas migrations
conta de dono: wallace (panel_role=owner) — criada e provada
pedidos, conversas, parceiros, estoque: TODOS ZERADOS
```

Credenciais em **`.env.novo`** (gitignored, na máquina do dono). Não estão aqui
de propósito.

---

## 8. O que falta

| prioridade | pendência |
|---|---|
| 🔴 | **O bot está MUDO em produção desde 17/08** — OpenAI sem crédito, 11 jobs em `ops.atendente_dead_letters`. Não dá pra inaugurar assim |
| 🟠 | Trocar `DATABASE_URL` + `PARTNER_DATABASE_URL` no Coolify e dar Deploy (a virada em si) |
| 🟠 | **Rotacionar segredos** — o dono colou o painel inteiro do Coolify no chat: token Meta Ads, `META_APP_SECRET`, VAPID privada, Google Maps key, senha do parceiro. Mais a senha do `postgres` do banco novo |
| 🟡 | Limpar as conversas de teste no **Chatwoot** antes de o webhook alimentar o banco novo (senão ele reprocessa tudo) |
| 🟡 | Aplicar a `0201` no banco **antigo** (no-op, mas protege) |
| 🟡 | Cadastrar no banco novo: medidas de pneu, estoque do galpão, parceiros e os **raios reais** |

---

## 9. Armadilhas (custaram tempo nesta sessão)

- **A senha do `postgres` só se resolve pelo painel do Supabase.** A API recusa
  `ALTER USER postgres` (role privilegiada) e `GRANT postgres` (sem admin
  option). O reset leva **~1 minuto pra propagar** — testar em loop antes de
  concluir que falhou. Perdemos várias rodadas achando que era erro de digitação.
- **Session pooler (5432), sempre.** *Direct connection* é IPv6 e a rede
  brasileira não alcança; *Transaction pooler* (6543) não segura a instalação,
  que roda em transação única. No pooler o `ref` do projeto vai no **usuário**
  (`postgres.<ref>`), não no host — um freio que checava o host deu falso
  negativo por isso.
- **Senha de banco só com letras e números.** Símbolo (`@ # / ? :`) quebra a
  linha de conexão.
- **Fatura vencida na organização bloqueia a criação de projeto** — a API
  responde `PaymentRequiredException`. Não é bug.
- **Login da matriz precisa de `panel_role`.** Existir em
  `network.partner_people` não basta: `authenticateMatrizAdmin` exige TAMBÉM um
  `network.matriz_collaborators` com `panel_role` ('owner'|'admin'),
  `display_name`, `job_title` e `work_area`. Sem isso o login devolve **null com
  a senha certa**.
- **`reltuples` mente em banco recém-criado** (vem `-1` por tabela nunca
  analisada). Pra saber se está vazio, use `count(*)`.
- **`sha256sum` do Git Bash no Windows** prefixa `*` (modo binário) e quebra o
  formato do `manifest.sha256`. Montar a linha com `printf '%s  %s\n'`.
- **Caminhos `/tmp` viram caminho Windows** no Git Bash ao passar pro Docker —
  usar `MSYS_NO_PATHCONV=1`.

---

## 10. Referências

- `docs/INSTALAR_CLIENTE_NOVO.md` — o runbook de instalação
- `db/migrations/README.md` — regras do histórico de migrations
- `db/migrations/0201_analytics_greenfield_views.sql` — o conserto, com o porquê no cabeçalho
- `CLAUDE.md` — arquitetura e convenções do projeto
