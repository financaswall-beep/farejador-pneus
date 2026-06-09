# Handoff — Proximidade-primeiro Fase 2 (raio de entrega: painel do parceiro + matriz)

> Data: 2026-06-09 (continuação). Orquestrador Opus 4.8 + dono (Wallace).
> Repo: github.com/financaswall-beep/farejador-pneus · **Coolify deploya automático no push pro `main`** (~2-3 min; o dono NÃO aperta botão).
> Supabase: projeto **Farejador** (`aoqtgwzeyznycuakrdhp`), env `prod` e `test` (BANCO ÚNICO, coluna `environment`).
> **main HEAD = `b4cec2b`** (tudo abaixo já no ar).

---

## 0. TL;DR — onde paramos
Construímos e subimos a **Fase 2 da Proximidade-primeiro**: a **coleta do raio de entrega** (km que cada loja topa entregar) em **dois lugares** que gravam o MESMO campo — o **painel do parceiro** (o borracheiro preenche) e a **matriz** (o Wallace preenche/acelera). Tudo provado e LIVE. Falta o dono preencher o raio dos 7 parceiros e, depois, a **Fase 3** (a entrega passar a ROTEAR por esse raio — hoje o raio só é coletado, ainda não é usado no roteamento).

---

## 1. Contexto herdado (já estava live antes desta sessão)
- **Fase 0 + Fase 1** da proximidade-primeiro (derrubar o "muro da cidade" na RETIRADA) já estavam commitadas e em prod (commits `eddcf40`/`2fe5482`).
- **A flag `ROUTING_PROXIMITY_FIRST` tem default OFF no código, MAS o dono já a ligou `=true` no Coolify** → a **retirada por proximidade está LIVE** (não dormente). Rollback = trocar a var pra false no Coolify.
- Migration `0093` (`network.partner_units.delivery_radius_km` NUMERIC(6,2), nasce NULL) já aplicada.
- **A MATRIZ não tem endereço/coordenada** (`core.units` slug=`main`: address NULL, sem lat/long) — é backstop lógico, NÃO entra no cálculo de distância. Correto por design.

## 2. O que esta sessão construiu e subiu

### 2.1 Fase 2 — PAINEL do parceiro (commit `1c8fe67`)
Campo **"Até quantos km você entrega?"** na aba **Atendimento** (Configurações), colado no checkbox "Faço entrega" (que já existia = `service_mode`). Grava `delivery_radius_km`.
- `src/parceiro/queries.ts`: `getPartnerConfiguracoes` lê `delivery_radius_km` (NUMERIC volta string → `Number()`); `updatePartnerAtendimento(ctx, serviceMode, deliveryRadiusKm)` grava raio + modo numa tacada.
- `src/parceiro/route.ts`: `configAtendimentoSchema` ganhou `delivery_radius_km` (z.number().positive().max(9999.99).nullable().optional()); o handler **zera o raio (NULL) quando `!faz_entrega`** (raio só existe quando entrega).
- `parceiro/public/app.js` + `index.html`: campo (x-show=faz_entrega) + nota + aviso amarelo quando faz entrega e raio vazio. `saveAtendimento` valida >0 e ≤9999,99.
- Provas: typecheck, 330 unit, **prova-geo-rede 9/9** (motor intacto), **`scripts/prova-raio-entrega-test.ts` 6/6** (round-trip real no banco test: grava/sobrescreve/pickup→NULL/decimal). Teste de integração em `tests/integration/partner-portal.integration.test.ts` (roda no CI).

### 2.2 Fase 2 — MATRIZ (commit `5581a37`, lugar corrigido em `b4cec2b`)
Editor **"Raio de entrega (Rede)"** no detalhe do parceiro: mostra se faz entrega + o raio atual; o Wallace define/limpa o km (destrava preencher os 7).
- `src/admin/painel/queries.ts`: `getPainelRede` agora lê `service_mode` + `delivery_radius_km` (LEFT JOIN `network.partner_units pu`); novo `setPartnerUnitDeliveryRadius(env, partnerUnitId, km)` com **TRAVA DE AUTONOMIA** — só preenche o raio de quem JÁ faz entrega (service_mode delivery/both); parceiro só-retirada → `reason='pickup_only'` (não força entrega em quem optou por não entregar). Limpar (null) sempre ok.
- `src/admin/painel/route.ts`: `PUT /admin/api/partners/:partnerUnitId/delivery-radius` (requireAdminAuth); pickup_only → 409.
- `painel/public/app.js`: `applyRede` mapeia `fazEntrega`/`deliveryRadiusKm`; novos `apiPut` + `salvarRaioEntrega`; estado `savingRaio`/`raioSalvoMsg`.
- `painel/public/index.html`: editor no topo da página **`currentPage === 'unidade'`** (a página que abre ao clicar num parceiro via `openParceiroDetalhe`).
- Provas: typecheck, 330 unit, **`scripts/prova-raio-matriz-test.ts` 6/6** (set em both → getPainelRede mostra; limpar → NULL; pickup → recusa). `applyRede` exercitado no browser real.

### 2.3 BUG corrigido nesta sessão (commit `b4cec2b`)
O editor da matriz foi posto na página `'rede'` (cartão da lista), mas `openParceiroDetalhe` muda pra `currentPage='unidade'` → o dono NÃO achava. **Movido pro topo da página `'unidade'`**, abaixo do nome. Dono confirmou ao vivo ("agora foi").
- **LIÇÃO:** o smoke estático de `painel/public` (http-server na raiz) NÃO monta o componente — o HTML chama `/admin/painel/app.js` (path absoluto) → 404 → `painelApp` indefinido. Então o smoke estático só valida **data-mapping** (injetando o app.js via `<script>`), **não pega bug de PLACEMENT/x-show de página**. Pra validar placement: checar no source HTML em qual bloco `currentPage === 'X'` o elemento cai (ou subir o servidor real de preview).

## 3. Decisões e esclarecimentos travados nesta sessão
- **Coletar dos 7 = "os dois"** (decisão do dono): matriz (Wallace preenche) + painel (parceiro preenche). Mesmo campo no banco → **fonte única**, last-write-wins, **palavra final é do parceiro** (a matriz só acelera). Não é tempo real (atualiza ao recarregar).
- **Aba "Área de entrega" (bairros/cidade) fica REDUNDANTE com o raio** — o dono notou e tem razão. Hoje NÃO conflita (confirmado: o motor não lê `delivery_radius_km`; a ENTREGA ainda usa `passesDeliveryCoverage`/cobertura de bairro D6 em `geo-routing.ts`; só a RETIRADA virou proximidade). **DECISÃO: simplificar a aba "Área de entrega" JUNTO da Fase 3** (encolher pra só município/plano B, tirar a parte de bairros que o raio aposenta) — NÃO mexer antes, pra não reformar a tela 2x.
- **Distância ≠ raio:** a DISTÂNCIA cliente↔parceiro o sistema CALCULA da coordenada (automático); o RAIO é DECLARADO pelo parceiro (vontade, não geografia). Na Fase 3 o motor junta: "distância calculada ≤ raio declarado?". (Possível melhoria futura: raio sugerido padrão — hoje a regra é declaração explícita.)
- **Código vs dado:** o código do raio é 1 só (serve 7/30/300 lojas); o que muda por parceiro é o NÚMERO (1 por loja). Escala sem "muro de complexidade".

## 4. Estado do prod AGORA
- **main = `b4cec2b`**; branch `feat/proximidade-primeiro` sincronizada. Migrations até **0093**.
- Flags no Coolify: ROUTING_GEO, PICKUP_TO_PARTNER, ROUTING_GEO_ROAD_DISTANCE, **ROUTING_PROXIMITY_FIRST = true** (retirada por proximidade LIVE). GOOGLE_MAPS_API_KEY preenchida.
- Logins de parceiro existentes (prod, sem expor senha — hash scrypt irreversível): `wallace`(owner) em zz-teste-copacabana/madureira/meier + borracharia-rio-do-ouro; `dono`(owner) em zz-teste-madureira; `caio`(funcionario, ativo) em rio-do-ouro. **Senha do `wallace`@zz-teste-copacabana foi resetada nesta sessão** pro dono testar o painel (senha temp dada no chat → **trocar**).

## 5. Pendências (pra você / próxima IA)
1. **Dono:** preencher o raio dos **7 parceiros** na matriz (Rede → clica no parceiro → quadro "Raio de entrega (Rede)" → km → "Salvar raio") e confirmar que persiste no F5.
2. **Dono:** trocar a senha temp do `zz-teste-copacabana`.
3. **Fase 2 (menor):** "aviso no login" forte (hoje é inline na aba); cadastro "Novo parceiro" coletar o raio.
4. **Fase 3 (GRANDE):** a ENTREGA passar a rotear por proximidade — loja entra na entrega só se `delivery_radius_km IS NOT NULL` E distância ≤ o raio dela; quem não preencheu = fora da entrega; matriz = backstop. **+ simplificar a aba "Área de entrega" junto** (§3). Atrás da mesma flag.
5. Pendências antigas: preencher horário das 6 lojas; limpar dado de teste (PED-0034 etc.).

## 6. Mapa de código (Fase 2)
- **Painel parceiro:** `src/parceiro/queries.ts` (getPartnerConfiguracoes, updatePartnerAtendimento) · `src/parceiro/route.ts` (configAtendimentoSchema, PUT .../configuracoes/atendimento) · `parceiro/public/app.js` + `index.html` (aba Atendimento).
- **Matriz:** `src/admin/painel/queries.ts` (getPainelRede JOIN, setPartnerUnitDeliveryRadius) · `src/admin/painel/route.ts` (PUT /admin/api/partners/:id/delivery-radius) · `painel/public/app.js` + `index.html` (página 'unidade').
- **Provas:** `scripts/prova-raio-entrega-test.ts`, `scripts/prova-raio-matriz-test.ts` (env test, criam+limpam parceiro isolado). Motor: `scripts/prova-geo-rede-test.ts`.
- **Coluna:** `network.partner_units.delivery_radius_km` (migration 0093). Login/senha: `network.partner_access_tokens.login_password_hash` (scrypt, migration 0086); hash em `src/parceiro/password.ts`.

— Sessão 2026-06-09c, orquestrador (Claude Opus 4.8) + dono (Wallace).
