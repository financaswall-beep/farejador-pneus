# Sessão 2026-06-12 — Tela do funcionário: Config (Bloco 1 LIVE) + Comissão/Acesso por pessoa (Bloco 2)

> Handoff da sessão. Origem: Wallace pediu pra analisar a tela de Configurações do
> parceiro e propor melhorias. Virou uma obra em 2 blocos: **Bloco 1 (redesenho da
> tela, LIVE)** e **Bloco 2 (acesso + comissão por pessoa + tela gamificada, a fazer)**.
> Memória privada do orquestrador: `project_equipe_permissao_comissao.md`.

---

## 1. Diagnóstico (confirmado no código)

- **Permissão de funcionário é POR LOJA, um perfil só.** Tabela `network.partner_unit_permissions`
  (1 linha por `partner_unit_id`), resolvida em `resolvePartnerPermissions` (`src/parceiro/auth.ts`).
  O dono É quem decide (cadeado `requireOwner`), mas a decisão cai igual em **todo** funcionário.
  → "Clicar no Castro e ver o que é dele" **não existia** no dado: existe só "o da loja".
- **Card do funcionário não era clicável** (só botões Resetar senha / Desativar).
- **Aba "Área de entrega" virou casca vazia** pós Fase 3 (só o campo Município + um textão).
  Quem manda na entrega é o **raio em km**, que mora na aba Atendimento. Duas abas pra mesma coisa.

---

## 2. ✅ Bloco 1 — FEITO e LIVE EM PROD (commit `9641aa3`)

Mudança **só de UI/front, sem tocar no banco**. No ar e conferido de fora por hash.

### O que mudou
- **4 abas → 3.** "Área de entrega" morta; o campo virou **"Cidade base da loja"** dentro da aba
  **Atendimento**. `saveAtendimento()` agora grava atendimento **+ município** numa tacada
  (mesmo endpoint `configuracoes/area`, contrato de rede inalterado).
- **Aba Equipe = lista CLICÁVEL + painel do funcionário.** `selectFuncionario`/`selectedFuncionario`;
  resumo **"vê X de 9 telas"** na lista (`permCount`) — hoje igual pra todos (perfil único), com
  rótulo honesto avisando que **separa por pessoa no Bloco 2**.
- **Resetar senha INLINE** (`confirmResetSenha` + `resetSenhaValue`, sem `prompt()`).
- **Desativar INLINE** com confirmação de 2 cliques (`doRevoke` + `revokeConfirmId`, sem `confirm()`).

### Arquivos
- `parceiro/public/app.js` — estado novo (`selectedFuncionario`, `resetSenhaValue`, `revokeConfirmId`).
- `parceiro/public/app.config.js` — lógica (255 linhas, dentro do teto de 300).
- `parceiro/public/index.html` — UI (3 abas + drawer do funcionário).
- `scripts/baseline-paridade-painel.json` + `baseline-endpoints-painel.json` — **re-gravados de
  propósito** (mudança de feature troca a interface): diff conferido = só os métodos que troquei.

### Provas
- `npm run prova-painel` **verde**: paridade (471 props) + contratos de rede (69) + tamanho.
- Verificado no preview `parceiro-static` (porta 4599): 3 abas, lista renderiza, drawer do Castro
  (9 telas / 4 marcadas, senha inline, desativar → "Sim/Cancelar"), **zero erro de Alpine** no console.
- **Conferido de fora pós-deploy:** sha256 de `app.js` + `app.config.js` que o prod serve ==
  `main` **byte a byte**. (O `index.html` dá 404 anônimo — fica atrás da rota/login; só os `.js`
  são públicos. Ele vai no mesmo deploy.)

### Lição reconfirmada
- **Deploy é MANUAL** (Wallace apertou Deploy no Coolify; foi rápido).
- **Etiqueta `?v=` é cosmética** (cache-buster/rótulo). A **prova real é o HASH do conteúdo** —
  foi ele que confirmou que o prod roda o código novo, não uma versão velha.

### Falta no Bloco 1
- Só a **olhada visual do dono** no celular (3 abas + funcionário clicável).

---

## 3. 🔜 Bloco 2 — A FAZER (sessão dedicada, zona sensível)

Mexe em **dinheiro + autorização** → passa pelo agente `seguranca` antes de subir.
É **uma obra só**: acesso por pessoa + comissão por pessoa + tela do funcionário.

### Ordem dos tijolos
1. **Keystone — carimbar quem fez a venda.** Hoje TODA venda (balcão e 2W) grava
   `created_by = partner:${ctx.slug}` (a LOJA), descartando o operador. A identidade **existe** na
   sessão (`ctx.tokenId`, com `person_id`/`label`/`role`) mas é jogada fora. Passar a carimbar o
   operador em: balcão = `finance.partner_receivables`; 2W = conclusão de retirada
   (`complete_partner_pickup` + receivable) e entrega. **Não muda comportamento — só anota o autor.**
2. **Migration** — guardar por funcionário: permissões + config de comissão (tipo %/fixo + valor).
3. **Backend** — ler o acesso do funcionário **logado** (não o da loja); somar a comissão por
   operador no mês (sobre o **valor cheio**).
4. **Telas:**
   - **Dono:** card **"Comissão da equipe"** no Financeiro → vira **conta a pagar** (0077).
   - **Funcionário:** tela **"Meu desempenho"** pelo chip do topo (`.pos-user`): foto, vendas no mês,
     comissão no mês, e a **lista "Minhas vendas"** com **canal** (balcão/2W) + **status**
     (confirmada conta / "a confirmar" = 2W aguardando entrega) + comissão por linha + **total que
     bate com o número do topo**. Essa lista é o "comprovante" = o fiscal anti-fraude.
5. **Gamificação** (camada): **meta do mês + barra primeiro** (motor nº1, ele-vs-ele, sem veneno);
   depois streak, níveis/medalha (Bronze→Prata→Ouro), comemoração na venda; **ranking discreto por
   último**; **gráfico = versão 2** (não trava o lançamento).
6. **Revisão de segurança** + deploy.

### Pendências menores (encaixam aqui)
- O chip do topo mostra **"Caixa 01" hardcoded** — nem é o usuário real de quem logou (bug pequeno).
- Não há botão pra **reativar** funcionário desativado.

---

## 4. Decisões do dono

### Fechadas (2026-06-12)
- Comissão = **% OU valor fixo**, escolhido **por funcionário** (os dois).
- Base = **valor cheio** da venda (não o líquido pós-matriz).
- Regra: **quem finaliza a venda leva** ("Castro fez, Castro ganha").
- Vale pra **balcão E 2W**.
- Gamificação: meta primeiro, gráfico v2, premiar **faturamento confirmado** (ancorar nas 2W).

### Ainda em aberto (dinheiro/negócio)
- **A meta:** quantas vendas/mês? E bater dá **bônus em dinheiro** ou só status/medalha?

---

## 5. Princípios / travas (não esquecer)

- **Transparência = o motor anti-fraude.** O funcionário ver a própria comissão é o que dá a ele
  alavanca pra exigir que a venda entre no sistema.
- **Anti-"roubo da matriz" é efeito INDIRETO** (incentivo), não trava — a comissão sai do bolso do
  DONO, então dono desonesto esconde do funcionário também. Não vender como garantia.
- **Nunca premiar um número que o funcionário controla sem o sistema conferir** (mesmo princípio da
  régua da Rede). Senão ele pica venda / lança fantasma. 2W = verificável (vem do robô).
- **Não gamificar a ponto de forçar venda no cliente** — queima a marca da Rede (ativo real do Wallace).
- **Pré-requisito operacional:** só funciona se cada funcionário logar **como ele mesmo**
  (porta-única 0095 permite; adoção é disciplina do dono). Login compartilhado = atribuição vira lixo.
- **Bônus de negócio:** a gamificação deixa o painel grudento pro borracheiro (não larga o Farejador
  → recompra), o que casa com o modelo real (atacado).

---

## 6. Próximo passo sugerido
Começar pelo **keystone** (carimbar quem fez a venda) — é o alicerce, é seguro (só anota, não muda
nada pro cliente) e destrava todo o resto. Aguarda o sinal do dono + a decisão da meta/bônus.

---

## 7. Progresso — 1º tijolo do Bloco 2 CONSTRUÍDO (dormente) — 2026-06-12

O alicerce da comissão (carimbar o operador na venda) está **assentado, dormente e provado** —
**não aplicado em prod, não pushado**. Aguarda o pass do `seguranca` + o dono aplicar a migration e dar Deploy.

**O furo (confirmado no código):** a venda grava `closed_by = partner:<slug>` (a **loja**, em
`commerce.partner_orders`) e descarta **quem** fez. O `ctx.tokenId` (o login = vínculo pessoa↔loja,
com `person_id`/`role`, via porta-única 0095) já está na mão no backend, mas era jogado fora na gravação.

**O que foi feito (menor blast radius possível):**
- **Migration `db/migrations/0099_partner_orders_operator.sql`** — só **ADITIVA**: adiciona a coluna
  `commerce.partner_orders.operator_token_id UUID` (sem FK cross-schema, de propósito — loose coupling
  igual `closed_by` é texto) + índice parcial pra somar comissão por operador. `NULL` = bot/Rede ou
  venda anterior à 0099 (operador = a loja). Reversível por `DROP COLUMN`.
- **Carimbo em `src/parceiro/queries.ts` (`registerPartnerSale`, ~linha 661):** logo após a venda nascer,
  um `UPDATE … SET operator_token_id = ctx.tokenId WHERE operator_token_id IS NULL`, na **MESMA transação**
  da venda (`withPartnerContext` = BEGIN/COMMIT → atômico). Só na criação: re-submit idempotente devolve o
  pedido existente e **não** reescreve o finalizador.
- **A função-contrato `register_partner_local_order` (estoque/reserva) NÃO foi tocada** — fica byte-idêntica.
  O carimbo é no app layer, exatamente como já é feito com `notes`/`received_amount`. Isso mantém intactas
  as provas de contrato existentes (prova-painel) e evita transcrever 70 linhas do coração do estoque.

**Carimbo COMPLETO nos 3 pontos de finalização** ("quem finaliza ganha" coberto ponta a ponta):
1. **Balcão** (`registerPartnerSale`) — cria = finaliza → carimba na criação (`WHERE operator_token_id IS NULL`).
2. **Retirada 2W** (`markPartnerPickupRetrieved`) — pedido do bot nasce sem operador; quem dá baixa na
   retirada é "quem finaliza" → `operator_token_id = COALESCE(operator_token_id, ctx.tokenId)` no UPDATE de "marca retirado".
3. **Entrega 2W** (`updatePartnerDeliveryStatus`) — carimba SÓ na transição pra `delivered`
   (é quem marca ENTREGUE, **não** o entregador/courier, que é só um label).
Todos com `COALESCE`/`IS NULL` (trava o 1º finalizador), na mesma transação, e **sem encostar** nas
funções-contrato de estoque (`complete_partner_pickup` / `deliver_partner_local_order` ficam intactas).

**Provas verdes:** `npm run typecheck` limpo + `npm test` = **402/402** vitest.

**Por que é dormente/seguro:** enquanto o código não roda em prod, a coluna fica `NULL` e **nada muda**
pro cliente, pro estoque ou pro caixa. A ordem do gate é a de sempre: **migration ANTES do push**
(aplicar 0099 → depois Deploy do código).

**Decisão do dono (2026-06-12): subida em LOTE ÚNICO.** A 0099 fica dormente; construo o resto do Bloco 2,
o agente `seguranca` revisa tudo, e aí o dono aplica de uma vez + um Deploy só.

**Backend do Bloco 2 — ✅ COMPLETO E TESTADO (dormente) 2026-06-12 ("faz logo tudo", lote único):**
- **Migration `0100_partner_person_permissions_commission.sql`**: 2 tabelas por `token_id` (vínculo
  pessoa↔loja, ON DELETE CASCADE + trigger env_match): `partner_token_permissions` (9 telas) +
  `partner_token_commission` (kind percent|fixed, value, active). ADITIVA: sem linha = comportamento de hoje.
- **auth.ts**: `resolvePartnerPermissions` agora per-token → per-unit (0087, retrocompat) → defaults; fail-safe intacto.
- **`src/parceiro/commission.ts`** (módulo PURO testável sem db): `lineCommission` — % em centavos inteiros,
  metade-pra-cima = `round(,2)` NUMERIC do Postgres → as 2 telas batem no centavo.
- **queries.ts**: get/upsert permissões e comissão por funcionário; `getPartnerCommissionTeam` (dono);
  `getPartnerMyPerformance` (self, amarrado a `ctx.tokenId`); guard `assertUnitFuncionario` (404 se não for da unidade).
- **route.ts** (5 endpoints): GET `funcionarios/:tokenId/config`, PUT `.../permissoes`, PUT `.../comissao`,
  GET `comissao/equipe` (ownerOnly) · GET `meu-desempenho` (só o próprio).
- **Provas**: typecheck limpo + **407 vitest** (5 novos em `tests/unit/parceiro/commission.test.ts`).

**FALTA — a "cara" (front do painel), próxima leva:**
1. Drawer do funcionário (aba Equipe): toggles de tela POR PESSOA + campo de comissão (% ou fixo).
   Consome GET `config` / PUT `permissoes` / PUT `comissao`. (Hoje o drawer do Bloco 1 só mostra/reseta/desativa.)
2. Card "Comissão da equipe" no Financeiro (consome GET `comissao/equipe`).
3. Tela "Meu desempenho" pelo chip do topo (consome GET `meu-desempenho`) + corrigir o chip "Caixa 01" hardcoded.
4. Gamificação (meta + barra). Decisão do dono 2026-06-12: bônus = **decide depois** → comissão + meta visual agora, gancho do bônus pronto pra ligar.
   Regras do painel: ≤300 linhas/arquivo (app.config.js já em 255 → precisa **módulo novo**), `npm run prova-painel` + re-gravar baselines de endpoint.

### Conciliação com o FINANCEIRO da loja (Wallace reforçou 2026-06-12) — regra de desenho, ancorada no código
A comissão **não é só número de tela**: vira **conta a pagar de verdade**. Reaproveitar o contrato
0077/0078 (NÃO fazer financeiro paralelo):
1. **Comissão = `finance.partner_payables` de DESPESA** (o que o dono deve ao funcionário), por
   **competência** (mês em que as vendas fecharam), com `source_purchase_id IS NULL`. O encanamento de
   competência (0078, view `network.partner_unit_summary`) **já a reconhece** em `expenses_month` → abate
   `result_competencia_month` sozinha; quando o dono **paga** (`settlePartnerPayable`), sai no caixa
   (cash_out). **Sem view nova.**
2. **Linha vermelha (0078):** comissão é despesa de operação, **nunca** se mistura com compra de pneu
   (essa pesa via `cogs_month` quando vende). O contrato já separa.
3. **PEGADINHA que quebra o livro — venda cancelada / entrega que voltou = comissão NÃO pode ser paga.**
   Desenho: comissão **calculada AO VIVO** sobre vendas finalizadas E não-canceladas (SUM sobre
   `partner_orders` com `operator_token_id` carimbado, status pago, `deleted_at IS NULL`, fora
   cancelled/failed) → **se autocorrige** quando cancela. Só **"congela"** numa conta a pagar quando o dono
   **fecha o mês / vai pagar**. Nunca congelar no finalize (senão sobra dívida fantasma). Hoje: cancelar
   retirada = `cancelPartnerSale`; entrega failed = cancela pedido + cancela receivable — a comissão segue
   o MESMO recorte.
4. **Os 3 lugares batem no centavo** (mesma fórmula): "Meu desempenho" (funcionário, só o próprio) =
   "Comissão da equipe" (dono, todos) = conta a pagar gerada = despesa no resultado do mês. Base = **valor
   cheio** da venda. É o fiscal anti-fraude embutido.
