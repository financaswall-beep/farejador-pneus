# Experimento: prompt híbrido inglês + exemplos pt-br

**Data início**: 2026-05-26
**Status**: 🟡 EM TESTE
**Objetivo**: economizar ~37-40% de tokens do system prompt sem perder qualidade

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

## 11. Histórico desta decisão

1. Sessão de otimização declarou "teto técnico atingido" em `b7fd8f1`
2. Dono perguntou sobre prompt em inglês mesmo assim
3. Assistente inicialmente recomendou não fazer (R$ 20/mês a 1k convs)
4. Dono insistiu: "mexo agora pra ter margem no crescimento"
5. Assistente reconheceu mentalidade correta + medições mostraram economia maior do que estimado (~R$ 160/mês a 1k convs vs estimativa anterior de R$ 20)
6. Dono enviou versão híbrida pronta com FINAL CHECK item 8 (trava idioma)
7. Aplicado neste commit
