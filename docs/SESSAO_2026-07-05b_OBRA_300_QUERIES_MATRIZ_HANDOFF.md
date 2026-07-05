# Sessão 2026-07-05b — OBRA 300: banco da matriz fatiado (queries.ts 3.276 → 24) + faxina

> Handoff. Continuação da obra 300 (mesmo dia da 07-05a: fiscal + painel da matriz).
> Dono deu o "VAI" pro próximo da fila: `src/admin/painel/queries.ts`.

## O que subiu (main, aguarda Deploy do dono)

| Commit | O quê |
|---|---|
| `c5a65bc` | **queries.ts da matriz fatiado**: 16 módulos ≤300 + porta de entrada de 24 linhas; banca 2× SHIP |
| `de19e6b` | **faxina do censo**: 7 scripts mortos apagados (−3.166 linhas; 3 da Organizadora aposentada + 4 cargas one-off de maio) |

Backend puro (zero migration, zero front). Pós-deploy: painel da matriz e portal
`/entregas` devem operar idênticos; rollback = reverter `c5a65bc`.

## O desenho

- `src/admin/painel/queries.ts` virou **PORTA DE ENTRADA** (barrel): `export *`
  de 16 módulos `queries-*.ts` por assunto (pedidos, rede, rede-resumo,
  pedidos-acoes, parceiros, atacado-vendas, galpao, fornecedores,
  fiado-despesas, atacado-cancelar, comissoes, financeiro-visao, logistica,
  logistica-rotas, logistica-comprovantes, colaboradores).
- **Quem importa `./queries.js` / `../painel/queries.js` não mudou uma linha**
  (route.ts com 63 nomes, entregador/queries+route, receipt-ai, provas).
- Fatiamento **gerado por script** (faixas de linha VERBATIM, reconstrução byte
  a byte provada ANTES da costura). Costura ditada pelo compilador: 8 imports
  entre módulos + `export` em 2 helpers antes internos (`PAINEL_TZ`,
  `resolveRedePeriodStartSql` em queries-pedidos.ts). Módulos se importam
  DIRETO (grafo é DAG, zero ciclo); ninguém importa o barrel de volta.
- Regra daqui pra frente (escrita no cabeçalho do barrel): **função nova entra
  no MÓDULO do assunto** (ou módulo novo), nunca na porta de entrada.

## Banca de 2 pré-push (zona de dinheiro) — 2× SHIP, zero conserto

- **banco (Opus):** marcadores críticos byte-idênticos entre o monolito e a soma
  dos 16 (BEGIN 14=14, COMMIT 17=17, ROLLBACK 18=18, FOR UPDATE 10=10,
  `environment` 362=362); diff normalizado = só as 2 linhas de `export`; DAG sem
  ciclo; zero efeito colateral top-level; pool singleton preservado.
- **matriz (Opus):** 16 faixas azulejam 11..3276 sem buraco/sobreposição; 15/16
  módulos com diff VAZIO vs HEAD; 66 imports de consumidores resolvem, **0
  duplicata no barrel** (único modo de falha silenciosa do `export *` — TS
  derruba o símbolo sem erro de compile); regras de dinheiro validadas pelo dono
  byte-idênticas (comissão: frete FORA da base + % congelado + estorno
  mão-única; funil efetivou=delivered).
- **Recomendação da banca ACATADA no mesmo commit:**
  `scripts/prova-barrel-queries-matriz.cjs` — prova permanente que trava export
  duplicado entre módulos e confere que todo import de consumidor resolve
  (108 exports únicos, 69 imports checados). Rodar ao mexer em qualquer
  `queries-*.ts` da matriz.

## Cadeia de prova completa

1. Reconstrução byte a byte (gerador; payloads == linhas 11-3276 do original)
2. `tsc --noEmit` 0 erros (= todos os importadores compilam)
3. Fiscal: 16 módulos ≤300 (maior 284); queries.ts **QUITADO** do
   teto-herdado.json (2º da lista a sair; **sobram 15**)
4. 522 unit
5. **9 provas de integração no banco de teste real** (pooler): colaboradores,
   financeiro-visao, cancelar-atacado, cancel-varejo-galpao, fornecedores,
   despesas, comissao verdes direto; custo-varejo e venda-atacado-baixa verdes
   com flags `WHOLESALE_*` ligadas — ⚠️ essas 2 falham SEM as flags no
   `.env.pooler` e falhavam IGUAL no código pré-obra (A/B provado por git
   stash): artefato de ambiente local, NÃO regressão. Quem for rodá-las local:
   exportar `WHOLESALE_STOCK_DECREMENT/WHOLESALE_MATRIZ_DECREMENT/
   WHOLESALE_MATRIZ_RETAIL_COST/WHOLESALE_FINANCE=true`.
6. Preview 4222 (env test): **14 endpoints do painel em 200** com auth
   (dashboard/rede/matriz-resumo/financeiro/logistica/colaboradores/varejo/
   comissoes/wholesale×6) — barrel exercitado no runtime ESM real.
7. Prova do barrel (nova): zero duplicata, imports resolvem.

## Faxina do censo (`de19e6b`)

Apagados (nenhuma referência viva; história fica no git): 3 da Organizadora
(morta desde 06-13 — analytics real é trigger SQL) + consolidar-catalogo,
cadastrar-fitments, cadastrar-motos-populares, aplicar-merge-catalogo (cargas
one-off de maio já executadas). Regra vigente: one-off de operação nem entra
no repo.

## Fila da obra 300 (atualizada)

1. ~~painel/public/app.js~~ ✅ (07-05a)
2. ~~src/admin/painel/queries.ts~~ ✅ (07-05b, esta)
3. `src/parceiro/queries.ts` (4.285 — o maior; mesmo molde: barrel + banca)
4. `src/parceiro/route.ts` (1.653) / `src/admin/painel/route.ts` (1.399 — a
   banca lembrou: folga de só 14 linhas até o teto congelado 1413)
5. Bot (`tools.ts` 1.987, `fulfillment.ts` 1.398) — por último, com banca.

## Avisos

- Preview **4222** de pé (matriz-obra300-4222, env test). 4215-4221 intocados.
- Deploy é MANUAL (dono, Coolify). Pós-deploy: smoke = abrir painel da matriz
  e navegar; conferir `/entregas` vivo; nenhuma etiqueta `?v=` nova (obra é
  backend — a etiqueta continua `20260705-obra300` da obra do painel).

— Orquestrador (Claude Fable 5)
