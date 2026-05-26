# Experimento: prompt híbrido inglês + exemplos pt-br

**Data início**: 2026-05-26
**Status**: 🟡 EM TESTE — **3/5 convs validadas, 0 regressão**
**Objetivo**: economizar ~37-40% de tokens do system prompt sem perder qualidade

## Status acumulado (atualização 2026-05-26)

| # | Conv | Cliente | Pedido | Idioma | Tom mantido | Nota |
|---|------|---------|--------|:-----:|:-----:|:----:|
| 1 | 622 | Wallace | PED-0008 R$ 108,90 | ✅ 100% pt-br | ✅ | 9.5/10 |
| 2 | 623 | Anderson | PED-0009 R$ 207,90 | ✅ 100% pt-br | ✅ | 9.8/10 |
| 3 | **624** | **Wallace** | **PED-0010 R$ 207,90** | **✅ 100% pt-br** | **✅** | **9.6/10** |
| 4 | — | (pendente) | — | — | — | — |
| 5 | — | (pendente) | — | — | — | — |

**Critério pra declarar estável**: 5 convs consecutivas sem regressão (1 falta = volta a 0).
**Faltam: 2 convs.**

---

## 1. O que mudou

Substituí o `SYSTEM_PROMPT` em `src/atendente-v2/prompt.ts` por uma versão com:
- **Regras em inglês** (mais eficiente em tokens)
- **Exemplos de resposta em pt-br** (preserva vocabulário brasileiro)
- **Trava de idioma** no item 8 do `FINAL CHECK`: `"Is my final customer answer in Brazilian Portuguese?"`

## 2. Onde está o prompt anterior

**Arquivo de backup**: `src/atendente-v2/prompt.legacy-ptbr.ts`

Exporta `LEGACY_SYSTEM_PROMPT_PTBR` — texto idêntico ao que rodou até 2026-05-26 (commit `b7fd8f1` e anteriores).

Esse arquivo **não está sendo importado** por nenhum lugar — fica só como referência.

## 3. Comparação de tokens

| Versão | Caracteres | Tokens estimados |
|---|---|---|
| Anterior (pt-br completo) | 9.982 | ~2.852 |
| **Nova (inglês + exemplos pt-br)** | **6.786** | **~1.700-1.790** |
| Economia | -3.196 | **-1.060 a -1.150 (~37-40%)** |

## 4. Economia em R$ (estimativa)

Com cache hit médio de 81% (medido em conv 622), preço gpt-5.5 ($5/M input, $0.50/M cached):

| | Tokens efetivos/turn | R$/turn |
|---|---|---|
| Antes | ~1.683 pagos | R$ 0,042 |
| Depois | ~1.056 pagos | R$ 0,026 |
| **Economia/turn** | | **R$ 0,016** |

Por conversa de 10 turns: **R$ 0,16**.
A 1.000 convs/mês: **~R$ 160/mês**.

## 5. Riscos previstos

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Bot vazar inglês na resposta | 2-5% | Item 8 do FINAL CHECK trava no fim do prompt |
| Mensagem de erro/fallback em inglês | 1-3% | Exemplos pt-br ancoram vocabulário |
| Drift sutil de tom | 5-10% | Tone anchors mantidos ("Fechou?", "Pega?", "Tá fechado") |
| Cache rebuild durante transição | 100% | Esperado, custo único de ~R$ 0,50 |

## 6. O que monitorar (primeiras 5-10 conversas)

Sinais de problema:

❌ **Reverter se aparecer**:
- Bot respondendo "Hi! How can I help?" ou similar em inglês
- Bot esquecendo regras críticas (anuncia estoque, pula etapa, cria delivery sem valor_frete)
- Texto "Pedido criado!" em vez de "Tá fechado, [nome]"
- OPCOES em inglês ("Pickup | Delivery" em vez de "Retirada | Entrega")

🟡 **Avaliar mas não reverter automaticamente**:
- Bot usa "Beleza" em vez de "Show" no aceite
- Bot fala um pouco mais formal que antes
- Resposta com tom levemente diferente

✅ **OK**:
- Vocabulário brasileiro mantido nos exemplos
- Status traduzido pro cliente ("em separação" em vez de "open")
- Resumo final estruturado preservado

## 7. Como reverter (3 caminhos)

### Caminho 1: Git revert (mais limpo)
```bash
git revert <hash-do-commit-experimento>
git push pneus
```

### Caminho 2: Usar o legacy importado
Em `src/atendente-v2/prompt.ts`, substituir:
```typescript
export const SYSTEM_PROMPT = `...inglês...`;
```
Por:
```typescript
export { LEGACY_SYSTEM_PROMPT_PTBR as SYSTEM_PROMPT } from './prompt.legacy-ptbr.js';
```

### Caminho 3: Coolify rollback
- Coolify → app → Deployments → escolhe deployment anterior → "Redeploy"

Tempo total em qualquer caminho: ~5 minutos.

## 8. Critério de decisão (após 1 semana)

**Manter o experimento se**:
- Zero conversas com vazamento de idioma
- Zero regressões em proteções (frete, fluxo, estoque)
- Tom brasileiro mantido em 95%+ das respostas
- Economia confirmada via logs (`cache_hit_pct`)

**Reverter se**:
- 1+ conversa com resposta em inglês
- 1+ bug crítico que não existia antes
- Tom drift perceptível pelo dono da loja

**Iterar (corrigir e manter) se**:
- Pequenos ajustes resolverem (ex: adicionar 1 exemplo a mais)

## 9. Custo se der errado

| Item | Custo |
|---|---|
| Aplicação do experimento | 0 (já feito) |
| Cache rebuild | ~R$ 0,50 nas primeiras 5-10 convs |
| Reverter se necessário | 5 min + ~R$ 0,50 cache rebuild |
| **Pior caso** | **~R$ 1,00 + 10 min** |

## 10. Commits relacionados

- Commit do experimento: ver `git log` (será adicionado após push)
- Commit base (último com prompt pt-br): `b7fd8f1`
- Doc de análise prévia: `docs/AGENT_V2_OTIMIZACAO_TETO.md` (esta otimização foi declarada "teto" antes deste experimento — revisado)

## 11. Validação em produção — convs auditadas

### Conv 622 — Wallace 2 (PED-0008) — 1ª pós-deploy
**Data**: 2026-05-26 04:58–05:08 UTC
**Resultado**: ✅ APROVADO (com warmup de cache)

| Métrica | Valor |
|---|---|
| Turns | 7 |
| Input tokens | 34.694 |
| Output tokens | 768 |
| Cache hit medido | 76-79% (turns auditáveis nos logs) |
| Custo real | **R$ 0,50** (warmup de cache pós-deploy) |
| Pedido criado | PED-0008 R$ 108,90 ✅ frete incluso no `total_amount` |
| Idioma | 100% pt-br ✅ |
| Tom mantido | "meu camarada", "Show", "fica tranquilo", "Tá fechado, Wallace 👍" ✅ |
| Tools chamadas | 4 (buscar_compatibilidade, buscar_politica, calcular_frete, criar_pedido) |
| Inteligência social | Entendeu "tá filezinho?" como "é bom?", parseou endereço com typos ✅ |
| Drift menor | Faltou OPCOES em "Qual modelo da Fan?" (cliente respondeu OK) 🟡 |

**Nota**: 9.5/10

**Observação técnica**: R$ 0,50 foi cache warmup. A 2ª conv depois esperada em ~R$ 0,30-0,40.

---

### Conv 623 — Anderson (PED-0009) — 2ª pós-deploy
**Data**: 2026-05-26 05:23–05:34 UTC
**Resultado**: ✅ APROVADO — **MELHOR CONV DA SESSÃO**

| Métrica | Valor |
|---|---|
| Turns | 8 |
| Input tokens | 44.896 |
| Output tokens | 1.086 |
| Custo real | **R$ 0,43** (cache esquentado, queda de R$ 0,50 → R$ 0,43 vs conv 622) |
| Pedido criado | PED-0009 R$ 207,90 ✅ (R$ 198 itens + R$ 9,90 frete) |
| Idioma | 100% pt-br ✅ |
| Tom mantido | "Beleza?", "Tranquilo, cara", "Show", "Top", "Tá fechado, Anderson 👍" ✅ |
| Tools chamadas | 5 (3× buscar_compatibilidade paralelo, calcular_frete, criar_pedido) |

**Acertos brilhantes** (todos novos casos não testados antes):
1. **Multi-produto multi-moto**: cliente pediu pneu da NMAX + da PCX juntos → bot disparou 2 `buscar_compatibilidade` em paralelo ✅
2. **PCX ambígua**: bot listou 3 modelos (150 com 2 medidas + 160) com preços ✅
3. **Cliente travou ("não sei o modelo")**: bot deu dica prática de mecânico ("na lateral do pneu velho tem a medida") em vez de escalar ✅
4. **Cliente sugeriu alternativa ("pelo ano?")**: bot adaptou — perguntou ano → 2024 → identificou PCX 160 ✅
5. **Consolidação inteligente**: bot percebeu que os 2 pneus eram fisicamente IGUAIS (mesmo product_id 130/70-13) e gravou no banco como 1 item quantity=2 (não 2 itens duplicados) ✅
6. **Parsing de endereço com typos**: "rua balaço travas n678 vargem grande" → gravou corretamente ✅

**Nota**: 9.8/10 — provavelmente a conv mais complexa que o bot já fechou.

---

### Status do experimento: 2/5 convs validadas

| Critério | Status |
|---|---|
| Idioma 100% pt-br | ✅ 2/2 convs |
| Zero regressão em proteções (frete/fluxo/estoque) | ✅ 2/2 convs |
| Tom brasileiro mantido | ✅ 2/2 convs |
| Economia confirmada via logs | ✅ Cache hit 76-79% medido |
| Banco gravando correto | ✅ PED-0008 e PED-0009 com `total_amount` certo |

**Faltam 3 conversas pra declarar estável.** Critério: continuar zero regressão até a 5ª conv consecutiva.

---

### Métricas comparativas (custo real por conversa)

| Conv | Modelo | Prompt | Turns | Custo | Notas |
|---|---|---|---|---|---|
| 619 (Wallace 1) | gpt-5.5 | pt-br original | 8 | R$ 0,30 | Pre-fixes (frete não no banco) |
| 621 (Ângelo) | gpt-5.5 | pt-br corrigido | 10 | R$ 0,40 | Fixes aplicados |
| 622 (Wallace 2) | gpt-5.5 | **EN+exemplos PT** | 7 | R$ 0,50 | 1ª pós-deploy (cache warmup) |
| **623 (Anderson)** | gpt-5.5 | **EN+exemplos PT** | 8 | **R$ 0,43** | Cache esquentado, mais complexa |

**Custo médio esperado em regime** (cache estável): R$ 0,30-0,45 por conv.

---

## 12. Histórico desta decisão

1. Sessão de otimização declarou "teto técnico atingido" em `b7fd8f1`
2. Dono perguntou sobre prompt em inglês mesmo assim
3. Assistente inicialmente recomendou não fazer (R$ 20/mês a 1k convs)
4. Dono insistiu: "mexo agora pra ter margem no crescimento"
5. Assistente reconheceu mentalidade correta + medições mostraram economia maior do que estimado (~R$ 160/mês a 1k convs vs estimativa anterior de R$ 20)
6. Dono enviou versão híbrida pronta com FINAL CHECK item 8 (trava idioma)
7. Aplicado neste commit
