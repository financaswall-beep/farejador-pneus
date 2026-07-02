# SESSÃO 2026-07-02d — Retomada, alarme COBRAR validado, card lê o livro, BANCA 4×SHIP e PUSH

> Continuação direta da 07-02c (comissão como lançamento, 0118). A sessão anterior caiu
> no MEIO da obra do alarme COBRAR; esta retomou, validou, consertou um furo que o DONO
> achou testando, passou a obra por uma banca de 4 especialistas e PUSHOU: **`1eae2aa`**.

---

## 1. Retomada (o que a interrupção deixou)

- Os 3 arquivos da obra do alarme (app.js, index.html, queries.ts) estavam **COMPLETOS e
  ÍNTEGROS** no working tree — a interrupção cortou só o FECHO (provas + docs).
  ⚠️ Lição de ferramenta: o Grep do harness às vezes EXIBE `/` como `\` (comentários
  `//` viram `\`, paths `/admin/api` viram `\admin\api`) — parece corrupção mas NÃO é;
  confirmar com Read direto antes de "consertar" (quase consertei código são).
- Re-provas: typecheck ✓ · `prova-comissao-rede-test.ts` 18/18 ✓ · vitest 519/519 ✓.
- `?v=` já estava bumpado (`20260703-comissao2` na retomada; terminou `comissao3`).

## 2. Alarme COBRAR validado (preview 4213)

- O 4212 era de OUTRA sessão de chat e ficou DE PÉ (regra: não derrubar) com backend
  velho (sem `whatsapp_phone` no livro) → config nova `matriz-comissao-4213` no
  launch.json (mesmas flags, código atual).
- Seed da demo agora põe `whatsapp_phone` fake (21999990000) no fake-rede-a.
- Provado: alarme R$50 com R$53 acumulado → linha rosa + badge 🔔 COBRAR piscando +
  botão "Cobrar no WhatsApp" (`wa.me/5521999990000` com msg pronta e DDI automático);
  extrato fechado por padrão; alerta persistido no localStorage.

## 3. Recebi validado PELO DONO + furo que ele achou

- Dono clicou **Recebi** no 4213: POST 200 → livro zerou na tela → banco: 2 lançamentos
  `settled` + `settled_at` + `settled_by='matriz-painel'`; varredura seguinte NÃO
  recriou (UNIQUE segurou). Perfeito.
- 500 esporádicos nos logs = **DNS da rede local** falhando pro pooler Supabase
  (`ENOTFOUND aws-1-us-west-2.pooler...`) — transitório, recupera sozinho, irrelevante
  em prod (Coolify).
- **FURO (achado do dono):** o card antigo "A receber da rede" (conta de padaria
  % × vendas 2W do período, Increment 1) NÃO descontava o Recebi — livro dizia R$0 e o
  card dizia R$53 na mesma página. **CONSERTO:** com a flag on, os 3 lugares (card do
  RESUMO + bloco da REDE + drill-down "Cobrança à matriz") leem o LIVRO (aberto; frete
  fora; sem recorte de período; rótulo "Comissão (em aberto)"); flag off = antigo
  intocado. Getters `livroComissaoOn`/`redeComissaoAReceber`/`redeAReceberTotal`/
  `parceiroComissaoAReceber`/`parceiroAReceberTotal`; `loadComissoes()` no init.
  Provado nas 2 direções (livro quitado → 0; dívida injetada → aparece na hora).
  Mensalidade segue estimativa do mês (vira lançamento na próxima fatia).

## 4. BANCA de 4 especialistas (pedido do dono) — **4×SHIP, zero bloqueio**

| Especialista | Veredito | Prova-chave |
|---|---|---|
| banco | SHIP | Varredura real com ROLLBACK: sem 42P08, idempotente, sem cruzar env |
| segurança | SHIP | Grant ZERO pro parceiro PROVADO no banco; endpoints trancados; env pinado no servidor |
| parceiro | SHIP | Régua "realizada" **byte-idêntica** ao getPainelRede; `freight_amount` NOT NULL DEFAULT 0 → base exata |
| matriz | SHIP | Ponta a ponta ok; sem dívida retroativa; loja soft-deleted devendo CONTINUA cobrável (certo) |

**Follow-ups da banca (nenhum bloqueante; ver avisos 5-6 do handoff 07-02c):**
1. **0119 aditiva** (fila): índice parcial `partner_orders (environment, source_tag)
   WHERE source_tag='2w' AND deleted_at IS NULL` (sweep faz Seq Scan a cada GET da Rede)
   + trava física de grant no livro (DO block espelho da 0110).
2. **Estorno é mão única** (documentado): cancelou→refez não ressuscita; acerto manual.
3. **Mensalidade como lançamento ANTES de ativar monthly/hybrid pra alguém real** (hoje
   ninguém usa) — e o desenho é por COMPETÊNCIA (mês), NÃO pendurar no sweep de vendas.
4. `settled_by` fixo `'matriz-painel'` (ok operador único; usar operatorLabel quando
   entrar funcionário na matriz); editor de termos não-transacional (cosmético).
5. **Colateral PRÉ-EXISTENTE do PARCEIRO** (não desta obra): comissão de FUNCIONÁRIO
   (src/parceiro/queries.ts ~3492/3558 + view 0077) usa régua pré-0090 — retirada só
   RESERVADA já conta como venda finalizada na tela de equipe. Chip de tarefa criado
   (sessão própria; alinhar as 4 cópias da régua numa fonte única).
6. No banco de TESTE há 46 parceiros seed `commission` com percent=0 → invisíveis no
   livro (correto, mas silencioso). Ao ligar em prod: conferir o % das lojas REAIS.

## 5. PUSH e estado

- **Commit `1eae2aa`** (9 arquivos: CLAUDE.md, app.js, index.html, queries.ts, route.ts,
  env.ts, 0118, prova, handoff 07-02c). Push conferido: `91a3694..1eae2aa main`.
  Fora do commit por regra: `.cjs` de operação, launch.json (gitignored).
- **Falta (do dono):** Deploy no Coolify (carrega 0116+0117+0118 juntos) → eu confiro
  de fora (`?v=20260703-comissao3`) → ligar `WHOLESALE_MATRIZ_RETAIL_COST` +
  `NETWORK_COMMISSION_LEDGER` → validação ao vivo (venda fiada→Recebi · cancelar ·
  venda balcão→Custo/Lucro · Rede→comissões · editar %→rótulo muda).
- Preview **4213 DE PÉ** (demo quitada no banco test; limpar:
  `node scripts/seed-demo-comissao.cjs --limpar`). 4212 (outra sessão) também de pé.
- Herdadas: raios REAIS · matar zz-teste · rotacionar chave Google · validar frete-pino
  (roteiro #696) · faxina de chaves.

## 6. Próxima obra (ordem da banca)

**Mensalidade como lançamento** (fecha o único achado MÉDIO) → **0119** → **consolidado
das 3 pernas** (desbloqueado) → Camada 2 (inclui quitação PARCIAL — "R$200 por conta").

— Orquestrador (Claude Fable 5) — domínios `matriz` + `banco` + `seguranca` + `parceiro`, 2026-07-02
