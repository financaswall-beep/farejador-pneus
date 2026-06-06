# PLANO — Configurações da Loja + Roteamento Multi-Parceiro da Rede

> Data: 2026-06-05. Autoria: síntese do **Claude (Opus 4.8, orquestrador)** sobre a reunião dos especialistas `banco`, `parceiro`, `bot` e `matriz` (todos Opus 4.8). Checkpoint do `seguranca` embutido.
> Decisão do dono (Wallace): ver §6 — há itens que **dependem dele** antes de partes do plano andarem.

---

## 0. TL;DR

Uma tela só — **Configurações da Loja** — vira a **fundação**: ela guarda, por parceiro, os dados da loja (nome, endereço, horário), o **modo de atendimento** (entrega / retirada / os dois), a **área de entrega por bairros**, e a **permissão de telas do funcionário** ("um perfil só"). O **bot** passa a ler essa config pra (1) **responder** o cliente e (2) **rotear** o pedido. O roteamento multi-parceiro (escolher entre vários, com a régua de justiça "quem a Rede acionou menos") é construído e **provado no ambiente `test`** com 4 parceiros fake no Rio, e só liga em produção quando houver concorrência real.

**Duas fases:**
- **Fase 1 (sobe pra prod):** a tela Configurações + permissões + o bot perguntando "entrega ou retirada?" e respondendo horário/endereço. Com 1 parceiro por cidade, **não muda o roteamento atual**.
- **Fase 2 (test → prod sob flag):** o motor de escolha entre vários parceiros (filtros + desempate justo + tenta o 2º antes da matriz + retirada vira caminho do parceiro). Cada peça atrás de uma chave (flag); **chave desligada = comportamento byte-idêntico ao de hoje.**

---

## 1. Princípios inegociáveis (valem pro plano inteiro)

1. **Default seguro = comportamento de hoje.** Todo campo novo nasce reproduzindo o atual. Os 2 parceiros vivos (Anderson/Niterói, Rio do Ouro/Itaboraí) roteiam **idêntico** até o dono editar. Teste de não-regressão obrigatório antes de cada deploy.
2. **Cada flag desligada = hoje.** Nenhuma mudança de roteamento sobe "ligada". Liga-se uma por vez, no `test`, com prova.
3. **A LEI:** cada número tem um dono determinístico. `commerce.orders` = espelho p/ analytics; `commerce.partner_orders` (`source_tag='2w'`) = dono operacional. A régua de escolha é determinística (sem sorteio).
4. **Prova no `test`, não em prod.** Conversa real gera ~50 linhas em `analytics.fact_evidence` que **não apagam** (trigger append-only). O motor se prova chamando as funções direto via script (com rollback), no env `test`.
5. **Dinheiro/estoque/autorização = Opus + revisão `seguranca`.** Nada disso é delegado ao barato.

---

## 2. FASE 1 — Configurações + conversa (vai pra produção)

### 2.1 Schema — migration `0087_partner_store_config_and_delivery_areas.sql` (`banco`)

Aditiva/retrocompatível (só `ADD COLUMN ... IF NOT EXISTS`, troca de UNIQUE, CHECKs — **zero DROP de dado**). Próxima livre confirmada = **0087**.

**`network.partner_units`** ganha:
| coluna | tipo | default | papel |
|---|---|---|---|
| `service_mode` | text NOT NULL | `'both'` | CHECK `IN ('delivery','pickup','both')`. Default `'both'` = atende tudo, igual hoje. |
| `opening_hours_text` | text | `NULL` | **v1 = texto livre** ("Seg–Sex 8h–18h, Sáb 8h–12h"). NULL = bot não fala horário. *(Ver arbitragem A em §7.)* |
| `employee_screens` | — | — | **NÃO usar jsonb aqui.** Permissões viram tabela própria (2.3). *(arbitragem C.)* |
| `address_*` (estruturado) | text | `NULL` | rua/número/bairro/cidade/cep — reusa o shape que `partner_customers` já tem. Prepara a localização futura. |
| `address_confirmed_at` | timestamptz | `NULL` | auditoria leve (dono revisou o endereço). |

**`network.unit_coverage`** ganha:
| coluna | tipo | default | papel |
|---|---|---|---|
| `neighborhood_canonical` | text | `NULL` | NULL = **cobre a cidade inteira** (= hoje). Preenchido = cobre só aquele bairro. Normalizado `lower(unaccent)`. |
| `coverage_kind` | text NOT NULL | `'city'` | CHECK casado: `'city'`⇒neighborhood NULL; `'neighborhood'`⇒neighborhood NOT NULL. |

- Troca do índice único: `UNIQUE (environment, unit_id, municipio)` → `UNIQUE (environment, unit_id, municipio, coalesce(neighborhood_canonical,''))`.
- ⚠️ **Coordenação obrigatória (banco):** `createPartnerUnit` (`src/admin/painel/queries.ts:722`) usa `ON CONFLICT (environment,unit_id,municipio)` — **quebra** com o índice novo. O ajuste do `ON CONFLICT` (chave de 4 colunas) **sobe no mesmo deploy** da 0087, senão cadastro de parceiro novo quebra.
- **Match novo (contrato p/ o bot):** bairro declarado vence cidade-inteira; sem bairro, régua de cidade **idêntica à de hoje** (`$municipio LIKE '%'||uc.municipio||'%'`).

### 2.2 Tela "Configurações da Loja" (`parceiro`)

Abas internas dentro da seção `config` que já existe (não item de menu novo). Tudo **owner-only** (`x-show="isOwner"` já cobre o menu):

- **Aba Dados da loja:** nome de exibição, endereço estruturado, horário (texto). Botão salvar → `PUT .../configuracoes/loja`.
- **Aba Atendimento:** dois checkboxes — `[ ] Faço entrega` / `[ ] Tem retirada na loja` (pelo menos um). O backend mapeia os 2 checkboxes → o enum `service_mode` (`both`/`delivery`/`pickup`). *(arbitragem B.)*
- **Aba Área de entrega:** toggle "Atendo a cidade inteira" vs "Atendo bairros específicos". No 2º, **busca de bairros** (digita "copa" → Copacabana) lendo `commerce.resolve_neighborhood` (já existe, ignora acento) → chips removíveis (~10–20). **Na Fase 1 isto é DECLARATIVO** — grava e exibe; o bot ainda **não** filtra por bairro (só na Fase 2).
- **Aba Equipe:** o card Funcionários de hoje + a sub-seção de **permissões** (2.3).

Endpoints novos (todos `ownerOnly`, escopados por `ctx.partnerUnitId`): `GET /api/configuracoes` (lê tudo), `PUT .../loja`, `PUT .../atendimento`, `PUT .../area`, `GET .../bairros?municipio=&q=` (busca), `PUT .../permissoes`.

### 2.3 Permissões de tela do funcionário — "um perfil só" (`parceiro` + `seguranca`)

**Armazenamento:** tabela 1:1 `network.partner_unit_permissions(partner_unit_id PK, allow_vendas, allow_estoque, allow_pedidos, allow_clientes, allow_entregas, allow_batepapo, allow_resumo, allow_financeiro bool ...)` — **colunas booleanas explícitas, não jsonb** (é lido em todo request de funcionário, é autorização, tem que ser auditável e impossível de vir com chave inesperada). *(arbitragem C.)*

**A trava é no BACKEND, não no menu:**
- Novo guard `requireScreen(tela)` ao lado do `requireOwner` (que **continua existindo**). Pra `owner`, `requireScreen(x)` ≡ passa sempre (dono vê tudo). Pra `funcionario`, lê o perfil da loja; tela desligada → **403 de verdade** (não só some o menu).
- `GET /api/me` passa a devolver o `permissions` **efetivo** (resolvido no servidor) pro front pintar o menu (`canSee(tela)` substitui `isOwner` puro).
- **Telas que o dono pode ligar/desligar:** Vendas, Estoque, Pedidos, Clientes, Entregas, Bate-papo, **Resumo, Financeiro**. (Sim — o dono **pode** liberar dinheiro pro funcionário; é decisão dele. Decisão Wallace já tomada.)
- **Default:** operacional **ON**; **Resumo e Financeiro OFF** (= Etapa 4 de hoje). Perfil não-configurado → aplica esses defaults → funcionário existente não muda de comportamento.
- 🔒 **Configurações é o ÚNICO cadeado duro:** nunca é marcável na UI, o `PUT .../permissoes` **descarta** a chave `config`, e os endpoints de Configurações usam `requireOwner` cru (nunca `requireScreen`). Anti-escalonamento absoluto: funcionário nunca se auto-promove nem edita o próprio perfil.
- Allowlist fixa no servidor de chaves válidas (defesa em profundidade).

### 2.4 Bot — conversa (`bot`)

⚠️ **Achado que reposiciona o escopo:** o **SayValidator NÃO existe** na camada que está em produção (`atendente-v2`). A contenção "só fala o que sai de tabela" é hoje **só regra de prompt** — e o prompt atual **viola isso** em exemplos ("sai pela manhã", "sai pra entrega"). Então:

- **Fase 1 (prompt):**
  1. **Pergunta de modalidade** no closing flow (depois da cotação aceita, antes do frete): *"É pra entregar no teu endereço ou retirar na loja?"*. **Coleta a intenção** (vira a `modalidade` que o `criar_pedido` já aceita) — na Fase 1 **não filtra** (só 1 parceiro). Não pergunta se o cliente já deu endereço (assume entrega).
  2. **Endurecer as CRITICAL RULES:** proibir explicitamente "entrego hoje / sai hoje / chega amanhã / tá aberto agora" (sem fonte de tabela) e **remover** esses exemplos do prompt. Horário/endereço só via `buscar_politica`.
  3. `buscar_politica` continua **escopo matriz** na Fase 1 — correto, porque retirada na Fase 1 ainda cai na matriz.
- **Gate programático (SayValidator de verdade):** é **projeto separado**, não entra aqui. Recomendação do `bot`: manter prompt-only na Fase 1; decidir o gate depois que houver tráfego real e a gente ver onde o prompt vaza. *(Ver decisão Wallace #5.)*

### 2.5 Defaults seguros + deploy da Fase 1

- Após aplicar 0087: rodar a query de `resolveUnitForMunicipio` pra `itaborai`→Rio do Ouro e `niteroi`→Anderson e **confirmar resultado idêntico** (colunas novas NULL/`'city'`). Teste de não-regressão **obrigatório**.
- Ordem: snapshot/shadow (protocolo 0076/0077) → aplica 0087 no `test`, prova → aplica em prod **logo antes** de deployar o backend (com o `ON CONFLICT` ajustado) → não-regressão → deploy → **revisão `seguranca`** (autorização) antes de liberar a aba.

---

## 3. FASE 2 — Motor de roteamento multi-parceiro (test → prod sob flag)

Ponto de plugagem único: `decideStoreForOrder` (`src/atendente-v2/fulfillment.ts:349`). Tudo aditivo e atrás de flags.

### 3.1 De "pega 1" para "lista de candidatos" (`bot` + `matriz`)

- `resolveUnitForMunicipio` (retorna 1) **permanece** como wrapper (`candidatos[0]`) p/ não quebrar callers. Nova `resolveUnitCandidates(...)` retorna **lista ordenada**, consumindo `coverage_kind`/`neighborhood_canonical` (bairro vence cidade) — **sem `LIMIT 1`**.
- `decideStoreForItems` ganha `bairroCanonical?` e `intent?: 'delivery'|'pickup'` (fio novo desde `calcular_frete`/`criar_pedido`).

### 3.2 Filtros duros, em ordem (eliminam antes do desempate)

1. **Cobre a área** (bairro declarado ou cidade).
2. **Modo compatível** com a intenção do cliente (quer entrega → `service_mode IN ('delivery','both')`; quer retirar → `IN ('pickup','both')`). *(flag `ROUTING_MODE_FILTER`)*
3. **Tem o pneu disponível de verdade** — `mapProductToPartnerStock` **inalterado** (`is_tracked AND on_hand−reserved ≥ qty`), por item; candidato só passa se tem **todos** os itens.

### 3.3 Desempate — a régua de justiça (`matriz`)

Contrato `rankCandidatesByFairness(client, env, candidateUnitIds) → unitIds reordenados`, atrás de `ROUTING_FAIRNESS`.
- **Base = LEAD RECEBIDO:** `COUNT(*)` de `partner_orders` `source_tag='2w'`, `status<>'cancelled'`, `created_at >= now() - JANELA`, por `unit_id`. **`created_at`, não `delivered_at`** (o parceiro não controla → anti-trapaça). Cabeça de pedido, **não R$**.
- **Cold-start:** parceiro novo entra semeado na **mediana** dos ativos + **teto** (`%` da janela), pra não afogar o veterano nem ser esquecido. Alavancas `COLD_START_FATOR`/`TETO_FATOR`.
- **Tie-break determinístico:** `credito ASC → last_lead_at ASC NULLS FIRST (anti-seca) → unit_created_at ASC → unit_id`. Puro JS, sem random/`now()` no critério. Reproduzível.

### 3.4 Tenta o 2º antes da matriz (`matriz`) — *decisão Wallace #1*

No loop dos candidatos ordenados: o 1º com estoque vence; se o 1º falha, **cai pro 2º**; só cai na **matriz** quando **nenhum** candidato da área tem estoque. (Hoje o código vai direto pra matriz — é a maior mudança de comportamento.) *(flag `ROUTING_MULTI_CANDIDATE`)*

### 3.5 Retirada vira caminho do parceiro (`bot` + `matriz` + `parceiro`) — *decisão Wallace #4*

- Hoje (guard H4) pickup **sempre** vai pra matriz. Passa a poder virar `partner_order` com `fulfillment_mode='pickup'` num parceiro `pickup`/`both`. O cliente **agenda**, vai à unidade e **coloca o pneu lá**. *(flag `PICKUP_TO_PARTNER`)*
- **Realização do financeiro (decisão Wallace):** o recebível nasce **aberto/pendente** e **só baixa (realiza) quando o parceiro marca "serviço feito / cliente retirou"** na unidade — espelha a entrega (realiza no `delivered`), **NÃO em `created_at`**. Isso exige um **novo status/ação no painel do parceiro** ("cliente retirou / concluir"), análogo ao "marcar entregue". `materializePartnerOrder` **não** pode hardcodar COD de entrega aqui (seria recebível fantasma); retirada = **sem frete** (`freight_amount=0`); comissão 2w **só sobre a mercadoria** (`total_amount`).
- **Confiança hoje, verificação depois:** por ora confia-se no clique do parceiro. A **verificação de que o serviço foi mesmo feito** é fase futura (Wallace vai estudar). ⚠️ O vetor a priorizar lá é **"fez e não registrou"** (parceiro embolsa e foge da comissão), mais perigoso que "mentiu que fez" (que só aumenta a própria comissão).

### 3.6 Gravar o porquê + corrigir o funil (`bot` + `matriz`)

- Toda decisão grava `reason` estruturado (candidatos avaliados, quem filtrou quem, posição no ranking, se tentou o 2º). Vai no log estruturado + no `reason` do espelho. *(sustenta "por que não veio pra mim?" e o antifraude.)*
- 🐞 **Bug do funil (achado da `matriz`):** `getRedeFunnel` (`queries.ts:396`) agrupa por `municipio` com `max(po.unit_id)` → com 2 parceiros na mesma cidade (A+B em Copa) **colapsa os dois numa linha** e atribui errado. **Fix:** agrupar por `(municipio, unit_id)`. Não quebra cobrança (essa já é por `unit_id`), mas é acoplado à régua — sobe junto.

### 3.7 Feature flags (cada uma off = hoje)

`ROUTING_MULTI_CANDIDATE`, `ROUTING_MODE_FILTER`, `ROUTING_NEIGHBORHOOD`, `ROUTING_FAIRNESS`, `PICKUP_TO_PARTNER`. Liga-se **uma por vez** no `test`, prova, e só então em prod.

### 3.8 Os 4 parceiros fake + provas (`banco` + `bot` + `matriz`) — no env `test`

Seed `scripts/seed-fake-rede-test.cjs` (trava em `environment='test'`, idempotente):
| Fake | Bairros | Modo | Estoque do `:PNEU_X` |
|---|---|---|---|
| A | Copacabana, Botafogo | both | tem (10) |
| B | Copacabana, Botafogo | both | tem (10) |
| C | Méier, Tijuca | só entrega | tem |
| D | Campo Grande, Barra | só retirada | **não** |

Pré-requisitos no `test`: 1 produto-pneu (`:PNEU_X`) com **preço central vigente** + os bairros do RJ em `geo_resolutions`. Limpeza `scripts/limpar-fake-rede-test.cjs` (apaga estoque/cobertura/tokens/sessões/parceiros; **não** toca analytics append-only).

Prova `scripts/prova-regua-rede-test.cjs` (chama `decideStoreForItems` direto, `BEGIN…ROLLBACK`, **sem conversa = sem analytics**):
1. **Copa + entrega → A vs B alternam** (rodar N=20; assert `|A−B| ≤ 1`). Flag off → sempre o mesmo (prova a fronteira).
2. **Campo Grande + entrega → matriz** (D é pickup-only e sem estoque → dois filtros).
3. **Méier + retirada → matriz** (C é só-entrega → filtro de modo; sem 2º na área). Méier + entrega → C vence.
4. **A sem estoque → B antes da matriz** (assert `store='partner' && unit=B`). A e B zerados → matriz.
5. **Determinismo:** rodar o caso 1 duas vezes do mesmo estado → mesma sequência.

---

## 4. Antifraude & qualidade (`matriz`)

- Distribuir **lead recebido** (não venda) já mata o incentivo de esconder venda: o lead conta no instante em que o bot roteia, o parceiro não controla. Cancelar não credita (neutro).
- **Piso de qualidade** (tirar da fila o parceiro que entrega mal) = **Fase 2+**, depende de dado que **não temos** (sem `promised_at`/SLA nem motivo de cancelamento). Fica desligado até coletarmos. Ref: `docs/SISTEMA_ANTIFRAUDE_REDE_2026-06-02.md`.

---

## 5. Revisão `seguranca` (gates obrigatórios)

Antes da Fase 1 subir (autorização):
1. `requireScreen` não afrouxa nada que `requireOwner` trava (diff rota-a-rota; p/ owner é equivalente).
2. Anti-escalonamento de `config`: nunca marcável, descartado no input, endpoints de Configurações em `requireOwner` cru.
3. Fail-safe: erro ao ler o perfil → nega dinheiro (menor privilégio), nunca "deixa passar".
4. Isolamento entre parceiros: todo `GET/PUT /configuracoes*` filtra por `ctx.partnerUnitId`.
5. `/api/me.permissions` é derivado no servidor, nunca aceito do cliente.

Antes da Fase 2 subir: revisar mudança de ownership de pedido (retirada→parceiro, roteamento) — não reabrir SEC-001.

---

## 6. DECISÕES DO DONO (Wallace)

| # | Decisão | Recomendação dos especialistas |
|---|---|---|
| 1 | **Tentar o 2º parceiro antes da matriz?** | ✅ **SIM** (Wallace, 2026-06-05). |
| 2 | **Janela do "acionou menos"?** | ✅ **7 DIAS** (Wallace mudou de 14→7: nivelar a galera da região rápido). Janela curta = re-nivela rápido. É parâmetro, fácil de mudar. |
| 3 | **Empurrão do novato?** | ✅ **SUAVE** (Wallace: "roer o osso igual a todo mundo"). Semente na mediana = novato entra no nível da galera e disputa igual (não é enxurrada nem handicap). `FATOR=1.0`. |
| 4 | **Retirada → parceiro (e o recebível)?** | ✅ **Retirada É caminho do parceiro** (Wallace, 2026-06-05): cliente agenda, vai à unidade e coloca o pneu lá. O financeiro **só baixa quando o parceiro marca "serviço feito / cliente retirou"** na unidade — espelha a entrega (que realiza no `delivered`). **Sem recebível fantasma, sem baixa antecipada, NÃO realiza em `created_at`.** Fica em Fase 2 (`PICKUP_TO_PARTNER`). **VERIFICAR que o "feito" é verdade = fase futura** (Wallace vai estudar). ⚠️ O vetor mais perigoso a cobrir lá NÃO é "mentir que fez" (isso aumenta a própria comissão) e sim **"fez e não registrou"** (parceiro embolsa e foge da comissão). |
| 5 | **Gate programático (porteiro/SayValidator) agora ou depois?** | ✅ **SEM porteiro** (Wallace, 2026-06-05): testar ao vivo confiando no GPT-5.5 (modelo forte, tarefa estreita; "nunca errou até agora"). **Plano B trancado:** se vazar em prod → liga código (regras nas frases-bomba) → depois LLM-juiz. **Continua independente do porteiro:** (1) limpar o prompt (tirar exemplos que mandam prometer horário); (2) **detector de fumaça** = **NÃO embute na Fase 1** (Wallace, 2026-06-05: "deixa como observação caso ele erre nos testes"). Fica como fallback documentado: logar (sem bloquear) frases de risco — **reativar se o bot errar nos testes**. |

Decisões 1–3 só travam a **Fase 2**. A Fase 1 anda sem elas. **#4 adiada** simplifica a Fase 2 (retirada continua → matriz). **#5 pendente** (não trava nada; a Fase 1 já conserta o prompt de qualquer forma).

---

## 7. Arbitragens do orquestrador (conflitos entre especialistas, já resolvidos)

- **A — Horário (jsonb do `banco` vs texto do `parceiro`):** **texto** na v1. O bot só *diz* o horário (não calcula "aberto agora"); texto é honesto e simples. Estruturado (jsonb 7×2) entra quando existir "aberto agora".
- **B — Modo (enum do `banco` vs 2 booleans do `parceiro`):** guarda **`service_mode` enum** (a régua SQL usa); a UI mostra **2 checkboxes** e o backend mapeia. Melhor dos dois.
- **C — Permissões (jsonb do `banco` vs colunas booleanas do `parceiro`):** **colunas booleanas** em tabela 1:1. É autorização lida todo request — explícita, auditável, à prova de chave inesperada.

---

## 8. Sequência de execução

**Fase 1 (prod):**
1. `banco`: escrever 0087 (aditiva) + ajustar `ON CONFLICT` do `createPartnerUnit` (mesmo deploy). Tabela `partner_unit_permissions`.
2. `parceiro`: tela Configurações (4 abas) + endpoints + `requireScreen` + `/api/me.permissions`.
3. `bot`: pergunta de modalidade + endurecer CRITICAL RULES (remover claims sem fonte).
4. `seguranca`: revisão de autorização (§5).
5. Aplicar 0087 (test→prova→prod), não-regressão, deploy, validar.

**Fase 2 (test → prod sob flag):**
6. `banco`: seed dos 4 fake + `:PNEU_X` + bairros RJ no `test` + script de limpeza.
7. `bot`+`matriz`: `resolveUnitCandidates` + filtros + `decideStoreForItems` + `rankCandidatesByFairness` + tenta-2º + `reason`, **atrás de flags**.
8. `matriz`: fix do funil (`getRedeFunnel` por `unit_id`).
9. retirada→parceiro + lançamento financeiro de pickup (depende da decisão #4).
10. `scripts/prova-regua-rede-test.cjs`: provar os 5 casos; ligar flags 1 a 1 no `test`.
11. `seguranca`: revisão de ownership/roteamento.
12. Promover a prod (flags) **só quando** houver 2º parceiro real numa área.

---

## 9. Dependências cruzadas (não esquecer)

- 0087 + fix do `ON CONFLICT` = **mesmo deploy** (senão cadastro quebra).
- `ROUTING_NEIGHBORHOOD` depende de o `neighborhood_canonical` do `resolve_neighborhood` ser estável o bastante como chave de match — **confirmar antes de ligar**.
- Fio `bairro`+`intent` tem que descer de `calcular_frete`/`criar_pedido` até `decideStoreForItems` (hoje só desce `municipio`).
- Fix do funil sobe **junto** com `ROUTING_MULTI_CANDIDATE` (senão analytics confunde A com B).
- Retirada→parceiro **não** pode criar COD fantasma (decisão #4 + cuidado no `materializePartnerOrder`).

---

*Plano sintetizado por Claude (Opus 4.8) a partir das fatias de `banco`, `parceiro`, `bot`, `matriz` (Opus 4.8). Os 4 subagentes seguem vivos para a execução.*
