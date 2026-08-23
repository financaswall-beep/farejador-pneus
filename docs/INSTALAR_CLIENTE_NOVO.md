# Instalar o Farejador para um cliente novo

Guia de instalação de um sistema **zero km**: banco Supabase vazio → Farejador
pronto pra operar. Tempo real: **~10 minutos**, sendo ~9 esperando o Supabase.

Escrito depois da virada de **2026-08-23**, quando isso foi feito à mão pela
primeira vez. Cada tropeço daquele dia virou linha aqui — leia a seção
**"Quando der errado"** antes de achar que quebrou algo.

---

## Quando usar este guia

| situação | precisa de projeto novo? |
|---|---|
| Outro atacadista comprou o Farejador | ✅ sim — projeto próprio, dado isolado |
| Borracharia nova entrando na rede de um cliente existente | ❌ não — ela é um `partner_unit` no banco que já existe |
| Recomeçar do zero um banco que virou bagunça | ✅ sim (ou reinstalar por cima de um vazio) |

Cada projeto Supabase custa **US$ 10/mês**. Não crie um por borracharia — seria
dinheiro jogado fora e quebraria o roteamento da rede.

---

## Antes de começar

- [ ] Conta Supabase **sem fatura vencida** (com débito, a API recusa criar projeto)
- [ ] Repositório clonado, `npm install` rodado
- [ ] Node 22+ e acesso à internet

---

## Passo 1 — Criar o projeto no Supabase

Região: escolha a **mais perto do cliente**. Para o Brasil, `sa-east-1`
(São Paulo). O bot vive de milissegundo — um projeto nos EUA atravessa o
continente a cada consulta.

Nome: um padrão que diga de quem é, ex.: `farejador-<cliente>`. É só etiqueta,
dá pra renomear depois; o endereço técnico (`ref`) é sorteado e nunca muda.

## Passo 2 — Definir a senha do banco

**Configurações do projeto → Banco de dados → Redefinir senha do banco de dados.**

- A senha **não é visível depois de criada** — copie na hora.
- Use **só letras e números**. Símbolo (`@ # / ? :`) quebra a linha de conexão,
  porque esses caracteres já têm significado dentro de um endereço.
- Depois de confirmar, **espere ~1 minuto**. O reset derruba as conexões e leva
  um tempinho pra valer.

## Passo 3 — Montar o arquivo de ambiente

Crie um arquivo (ex.: `.env.novo`) na raiz do projeto. `.env.*` já está no
`.gitignore` — a senha não vai pro Git.

```bash
# Conexao: painel > Connect > Direct/Connection string > Session pooler > URI
# Pegue SEMPRE o Session pooler (porta 5432).
DATABASE_URL=postgresql://postgres.<ref>:<senha>@aws-0-<regiao>.pooler.supabase.com:5432/postgres
DATABASE_SSL=true

# Senha da role restrita do parceiro. VOCE INVENTA. Nao existe em lugar nenhum
# ainda. 24 caracteres, so letras e numeros, DIFERENTE da senha do banco.
PARTNER_DB_PASSWORD=<invente-uma>

# Dicionario da regiao onde o cliente opera (ver db/seeds/)
SEED_REGIAO=rio-de-janeiro

# Conta do dono do sistema
OWNER_USERNAME=<usuario>
OWNER_PASSWORD=<senha-do-dono>
OWNER_NOME=<Nome Exibido>

FAREJADOR_ENV=prod
```

> **Session pooler, sempre.** A *Direct connection* é IPv6 e muita rede
> brasileira não alcança. O *Transaction pooler* (6543) não segura a instalação,
> que roda numa transação única.

## Passo 4 — Instalar

```bash
npx tsx --env-file=.env.novo scripts/instalar-projeto.ts --confirmo
```

O que ele faz, em ordem:

1. **Recusa** se o banco já tiver o Farejador (só roda em banco vazio)
2. Liga a extensão `pg_cron`
3. Cria a role restrita `farejador_partner_app`
4. Aplica as migrations (transação única — se qualquer uma falhar, nada entra)
5. Carrega o dicionário da região
6. Cria a conta do dono

## Passo 5 — Provar

```bash
npx tsx --env-file=.env.novo scripts/prova-instalador.ts
```

Tem que dar **15 passaram, 0 falharam**. Ela confere o que importa: a senha
certa entra e a errada não, o dono tem papel de painel, o parceiro **não**
enxerga galpão nem comissão, e nenhuma tabela de negócio tem linha.

## Passo 6 — Apontar a aplicação

No Coolify (ou onde a aplicação roda), **duas** variáveis:

| variável | valor |
|---|---|
| `DATABASE_URL` | a mesma do `.env.novo` |
| `PARTNER_DATABASE_URL` | igual, mas com usuário `farejador_partner_app.<ref>` e a `PARTNER_DB_PASSWORD` |

⚠️ `PARTNER_DATABASE_URL` **não é opcional em produção**: sem ela o portal do
parceiro se recusa a subir. É de propósito — se caísse na conexão principal, o
parceiro passaria a enxergar tudo.

---

## Depois de instalar (o que o dono faz na tela)

O banco nasce com estrutura e dicionário, mas **sem nada do negócio**:

1. Cadastrar a **matriz** como unidade
2. Cadastrar as **medidas de pneu** que ele trabalha (o sistema recusa estoque
   numa medida fora do catálogo — é proposital)
3. Cadastrar o **estoque do galpão**
4. Cadastrar os **parceiros** e o raio de entrega **real** de cada um
5. Ligar as flags no Coolify e conferir o Chatwoot **antes** de apontar o webhook
   (conversa antiga é reprocessada pelo webhook e atrapalha)

---

## Quando der errado

| sintoma | causa provável | o que fazer |
|---|---|---|
| `There are overdue invoices` | fatura vencida na organização | quitar no painel; a API não cria projeto com débito |
| `password authentication failed for user "postgres"` | o reset não foi aplicado, ou ainda não propagou | refazer o reset e **esperar ~1 min**; teste em loop antes de concluir que falhou |
| `tenant/user ... not found` | host do pooler errado | copiar a linha do painel; a região faz parte do host |
| `timeout expired` logo após o reset | a instância está reiniciando | esperar e tentar de novo |
| A instalação para numa migration que chama `cron.schedule` | `pg_cron` não ligou | o instalador liga; se pulou (`--local`), não use esse modo em Supabase |
| Login recusa com a senha certa | falta `matriz_collaborators` com `panel_role` | a conta precisa de pessoa **e** papel de painel — o instalador cria os dois |
| Um bairro não resolve | não está na semente da região | o motor cai no Google e roteia por distância; pra resolver de vez, adicionar à semente |

---

## O que **não** é automático (e por quê)

- **A senha do `postgres`** — só o painel do Supabase define. A API recusa
  `ALTER USER postgres` (é role privilegiada) e `GRANT postgres` (sem admin option).
- **O dicionário regional** — é da região do cliente, não igual pra todo mundo.
  Para uma região nova: instale, cadastre os bairros, e gere a semente com
  `node --env-file=<env> scripts/gerar-seed-regiao.cjs <nome-da-regiao>`.
- **O catálogo de pneus** — é do negócio do cliente. Nasce vazio de propósito.

---

## Ensaiar sem gastar

Dá pra treinar a instalação inteira num Postgres de laboratório, de graça:

```bash
docker run -d --name lab -e POSTGRES_PASSWORD=lab -p 5433:5432 postgres:17
# no arquivo de ambiente: DATABASE_URL=postgres://postgres:lab@127.0.0.1:5433/postgres
# e DATABASE_SSL=false
npx tsx --env-file=.env.lab scripts/instalar-projeto.ts --confirmo --local
npx tsx --env-file=.env.lab scripts/prova-instalador.ts
```

O `--local` pula o `pg_cron` (que não existe no Postgres cru) e usa um agendador
de mentira. **Não dá pra usar errado**: o `replay-migrations` recusa o modo de
laboratório contra qualquer banco que não seja `localhost`.

---

## Referências

- `db/migrations/README.md` — regras do histórico de migrations
- `docs/DEPLOY_COOLIFY.md` — deploy da aplicação (outro assunto)
- `CLAUDE.md` — arquitetura e convenções do projeto
