# Sessão 2026-06-14 — Handoff: Inteligência / Analytics (+ frentes do dia)

> O que discutimos, o que estamos fazendo, onde paramos e pra onde vamos.
> Foco principal: construir a **inteligência por trás** (o analytics) que vai alimentar a **matriz** (frente futura).

---

## 0. Frentes CONCLUÍDAS hoje (todas no `main`, deployadas salvo nota)
| frente | commit | estado |
|---|---|---|
| Campainha do Uber no alerta de foto | (sessões an+) | ✅ live + validada na Méier |
| Tiles premium da aba Equipe (só visual) | `fbae5ad` `0934c22` | ✅ deployado + conferido byte a byte |
| **Fix do bot — Maps na retirada (Opção 1)** | `2dbba41` | ✅ deployado · ⏳ **falta validar ao vivo no WhatsApp** |
| Limpeza Organizadora FASE 1 (código morto) | `4746fc7` | ✅ deployado (servidor no ar pós-deploy) |
| Limpeza Organizadora FASE 2 (tabelas mortas) | `fb6952d` (migration 0101) | ✅ aplicado em prod (DROP customer_journey + agent_incidents) |
| Baseline das funções de analytics | `7bf07e1` (migration 0102) | ✅ versionado (cópia fiel do banco) |

### Fix do bot — o que mudou (pra validar ao vivo)
Retirada: o bot **não dá mais endereço/link do Maps antes de fechar** (trava por CÓDIGO no `localizacao_loja`); o endereço+mapa vão **no resumo do pedido**; item sem preço redundante (1 item sem frete → só o Total). **Teste:** pedir retirada → bot fala "a loja X, ~Y km" sem endereço; se forçar "me passa o endereço", ele segura; ao fechar, o resumo traz 📍 Retirada + 🗺️ Endereço + link.

---

## 1. COMO O ANALYTICS FUNCIONA (entendido a fundo nesta sessão)

**É TRIGGER no banco** (o dono estava certo; eu tinha errado dizendo que não era):
- Trigger `analytics_extract_facts` na tabela `agent.turns` (cada rodada do bot).
- Dispara `analytics.extract_facts_from_turn()` → carimba **30+ fatos + classificações + hints**, automático, em tempo real, a cada turno.
- Tudo em **funções SQL no banco** (não no código TS). **NÃO depende de processo externo/Coolify.**
- Origem: commit `fb00971` ("camada analytics real-time, zero LLM").

**Duas camadas:**
1. **Crua** (sempre, de toda conversa): texto de cada mensagem, horários (quando chamou/atendeu), contato, canal (WhatsApp/Insta/FB), status — em `core.*`.
2. **Analytics** (o trigger): `analytics.conversation_facts` (source `tool_result_v2`), `conversation_classifications` (`sql_rule_v1`), `linguistic_hints`, `fact_evidence`.

⚠️ **Achado:** existe um **2º sistema de analytics no código** (`src/enrichment/`, o `npm run enrich`, source `deterministic_rules_v1`) que **NÃO é o que roda em prod** — resíduo de um plano de migração. Candidato a limpeza futura.

---

## 2. O que o analytics COLETA hoje

**Fatos:** medida_consultada, medida_pneu, posicao_pneu, produto_cotado, preco_cotado, pneu_oem · moto_marca/modelo_consultado/modelo_resolvido/cilindrada/encontrada · bairro_consultado, bairro_canonico, municipio_entrega, endereco_entrega · modalidade_entrega, valor_frete, taxa_frete_cotada, prazo_entrega_dias · forma_pagamento, pedido_criado/numero/subtotal/total · nome_cliente · escalou, motivo_escalacao.

**Etiquetas:** buyer_intent (comprou/dúvida) · final_outcome (fechou/abandonou/escalou) · stage_reached · customer_type (novo/recorrente) · urgency · loss_reason.

## 3. O que NÃO coleta (os buracos = o que vamos implementar)
- 🥇 **faltou_estoque / demanda reprimida** — o que pediram que não tinha (lista de compras do atacado).
- 🏪 **qual_loja_atendeu** — hoje só dá via pedido.
- 📏 distância cliente→loja · 📷 pediu_foto · 🔧 pediu_instalação · 📲 canal (vira fato).
- ⏱️ tempo de resposta / duração / nº de mensagens (cálculo).
- 🧠 (precisa de IA) objeção, motivo real do abandono, clima/satisfação, negociou desconto.

---

## 4. MODELO DE NEGÓCIO (contexto que orienta tudo)
- O dono ganha em **2 pontas**: (1) **comissão** por pneu vendido na Rede + (2) **atacado** — vende os pneus pros próprios borracheiros.
- O Farejador é o **pump**: faz o borracheiro vender mais (↑comissão) e recomprar dele (↑atacado).
- **A MATRIZ (que agrega isso) é frente FUTURA — ainda vai ser feita. NÃO mexer nela agora.**
- O analytics é a **matéria-prima** que vai alimentar a matriz depois. Por isso: **primeiro a inteligência, a matriz depois.**

---

## 5. PLANO de construir a inteligência (tudo automático)
**Mecanismo:** adicionar um dado = adicionar **um carimbo** (`_insert_fact`) na função `extract_facts_from_turn`, no bloco da ferramenta certa. Sai automático no mesmo trigger. FAIL-SAFE (erro na extração não derruba o bot).

**Ondas (por dificuldade):**
- 🟢 **Nível 1 (determinístico, fácil):** faltou_estoque, qual_loja_atendeu, distância, pediu_foto/instalação, canal.
- 🟡 **Nível 2 (cálculo):** tempo de resposta/duração/nº mensagens, é_recompra/dias_desde_última.
- 🔴 **Nível 3 (precisa de IA):** objeção, motivo do abandono, clima/satisfação, desconto.

**Pesquisa de satisfação (decisão do dono):**
- Formato: **ESTRELAS** ⭐.
- **Construir PRONTA mas DORMENTE** (flag off; só liga quando o dono mandar).
- **Gatilho:** o parceiro confirma a operação no painel → **"pneu trocado/retirado"** (retirada) ou **"pneu entregue"** (entrega) → dispara a pesquisa pro **WhatsApp** do cliente.
- A nota nasce do **pedido** (que já sabe a loja) → **não depende** do `qual_loja_atendeu`.
- 3 peças: disparar a pergunta (fácil, reusa padrão da foto) · capturar a nota (fila leve, igual a da foto) · guardar + ranquear por loja.
- ⚠️ Ranking **discreto/interno** (anti-fofoca em rede pequena; loja pode pressionar por nota).
- Sai do Nível 3 (IA) → vira **determinístico** (perguntar > adivinhar).

---

## 6. ONDE PARAMOS
- **Passo 1 ✅ FEITO:** versionar as funções do gerador de analytics (baseline `0102`, commit `7bf07e1`). O cérebro do analytics saiu do "só no banco" pro repositório, com backup/histórico. NADA mudou em prod (só versionado).
- **Passo 2 ⏳ PENDENTE:** adicionar os campos novos na `extract_facts_from_turn`.

## 7. PRA ONDE VAMOS (ordem)
1. **Passo 2 — começar por:** `qual_loja_atendeu` (fácil: o `criar_pedido` já devolve a loja no campo `retirada`, fix de hoje) + `faltou_estoque` (olhar o RESULT do `buscar_produto`). 1 por vez → migration (CREATE OR REPLACE da função) + aplicar em prod com cuidado + **provar** numa conversa (fato novo sai + antigos intactos).
2. Demais do Nível 1 (distância, pediu_foto, canal).
3. Nível 2 (tempos, recompra).
4. **Pesquisa de satisfação** (estrelas, dormente).
5. Nível 3 (IA) — por último.
6. **(Futuro) A MATRIZ** — consome toda essa inteligência.

**Pendências paralelas:** validar o fix do bot ao vivo (§0) · limpeza futura do `src/enrichment` órfão · Coolify (onde roda o `enrich` TS — não bloqueia, era do 2º sistema).

---

## 8. Arquivos/refs
- Funções do gerador: `db/migrations/0102_analytics_functions_baseline.sql` (a `extract_facts_from_turn` é onde se adicionam campos).
- Mapa da limpeza Organizadora: `docs/MAPA_LIMPEZA_ORGANIZADORA_2026-06-14.md`.
- Memória viva: `~/.claude/.../memory/project_analytics_organizadora.md` + `project_bot_maps_retirada.md`.
- Scripts de operação (untracked, fora do git): `gerar-baseline-analytics.cjs`, `auditar-gerador-facts.cjs`, `campos-analytics.cjs`, `amostra-2-camadas.cjs`.

— Orquestrador (Claude Opus 4.8), 2026-06-14
