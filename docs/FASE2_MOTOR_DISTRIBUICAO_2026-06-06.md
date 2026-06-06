# Fase 2 — Motor de Distribuição da Rede (spec do PRÓXIMO PASSO)

> Doc auto-contido pra outra LLM/sessão pegar o trabalho do zero.
> **Decisão do Wallace (2026-06-06):** começar pelo MOTOR DE DISTRIBUIÇÃO, **test-first, atrás de flag, em shadow, validado no ambiente `test` antes de ligar em prod.**

---

## 1. Onde estamos
- **Fase 1 (Config Loja) LIVE em prod** — main `ca6b628`, migrations `0087`+`0088`. Coolify faz deploy automático no push pro main (repo `farejador-pneus`).
- **GPS da loja feito** (link do Google Maps por loja; `network.partner_units.maps_url`). O link **herda o roteamento** — quando o motor escolher a loja certa, o link vai junto.
- **Rede hoje:** 2 parceiros em cidades DIFERENTES — Borracharia Rio do Ouro (Itaboraí) e Anderson (Niterói). Roteamento **por cidade** funciona.
- **Próximo passo = o MOTOR DE DISTRIBUIÇÃO**: permite **2+ parceiros na MESMA cidade**, dividindo os leads com justiça. Sem isso, same-city = "a loja mais antiga leva tudo".

## 2. O problema (estado do código HOJE)
`src/atendente-v2/fulfillment.ts`:
- `resolveUnitForMunicipio` (~L108): `WHERE $municipio LIKE '%'||uc.municipio||'%' ... ORDER BY length(uc.municipio) DESC, pu.created_at ASC LIMIT 1` → pega **UMA** loja (a mais antiga que cobre). Loga aviso *"roteamento multi-loja (Fase 2) precisa ser implementado"*.
- `resolveUnitForOrder` (~L49): idem (única unidade ativa, mais antiga).
- `decideStoreForOrder` (~L403): resolve 1 parceiro (cobertura município) + checa estoque (`mapProductToPartnerStock`). **Se o parceiro não tem o produto → matriz DIRETO (NÃO tenta um 2º parceiro).** Filtros de hoje = **cobertura + estoque**. Zero justiça.
- `decideStoreForItems` (~L479): aplica `decideStoreForOrder` por item; exige todos no MESMO unit, senão `null` (→ matriz). Usado em `calcular_frete` e `criar_pedido` (`src/atendente-v2/tools.ts`).
- `getUnitMapsUrl` (novo, GPS): usa a MESMA resolução → o link herda o roteamento.

## 3. O objetivo
Reescrever a decisão de loja em **3 camadas: FILTRO (elegibilidade) → RANKING (justiça) → FLUXO**, considerando **TODOS os parceiros elegíveis** (não `LIMIT 1`) e distribuindo com justiça.

## 4. Critérios (✅ = já existe · 🆕 = novo)

### Camada 1 — FILTRO (quem PODE atender este cliente)
1. Cobre a região do cliente — **município** hoje; bairro é outra peça da Fase 2. ✅ (município)
2. Tem o produto em estoque (qtd disponível ≥ pedido). ✅
3. Oferece a **modalidade** pedida (entrega/retirada — `partner_units.service_mode`). 🆕
4. (Ideia 2) Dentro do **raio/distância** do cliente (`partner_units.latitude/longitude`, hoje NULL). 🆕 — **recomendado DEPOIS**.
5. Está **aberto** (horário) — Fase 1 guardou horário como TEXTO, não calcula "aberto agora". 🆕 — **recomendado NÃO filtrar por ora**.
6. Ativo, não deletado. ✅

### Camada 2 — RANKING (entre os elegíveis, quem ganha) — o CORAÇÃO
7. **Menos LEADS RECEBIDOS** na janela de **7 dias** (conta lead, NÃO venda = anti-trapaça). 🆕 (decisão #2)
8. **Empurrão pro novato**: entra semeado na **MEDIANA** de leads (FATOR=1.0, com TETO) pra competir sem ser esmagado nem dominar. 🆕 (decisão #3)
9. Desempate determinístico (ex.: `created_at` ou hash estável). 🆕

### Camada 3 — FLUXO
10. Tentar o **2º melhor ANTES** de cair na matriz. 🆕 (decisão #1) — hoje vai direto pra matriz.
11. **Retirada → caminho do parceiro** (financeiro baixa só no "cliente retirou"). 🆕 (decisão #4)
12. **Antifraude** da matriz. ✅

## 5. Decisões FECHADAS do Wallace (2026-06-05)
- **#1** tentar 2º antes da matriz = **SIM**.
- **#2** janela = **7 dias**.
- **#3** empurrão suave: **semente na mediana, FATOR=1.0**.
- **#4** retirada = caminho do parceiro; financeiro baixa no "cliente retirou".
- **#5** SEM porteiro/SayValidator; detector de fumaça **NÃO embutido** (só observação, reativar se errar nos testes).

## 6. Decisões EM ABERTO (pendentes do Wallace — TRAVAR antes de codar)
- **🔑 (KEYSTONE) O que conta como "lead recebido" e QUANDO?** — define a contagem da justiça. **AINDA NÃO DECIDIDO.**
  - Recomendação do Claude: lead = quando o bot **ESCOLHE/encaminha** o cliente pra a loja (oportunidade, NÃO venda — anti-trapaça). Momento provável: no **`criar_pedido`** pra aquela loja (sinal limpo de "recebeu a chance"). Alternativa: na **cotação** mostrada (mais cedo, mas pode inflar com cliente que só pesquisa).
- **Modalidade filtra?** (cliente quer retirada → só lojas com `tem_retirada`) — recomendo **SIM**.
- **Distância entra agora?** — recomendo **DEPOIS** (lat/long quase sempre NULL).
- **Horário filtra "aberto agora"?** — recomendo **NÃO** por ora.
- **Teto do empurrão do novato** — quanto? **AINDA NÃO DECIDIDO.**

## 7. Abordagem (test-first, segura — é DINHEIRO/roteamento)
1. **Travar** as decisões em aberto (acima).
2. **Escrever os CASOS DE TESTE primeiro** (cada cenário → quem ganha): 2-3 lojas same-city; novato vs veterano; 1ª sem estoque → 2º parceiro; modalidade incompatível → filtra; ninguém cobre → matriz; empate → desempate.
3. **Implementar atrás de uma FLAG** — desligada = comportamento de hoje (não quebra prod).
4. **Rodar em SHADOW**: o motor DECIDE e LOGA a escolha, mas o roteamento real segue o de hoje → comparar "o que decidiria" vs "o que aconteceu" (calibrar). Mesmo padrão do SayValidator/`ops.supervisor_reviews` shadow.
5. **Validar no `test`** (FAREJADOR_ENV=test) com parceiros fake na MESMA cidade — observar a distribuição ao longo de vários leads.
6. **Ligar a flag em prod** só depois de calibrado.

## 8. Onde mexer (pointers de código)
- `src/atendente-v2/fulfillment.ts` — `resolveUnitForMunicipio` / `decideStoreForOrder` / `decideStoreForItems`. O motor entra aqui: provavelmente uma nova função `rankEligibleUnits(...)` + reescrita do `decideStoreForOrder` pra considerar **TODOS** os elegíveis (não `LIMIT 1`).
- **Dados:** `network.partner_units` (service_mode, latitude/longitude, maps_url), `network.unit_coverage` (municipio, neighborhood_canonical, coverage_kind), `network.partners`.
- **🆕 NOVA TABELA DE LEADS** (migration `0089`): registrar cada lead recebido por unidade — ex.: `network.unit_leads` (environment, unit_id, conversation_id/order_id, created_at). A contagem da janela de 7d lê daqui. O empurrão do novato calcula a mediana sobre essa tabela.
- `src/atendente-v2/tools.ts` — `calcular_frete` e `criar_pedido` chamam `decideStoreForItems`; **o lead é REGISTRADO no ponto que decidirmos** (provável: `criar_pedido`).
- **Testes:** `tests/` (vitest). Casos de roteamento/justiça.

## 9. Guardrails (NÃO quebrar)
- O roteamento atual por cidade tem que CONTINUAR: **Itaboraí→Rio do Ouro, Niterói→Anderson.** O script `scripts/checar-naoregressao-roteamento.cjs` tem que continuar passando — **rodar SEM `--env-file`** (o `.env` tem `FAREJADOR_ENV=test` → senão olha a partição vazia e dá falso "regressão").
- É **contrato da Rede** (dinheiro). Flag + shadow + test-first OBRIGATÓRIOS.
- Anti-trapaça: conta **oportunidade (lead)**, não venda.
- Migration: numeração do repo é a verdade (próxima = `0089`). Runner `scripts/apply-migration-file.cjs` (DRY-RUN por padrão, `--commit` pra persistir). `DATABASE_URL` = Farejador (`aoqtgwzeyznycuakrdhp`).
- Typecheck (`npm run typecheck`) limpo antes de subir.

## 10. FORA do escopo deste passo (outras peças da Fase 2, separadas)
- **Distância / loja mais próxima** (Ideia 2) — precisa lat/long preenchido.
- **Cobertura por bairro** (UI Área de entrega tem 3 bugs documentados; split por bairro).
- **Endereço por loja** — hoje o bot fala um endereço env-wide (`commerce.store_policies.endereco` = o do Rio do Ouro) pra TODOS; furo: cliente de Niterói ouve o endereço do Rio do Ouro. Mover pra `partner_units` por loja.
- **Segurança** — SEC-002 (RLS em `partner_unit_permissions`) + RLS das tabelas centrais — blindar ANTES da Rede crescer.

## 11. Origem do design
- `docs/PLANO_CONFIG_LOJA_E_ROTEAMENTO_REDE_2026-06-05.md` (debate da régua + as 5 decisões).
- Memória: `project-regra-distribuicao-rede`, `project-config-loja-fase1`.
- Handoff da sessão que fechou a Fase 1 + GPS: `docs/SESSAO_2026-06-06_DEPLOY_E_FIXES_HANDOFF.md`.
