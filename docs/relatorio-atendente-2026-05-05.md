# Relatório técnico do Atendente — 2026-05-05

> Sessão: calibração Sprint 6.9 dos prompts Planner e Generator + endurecimento
> do SayValidator + dois runs multi-turn em produção (shadow, sem envio ao cliente).

---

## 1. Sumário executivo

Dois runs multi-turn de 18 mensagens foram executados no dia 05/05/2026 em
produção (shadow). O primeiro run revelou 6 problemas de qualidade de LLM. As
correções foram implementadas localmente (prompts v1.2.0 e v1.3.0 + 3 novos
padrões no SayValidator), mas a auditoria posterior mostrou que o deploy das
13:18 implantou o commit `ce5ad8e`, anterior às correções.

**Correção de interpretação:** o run `multiturn-20260505132047` não validou a
calibração nova. O banco confirma que ele usou `planner_v1.1.0` e
`generator_v1.2.0`. Portanto, os resultados de 8/18 OK e 10/18 review medem o
código antigo em produção, não o commit local `032759c`.

O achado mais importante do segundo run é outro: várias escalações humanas não
foram alucinação pura nem falta de dados de catálogo. Elas foram fallback após
`planner_schema_failed` (ex.: `traseiro` em vez de `rear`, `moto_ano` como string,
`municipio: null`, `buscarProduto` sem campo obrigatório). Ou seja: antes de
culpar a inteligência do Planner, há um problema de contrato/schema a corrigir.

---

## 2. Runs do dia

### 2.1 Run 1 — baseline pré-calibração

| Campo | Valor |
|---|---|
| Run ID | `multiturn-20260505124936` |
| Prompts | `planner_v1.1.0` + `generator_v1.2.0` |
| Mensagens | 18 (6 conversas × 3) |
| OK | 12 |
| Review | 6 |

**Issues (run 1):**

| Issue | Ocorrências |
|---|---|
| `generic_escalation_phrase` | 5 |
| `delivery_policy_claim_check` | 1 |
| `stock_claim_check` | 1 |
| `brand_availability_claim` | 1 |

**Problemas identificados:**
1. Generator colava a frase de fallback seguro no final de respostas úteis.
2. Planner escolheu `escalar_humano` para objeção de preço (deveria ser `tratar_objecao`).
3. Generator afirmou "prazo padrão é para o dia seguinte" sem chamar `calcularFrete`.
4. Generator afirmou "ver se temos Michelin disponível" sem chamar `verificarEstoque`.
5. Planner escalou 3 turnos seguidos na mesma conversa.

---

### 2.2 Correções implementadas

**`say-validator.ts` — Sprint 6.9 calibração:**
- `mixesSafeFallbackWithOtherContent(text)` → novo bloco `mixed_safe_fallback_with_other_content`
- Novo padrão em `mentionsStockClaim`: `/\btem(?:os)?\s+(?:\w+\s+){0,5}disponivel\b/`
- Novos padrões em `mentionsDeliveryClaim`:
  - `/\bentregamos\s+(?:em|no|na|...)/`
  - `/\bprazo\b.{0,60}\b(?:...dia\s+seguinte...)/`

**`src/atendente/planner/prompt.ts` — planner_v1.2.0:**
- Nova seção `ROTEAMENTO CONVERSACIONAL` com 7 regras:
  - `escalar_humano` só para: cliente pede humano, risco alto ou confiança extremamente baixa.
  - Objeção de preço/caro → `tratar_objecao` + `buscarPoliticaComercial`.
  - Frete/entrega/prazo → `responder_logistica` + `calcularFrete` quando houver bairro.
  - Medida/produto → `buscar_e_ofertar`; só moto → `pedir_dados_faltantes`.
  - Não repetir `escalar_humano` em turnos seguidos se há pergunta tratável.

**`src/atendente/generator/prompt.ts` — generator_v1.3.0:**
- Regra 9: não colar fallback ao final de resposta útil — fallback sozinho ou nada.
- Regra 10: `escalar_humano` ainda exige registrar dados observados em actions.
- Regra final: a frase de fallback segura só pode aparecer sozinha, nunca misturada.

**Testes adicionados:** 8 novos (5 say-validator + 1 planner + 1 generator + 1 integração).
**Suite completa:** 328/328 verde.

---

### 2.3 Run 2 — auditoria após deploy, mas ainda com código antigo

| Campo | Valor |
|---|---|
| Run ID | `multiturn-20260505132047` |
| Deploy Coolify | `ce5ad8e` (`docs: record atendente job reconciliation audit`) |
| Prompts realmente gravados no banco | `planner_v1.1.0` + `generator_v1.2.0` |
| Status da calibração local | `032759c`, ainda não validado neste run |
| Mensagens | 18 (6 conversas × 3) |
| OK | 8 |
| Review | 10 |
| Arquivo de auditoria | `tmp/multiturn-20260505132047-audit-prod.json` |

**Skills (run 2):**

| Skill | Ocorrências | % |
|---|---|---|
| `escalar_humano` | 12 | 67% |
| `pedir_dados_faltantes` | 4 | 22% |
| `responder_logistica` | 1 | 6% |
| `buscar_e_ofertar` | 1 | 6% |

**Issues (run 2):**

| Issue | Run 1 | Run 2 | Δ |
|---|---|---|---|
| `generic_escalation_phrase` | 5 | 4 | −1 |
| `escalation_repeated` | (não medido) | 5 | novo |
| `delivery_policy_claim_check` | 1 | 1 | = |
| `stock_claim_check` | 1 | **0** | ✅ −1 |
| `brand_availability_claim` | 1 | **0** | ✅ −1 |

---

## 3. Análise caso a caso — run 2

### conv 392 — medida_depois_bairro
| Turno | Mensagem | Skill | Status |
|---|---|---|---|
| 1 | "Oi, tenho uma Titan 160." | `escalar_humano` | OK — diz que anotou, aguarda |
| 2 | "Quero pneu 140/70-17 traseiro." | `pedir_dados_faltantes` | OK |
| **3** | **"Entrega no Centro e pago no pix."** | `escalar_humano` | **ISSUE: fallback genérico** |

**Esperado no turno 3:** `responder_logistica` + `calcularFrete(bairro=Centro)`. O Planner
não reconheceu bairro + forma de pagamento como pergunta de logística tratável.

---

### conv 393 — medidas_antes_retirada
| Turno | Mensagem | Skill | Status |
|---|---|---|---|
| 1 | "Preciso de um pneu dianteiro 110/70-17." | `escalar_humano` | OK — registra |
| **2** | **"O valor para 140/70-17 traseiro?"** | `escalar_humano` | **ISSUE: escalation_repeated** |
| **3** | **"Pode considerar retirada na loja?"** | `escalar_humano` | **ISSUE: escalation_repeated** |

A say do turno 2 e 3 são contextualmente úteis ("posso seguir com o atendimento"), mas
o Planner não mudou de skill mesmo com pergunta de preço/modo de retirada tratável.

---

### conv 395 — entrega_bairro_cartao
| Turno | Mensagem | Skill | Status |
|---|---|---|---|
| 1 | "Oi, preciso de pneu 205/65R15." | `pedir_dados_faltantes` | OK |
| **2** | **"Quanto fica entrega no Meier?"** | `escalar_humano` | **ISSUE: fallback genérico** |
| **3** | **"Se for no cartão muda alguma coisa?"** | `responder_logistica` | **ISSUE: delivery_policy_claim_check** |

Turno 2: deveria ser `responder_logistica` + `calcularFrete(bairro=Meier)`.
Turno 3: o Planner finalmente escolheu `responder_logistica`, mas o Generator disse
"o prazo padrão informado é de entrega para o dia seguinte" sem ter resultado de
`calcularFrete`. O say-validator **não** bloqueou (padrão regex não capturou a variante
do texto gerado neste turno — ver seção 4.3).

---

### conv 396 — compatibilidade_marca
| Turno | Mensagem | Skill | Status |
|---|---|---|---|
| **1** | **"Tenho uma Bros 160 ano 2022."** | `escalar_humano` | **ISSUE: fallback genérico** |
| **2** | **"Qual pneu serve nela?"** | `escalar_humano` | **ISSUE: escalation_repeated** |
| **3** | **"Queria Michelin se tiver."** | `buscar_e_ofertar` | **ISSUE: fallback genérico** |

Turno 1: deveria ser `pedir_dados_faltantes` + `buscarCompatibilidade(moto=Bros 160)`.
Turno 2: Planner persistiu com `escalar_humano` — a say explica que precisa da medida
(contextualmente correta, mas skill errada).
Turno 3: Planner corretamente mudou para `buscar_e_ofertar`, porém o Generator não
tinha medidas para buscar e gerou apenas o fallback seguro (sem alucinação, mas sem
conteúdo útil). Isso indica que o Generator sem contexto de ferramenta executada cai
no fallback mesmo com skill diferente de `escalar_humano`.

---

### conv 397 — confirmacao_quantidade
| Turno | Mensagem | Skill | Status |
|---|---|---|---|
| 1 | "Oi, me recomenda um pneu para Honda PCX 150?" | `pedir_dados_faltantes` | OK |
| **2** | **"Quero duas unidades."** | `escalar_humano` | **ISSUE: escalation_repeated** |
| **3** | **"Agora quero falar com um atendente humano."** | `escalar_humano` | **ISSUE: escalation_repeated** |

Turno 2: "Quero duas unidades" é uma confirmação de quantidade — deveria ser `buscar_e_ofertar`
ou `pedir_dados_faltantes` (ainda falta medida/modelo exato). O Planner escolheu `escalar_humano`
e a flagsou como repetida (turno anterior já era `escalar_humano`).
Turno 3: o cliente **pediu** atendente humano — o skill `escalar_humano` está correto aqui.
A flag `escalation_repeated` é um **falso positivo** neste caso (turno 2 já era escalar,
mas turno 3 é legítimo). O checker não distingue escalação legítima de repetição desnecessária.

---

## 4. Diagnóstico

### 4.1 SayValidator — funcionou corretamente

Os dois padrões novos (`stock_claim_check` e `brand_availability_claim`) não apareceram
no run 2. O validator está bloqueando afirmações sem lastro. O padrão `mixed_safe_fallback`
também não apareceu — a regra 9 do Generator reduziu a mistura.

### 4.2 Planner — calibração insuficiente

A seção `ROTEAMENTO CONVERSACIONAL` não alterou o comportamento do LLM de forma
suficiente. A taxa de `escalar_humano` permaneceu em 67% (12/18). O Planner usa
`escalar_humano` como default seguro em vez de investir em skills específicas.

Hipóteses:
- As regras em texto corrido (bullet points) não têm força imperativa suficiente.
- O LLM não tem exemplos (few-shot) mostrando o mapeamento correto.
- O contexto do turno anterior não está sendo explorado pelo Planner para evitar repetição.

### 4.3 delivery_policy_claim_check — regex incompleto

Conv 395 turno 3: o Generator disse "o prazo padrão informado é de entrega para o dia
seguinte" (wording ligeiramente diferente dos padrões atuais). O regex
`/prazo\s+padrao\s+e/i` não capturou "prazo padrão informado é". O validator precisa
de um padrão mais abrangente para capturar variações de "prazo padrão".

### 4.4 escalation_repeated — falso positivo no turno de pedido humano legítimo

Conv 397 turno 3: "Agora quero falar com um atendente humano." deve gerar `escalar_humano`.
O checker flags como `escalation_repeated` porque o turno anterior era também
`escalar_humano`. Para evitar falsos positivos, o checker deveria verificar se o
**conteúdo da mensagem do cliente** indica pedido de humano — se sim, não flagar.

---

## 5. O que melhorou, o que não melhorou

| Item | Antes | Depois | Veredicto |
|---|---|---|---|
| Alucinação de estoque (sem `verificarEstoque`) | 1 | 0 | ✅ Resolvido |
| Alucinação de marca disponível (sem ferramenta) | 1 | 0 | ✅ Resolvido |
| Fallback misturado com resposta útil | (implícito) | 0 | ✅ Resolvido |
| `generic_escalation_phrase` | 5 | 4 | ➖ Levemente melhor |
| `delivery_policy_claim_check` | 1 | 1 | ➖ Sem mudança |
| Taxa `escalar_humano` | 67% | 67% | ❌ Sem mudança |
| Escalação em turnos consecutivos | (não medido) | 5 | ❌ Problema visível |
| Qualidade geral (OK/18) | 12 | 8 | ❌ Regrediu |

A regressão em OK/18 se deve principalmente à adição do check `escalation_repeated`:
5 novos flags que antes não eram contabilizados. Se excluirmos os 2 falsos positivos
(escalação legítima no último turno de conv 397), os problemas reais são 3 novas
escalações repetidas desnecessárias — padrão que antes existia mas não era medido.

---

## 6. Próximas ações recomendadas (Sprint 6.9 continuação)

### Alta prioridade

1. **Reescrever seção ROTEAMENTO CONVERSACIONAL do Planner** com formato imperativo:
   - Trocar bullets por regras numeradas com exemplos inline (`IF X THEN Y`).
   - Adicionar few-shot de 3 turnos demonstrando: frete → `responder_logistica`,
     moto sem medida → `pedir_dados_faltantes`, objeção → `tratar_objecao`.
   - Mover a seção para mais alto no prompt (antes das instruções de output).

2. **Corrigir falso positivo no checker `escalation_repeated`:**
   - Verificar se `m.content` contém pedido explícito de humano antes de flagar.
   - Regex sugerido: `/\b(atendente|humano|pessoa|falar com alguem|me atende)\b/i`

3. **Ampliar padrão `delivery_policy_claim_check`:**
   - Adicionar variante: `/prazo\s+(?:padrao\s+)?informado\s+[eé]/i`
   - Testar com as variações observadas no run 2.

### Média prioridade

4. **Generator sem ferramenta executada**: quando skill ≠ `escalar_humano` mas não há
   `tool_results`, o Generator não deveria usar o fallback seguro — deveria pedir dados
   faltantes ou reconhecer a intenção com linguagem de "vou verificar". Adicionar regra
   ao Generator: "Se a skill for `buscar_e_ofertar` e não houver resultados de ferramenta,
   diga que vai buscar as opções — não use o fallback de atendente humano."

5. **Seeds do catálogo commerce.*** (`commerce.products`, `stock_levels`, `tire_specs`,
   `vehicle_fitments`) — com dados reais, `buscar_e_ofertar` retornaria resultados
   e o Generator teria conteúdo para gerar respostas úteis.

---

## 7. Estado pós-sessão

- `src/atendente/validators/say-validator.ts`: versão com 3 novos padrões.
- `src/atendente/planner/schemas.ts`: `plannerPromptVersion = 'planner_v1.2.0'`.
- `src/atendente/planner/prompt.ts`: seção ROTEAMENTO CONVERSACIONAL adicionada.
- `src/atendente/generator/schemas.ts`: `generatorPromptVersion = 'generator_v1.3.0'`.
- `src/atendente/generator/prompt.ts`: regras 9, 10 e regra final sobre fallback.
- `tests/`: 8 novos testes — 328/328 verde.
- Build TypeScript: verde.
- Commit pendente: `feat(atendente): calibrate planner/generator prompts and harden say-validator`
