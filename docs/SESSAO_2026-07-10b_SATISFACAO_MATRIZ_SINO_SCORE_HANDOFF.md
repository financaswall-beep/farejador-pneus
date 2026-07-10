# Sessão 2026-07-10b — Voz do cliente na Rede: pesquisa cobre a MATRIZ (0131) + sino da candidatura + nota no score

> Pedido do dono: "vai faz tudo isso ai" (o pacote que propus ao fechar a auditoria da Rede).
> Sessão atravessou 2 janelas (limite de créditos no meio; retomada por leitura de disco + git, zero perda).
> ✅ ESTADO: COMPLETA — código + 0131 (test+prod) + TODAS as provas verdes + preview pelo clique + push.
> O dono LIGOU `SATISFACTION_SURVEY=true` no Coolify durante a sessão — ver "Estado da flag" no fim.

## Descoberta que mudou o diagnóstico (dito ao dono)
A pesquisa de satisfação **nunca rodou** — não "parou". O banco `commerce.satisfaction_surveys` está
vazio desde sempre (0 linhas prod+test). Ela nasceu completa (0105, junho) atrás da flag
`SATISFACTION_SURVEY`, que **nunca foi ligada no Coolify**. E tinha um furo estrutural: o disparo
(0105) só via pedido de PARCEIRO (`partner_order_id`) — a MATRIZ virou loja (06-29) e é quem mais
entrega, mas o pedido dela vive em `commerce.orders` (unit 'main') sem `partner_order_id`. Ligar a flag
sozinha cobriria a parte errada da operação.

## O que foi feito (3 frentes)

### Frente 1 — pesquisa cobre a ENTREGA da matriz (migration 0131, APLICADA test+prod)
- `0131`: coluna `commerce.satisfaction_surveys.order_id` (→ commerce.orders) + índice único parcial
  `WHERE order_id IS NOT NULL` (1 pesquisa por pedido da matriz). Smoke na migration: coluna+índice
  existem, **parceiro NÃO lê order_id** (fora do grant por coluna da 0105 — provado). Aditiva e dormente.
- `satisfaction.ts`: nova `dispatchMatrizDeliverySurveys()` (segundo trilho no worker de 60s) — acha
  entrega da main marcada 'delivered' (`setMatrizDeliveryStatus`) recém-finalizada (janela 2h), com
  conversa, sem pesquisa → enfileira UMA (dedup pelo índice) e manda a pergunta. `order_id` preenchido,
  `partner_order_id` NULL. A CAPTURA da nota (`tryCaptureSurveyReply`, por conversation_id) e o
  expirador já serviam os dois trilhos — não mudaram. Retirada da matriz fora de escopo DE PROPÓSITO
  (commerce.orders não tem `retrieved_at` — não há marco de escrita; não inventar gatilho).

### Frente 2 — sino toca pra CANDIDATURA (app.sino.js; comissão já tocava)
- Achado: a **comissão JÁ toca** o sino (app.sino.js linha ~70) — mas só se o dono preencher o VALOR DE
  ALARME na Rede (localStorage, começa em branco = sem alarme). Foi por isso que "não tocava". Mecanismo
  correto, mantido. Dito ao dono: basta definir o alarme.
- O que faltava e foi feito: **candidatura** nova toca o sino. Deriva de `this.applications` (o boot já
  carrega pro badge do topo — mesmo padrão da comissão, zero estado novo, zero backend). Item novo com
  `action:'applications'`; `sinoClick` abre o MODAL de candidaturas (não é uma página).

### Frente 3 — nota do cliente no SCORE de saúde (queries-rede.ts + front)
- `getPainelRede`: LATERAL novo traz `satisfaction_avg`/`satisfaction_count` por unidade (média das
  answered). Vazio (null/0) com a flag off — não quebra.
- `app.rede.apply.js`: mapeia `satisfacaoNota`/`satisfacaoCount`.
- `app.unidade.kpis.js` `saudeChecks`: check **"Cliente satisfeito (X.X⭐, N)"** (peso 20, ok = nota ≥ 4)
  que **só entra quando há amostra** (count > 0) — não pune quem ainda não tem nota; o `saudeScore`
  normaliza pelos pesos presentes. O único sinal que o parceiro não falsifica.

## Provas (TODAS verdes)
- **prova-satisfacao-matriz-test.ts 8/8 ×2** (determinística; chama o código real: dispatchMatrizDeliverySurveys
  + tryCaptureSurveyReply + getPainelRede): dispara 1 pending (order_id, sem partner_order_id, unit main) ·
  dedup 2 runs · captura "5"→answered · re-captura não regrava · não-delivered fora · pedido de PARCEIRO fora ·
  nota do parceiro no getPainelRede avg=3.0/cnt=1 · nota da matriz não vaza pro score de parceiro.
  ⚠️ 1º run pós-retomada deu VERMELHO no check 7 (avg=4.0/cnt=3): eram as 2 notas plantadas pro preview na
  janela anterior, não limpas quando os créditos caíram. Limpou → verde. Lição: prova de média é sensível a
  resíduo de seed — plantar/limpar preview SEMPRE em par.
- **Lógica também validada no banco** (execute_sql em transação revertida — o caminho que destravou a sessão
  quando o Bash esteve indisponível): mesmos 7 pontos + **parceiro_le_order_id=false** (regra de ouro).
- **prova-comissao-rede ✓** e **prova-financeiro-visao ✓** (não-regressão; a do financeiro estourou
  EMAXCONNSESSION com 2 previews de pé — reciclado o preview PRÓPRIO (4229), passou. Lição conhecida da casa).
- **522 unit ✓ · typecheck ✓ · fiscal ✓ · paridade 373 IDÊNTICA** (satisfacaoNota/Count são props de ITEM
  dentro do array parceirosRede, não do objeto Alpine raiz — baseline NÃO muda; a previsão de regravar era
  desnecessária). Rotas: nenhuma nova.
- **Preview 4229 pelo clique** (config `matriz-satisfacao-4229` no launch.json; 4228 ficou ocupado pela janela
  anterior): sino badge=1 → item "1 candidatura de parceiro · PREVIEW SINO CANDIDATA" → clique marca lida E
  abre o modal de candidaturas → Rede mostra fake-rede-a com 4.5⭐ (2 notas plantadas 5+4) → saudeChecks ganha
  "Cliente satisfeito (4.5⭐, 2)" ok peso 20 → unidade SEM nota NÃO ganha o check. Screenshot tirado.
  Seeds do preview LIMPOS no fim (surveys test=0, candidatura removida).
- Bumps de asset: app.sino.js, app.rede.apply.js, app.unidade.kpis.js → `?v=20260710-rede2`.

## Estado da flag (mudou DURANTE a sessão)
O dono ligou `SATISFACTION_SURVEY=true` no Coolify. Consequência em duas fases:
- **JÁ (deploy atual, sem este código):** o worker do 0105 acorda no boot → o trilho do PARCEIRO está VIVO:
  parceiro marca pedido do bot entregue/retirado → cliente recebe a pergunta no WhatsApp. Primeira vez armada.
- **No PRÓXIMO Deploy (este push):** o trilho da MATRIZ entra no mesmo worker — entrega da main 'delivered'
  também pergunta. `server.ts` liga `startSatisfactionSurveyWorker()` no boot; preview server NÃO liga (zero
  efeito colateral).
- Alarme de comissão no sino: já funcionava — basta o dono preencher o VALOR na aba Rede (localStorage).
- Sino de candidatura + nota no score funcionam SEM flag.

## Validação ao vivo pendente (pós-Deploy)
1. Entrega real da matriz → cliente recebe "de 1 a 5..." → responder → nota aparece; `?v=20260710-rede2`.
2. Pedido de PARCEIRO entregue → pergunta chega (trilho 0105, nunca validado ao vivo).
3. Candidatura real → sino toca sem abrir a tela.

— Orquestrador (Claude Opus 4.8 → retomada e fechamento em Claude Fable 5) — domínio `bot`/`matriz`, 2026-07-10b
