# Handoff — Sessão 2026-06-05 — Etapa 4 (níveis dono/funcionário) LIVE

> Onde paramos, o que está no ar, o que falta e o time de agentes.
> Continua o roadmap de Onboarding da Rede (recrutamento + operação de parceiros).

---

## TL;DR (1 parágrafo)
A **Etapa 4 do onboarding — níveis dono/funcionário — está LIVE em produção** (commit `6e19151` na `main` do remoto `pneus`; migration `0085` aplicada e verificada no banco prod). O dono vê tudo; o **funcionário** vê só o operacional (Frente de caixa, Vendas, Estoque, Pedidos, Clientes, Entrega) e **não** vê Financeiro, Resumo nem Configurações. O dono cria/desativa logins de funcionário na nova aba **Configurações → Funcionários**. Validado AO VIVO: criado um funcionário de teste no **Borracharia Rio do Ouro**, login caiu na régua restrita certinho. Também subiu nesta sessão o **e-mail opcional de verdade** no `/seja-parceiro` (front + backend).

---

## O que foi feito nesta sessão (2026-06-05)

### 1. E-mail opcional no /seja-parceiro
- Front: campo deixou de ser `type="email"` (era o navegador que travava com "Invalid email").
- Backend (`src/admin/painel/route.ts`): `z.preprocess` — vazio vira `null`, sem validação de formato. O canal real do parceiro é o WhatsApp.
- Commit `09a6aff` (reconciliado na main).

### 2. Etapa 4 — autorização por papel (dono/funcionário)
Decisão de negócio do dono (Wallace). Régua final:

| Seção | 👷 Funcionário | 👑 Dono |
|---|:---:|:---:|
| Estoque, Frente de caixa/Vendas, Pedidos, Clientes, Entrega | ✅ | ✅ |
| **Financeiro** (caixa, despesas, compras, contas a pagar/receber, fluxo) | 🔒 | ✅ |
| **Resumo** (dashboard com dinheiro) | 🔒 | ✅ |
| **Configurações** (incl. criar funcionário) | 🔒 | ✅ |
| Bate-papo | ⏸️ standby | ⏸️ standby |

Camadas (commit `d14860b`):
- **DB `0085`** — `network.validate_partner_token` passou a devolver `role` (DROP+CREATE, re-GRANT pra `farejador_partner_app`). A coluna `role` já existia na `0083`.
- **`src/parceiro/auth.ts`** — `PartnerContext.role` + guard `requireOwner` (403 pra funcionário). Fail-safe: qualquer valor ≠ `'owner'` é tratado como funcionário (menos privilégio).
- **`src/parceiro/route.ts`** — 19 endpoints de Financeiro/Resumo agora exigem `[requirePartnerAuth, requireOwner]`. Novo `GET /api/me` (liberado) devolve o papel pro front.
- **front (`parceiro/public/`)** — `x-show="isOwner"` esconde Resumo/Financeiro/Configurações; `loadData` só busca o bloco financeiro se for dono (funcionário nem chama → sem 403); `goToSection` blinda atalho de teclado; funcionário cai na Frente de caixa.
- **`src/atendente-v2/fulfillment.ts`** — contexto de sistema do bot = `role:'owner'` (autoridade total).
- **testes** — `requireOwner` 403/200 + fixture aceita `role` (rodam no CI; Docker off local).

### 3. Etapa 4c — dono gerencia funcionários
Commit `5f75815`:
- **`src/parceiro/queries.ts`** — `createPartnerFuncionarioToken` / `listPartnerFuncionarios` / `revokePartnerFuncionario`. Usa o pool admin (mesmo padrão do chat), escopado a `ctx.partnerUnitId`. `role` SEMPRE `'funcionario'` (dono não cria outro dono → sem escalonamento). Revogar só pega `role='funcionario'` (dono nunca se tranca fora). Token em texto devolvido UMA vez (banco guarda só o hash via `network.hash_partner_token`).
- **`src/parceiro/route.ts`** — `GET/POST/DELETE /api/funcionarios`, todos `ownerOnly`.
- **front** — aba Configurações com card Funcionários: lista, desativa, e form que cria o login revelando o token uma vez (botão copiar + link de acesso).

### 4. Migration 0085 aplicada em PROD com protocolo seguro
- Snapshot de rollback guardado (definição antiga da função).
- **Teste-sombra**: função-cópia com o corpo novo, testada contra tokens mintados no Anderson → devolveu `owner`/`funcionario` certo, ANTES de tocar na função real.
- Aplicada a real (DROP+CREATE+GRANT, atômico). Verificada (role certo + EXECUTE no lugar + login intacto).
- Tokens e função de teste **limpos** (zero lixo).
- É **retrocompatível**: o código que estava no ar ignorava a coluna extra → aplicar cedo não quebrou nada.

### 5. Reconciliação de branches + deploy
- `main` e `feat` tinham divergido (restyle do `/seja-parceiro` em hashes diferentes, mas conteúdo idêntico).
- Merge `feat→main` **limpo** (sem conflito). `main` = `6e19151`, pushada pro `pneus`.
- Wallace deu o **redeploy** no Coolify → Etapa 4 LIVE (confirmado: `/api/me` e `/api/funcionarios` respondem 401, antes 404).

---

## Estado atual (o que está no ar)
- ✅ Onboarding Etapas 1, 2, 3 (criar parceiro, tela Novo parceiro, candidaturas públicas) — live de sessões anteriores.
- ✅ **Etapa 4 (dono/funcionário) — LIVE** (`6e19151`).
- ✅ E-mail opcional no /seja-parceiro — live.
- ✅ Migration `0085` aplicada em prod.

## ⚠️ Dado de teste a limpar (em prod)
- **Token de funcionário de teste** no Borracharia Rio do Ouro: `label='TESTE funcionario (Etapa 4)'`, `created_by='teste-etapa4'`, role funcionario. Plaintext: `2184358a5f0cd5446c99547532cc9d0575948b2a6b5fd071`.
  - Remover via SQL (`DELETE ... WHERE created_by='teste-etapa4'`) **ou** o dono desativa pela tela (Configurações → Funcionários → Desativar).
- Pendências antigas ainda de pé: Anderson Tavares fica como **fixture de teste de banco** (decisão do dono). Pedido `df730693` + 2 pneus teste no Anderson.

## Próximos passos / backlog (prioritizado)

### 🔴 Prioridade 1 — Login de verdade (dono E funcionário) — O MAIOR BURACO
**Problema:** hoje dono e funcionário entram do MESMO jeito — colando um token (hex de ~48 chars) no campo de login em `/parceiro/{slug}`. Não tem usuário+senha. O token é que carrega o papel (owner/funcionario).
- Pro **dono** "funciona" (colou uma vez, o navegador lembrou).
- Pro **funcionário** é tosco: alguém entrega o token na mão, ele cola na primeira vez, troca de celular = cola de novo. Sem "esqueci a senha", sem nada familiar.

**O conserto é UM só, serve os dois:** trocar "cole esse código" por algo humano. O token continua existindo por baixo (é o que segura a segurança) — só fica escondido atrás de uma tela amigável.

**DECISÃO DO DONO (pendente) — define o tamanho do trabalho:**
- **(a) Usuário + senha** — mais tradicional; o dono escolhe a senha de cada login. Mais campos, "esqueci a senha" etc.
- **(b) PIN/código curto** — mais rápido de digitar no balcão; o dono define um PIN por funcionário.

Sem essa decisão não dá pra começar o #1.

### 🟠 Prioridade 2 — Tela de Configurações da loja (hoje só tem Funcionários)
A aba **Configurações** (4c) só gerencia funcionários. Falta o resto do que o dono vai querer ajustar sozinho, sem pedir pro dev: **dados da loja** (nome, endereço, horário), **frete**, **cobertura de bairros/municípios**. Hoje isso é hardcoded/via tabela sem UI.

### 🟡 Prioridade 3 — Entregar o login sem ser na mão ("enviar convite")
Hoje o dono copia o token e manda no WhatsApp do funcionário no braço. Um botão "enviar convite" (gera link/PIN e facilita o repasse) tira o atrito. Pequeno; depende de como o #1 ficar.

### ⚪ Decisões paradas (do dono)
- **Bate-papo do funcionário:** ele responde o chat do cliente ou não? Hoje **standby** (o backend do chat ainda é mock).
- **Resumo "magro" pro funcionário:** hoje o funcionário **não vê Resumo nenhum**. Opcional liberar só os cards operacionais (sem dinheiro).

### 🧹 Limpeza
- **Token de teste** no Rio do Ouro (`created_by='teste-etapa4'`) — remover via SQL ou o dono desativa pela tela.
- Pendências antigas: Anderson (fixture de teste), pedido `df730693`, 2 pneus teste.

### 🔵 Roadmap da Rede (bot) — cosmético, não trava uso
C4 (voz do parceiro), C7 (`editar_pedido` precisa função de re-reserva), C8 (suavizar resumo). Ver `docs/PLANO_FUNDACAO_BOT_REDE_2026-06-02.md`.

### 🔒 Segurança (backlog)
`docs/SEGURANCA.md` — 44 tabelas com RLS desabilitado nos dados centrais (partner_* já têm RLS).

---

## Veredito honesto (estado do produto)
- **Régua dono/funcionário + recrutamento: ACABOU e está no ar, sólido** (trava no backend, não é teatro de UI).
- **Produto "redondo" pra entregar a parceiro de verdade: NÃO.** O gargalo é o **login** (P1) — é o que o funcionário toca todo dia e hoje é colar token. Depois dele, Configurações da loja (P2).
- Se o alvo é só o dono validando o conceito: **já dá pra usar como está**, é só limpar os dados de teste.

---

## O time de agentes (como o trabalho é dividido)
Trabalho com um time de subagentes em `.claude/agents/` (vivem na máquina local, não no repo — estão no `.gitignore`).

**Decisores (rodam em Opus — lógica de dados/dinheiro/segurança):**
- `banco` — schema, migrations, integridade, ingestão.
- `bot` — agente conversacional do Chatwoot (busca produto/frete, cria/consulta pedido, roteia bot→parceiro→matriz).
- `parceiro` — painel do parceiro (vendas, estoque, financeiro, chat, entregas). *Fez a Etapa 4.*
- `matriz` — camada que agrega parceiros (cobrança, comissão, funil da Rede, antifraude).
- `seguranca` — caça vazamento entre clientes/parceiros, autorização furada.

**Executores (rodam em Sonnet — trabalho mecânico/estruturado):**
- `executor` — edições pontuais, scripts de checagem, refactors.
- `coletor` — investiga dados, roda checagens, traz evidência.
- `front` — maquiagem de UI (cor/layout), sem mexer em lógica/números.
- `escriba` — documentação estruturada (handoffs, manuais), quando o conteúdo técnico já foi decidido.

**Regras do time:**
- Só delega ao Sonnet o que ele dá conta; zona sensível (dinheiro/estoque/segurança/contrato) fica no Opus.
- Decisões técnicas ficam comigo (Claude/Opus); só vai pro dono o que é negócio/dinheiro/irreversível, em linguagem de leigo.
- Cada resolução é assinada (qual especialista + modelo).

---

— Handoff escrito por **parceiro (Opus 4.8)**
