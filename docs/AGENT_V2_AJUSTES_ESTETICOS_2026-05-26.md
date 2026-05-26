# Ajustes estéticos do bot V2 — 2026-05-26

Solicitação do Wallace após a conv 624. Estes ajustes vão entrar no `src/atendente-v2/prompt.ts` na próxima iteração.

---

## 1. Os 4 ajustes

| # | O quê | Antes | Depois |
|---|-------|-------|--------|
| 1 | Preço sempre com 2 casas | `R$ 99` | `R$ 99,00` |
| 2 | Cotação por posição com `:` | `Dianteiro 110/70-17 — R$ 99` | `**Dianteiro:** 110/70-17 — **R$ 99,00**` |
| 3 | Negrito nos labels do resumo | `Pedido PED-0010` | `**Pedido:** PED-0010` |
| 4 | Trocar "Pega?" por gatilhos naturais | "Pega?" | "Bora fechar?" / "Te separo?" / "Manda fechado?" |

---

## 2. Conversa do Wallace reescrita (preview do que vai ser)

> A formatação `**texto**` aqui é a sintaxe que o **WhatsApp** vai renderizar como negrito (no WhatsApp é `*texto*`, mas neste documento markdown uso `**texto**` pra você ver o efeito).

---

**Cliente:** Olá meu amigo bom dia

**Bot:**
Bom dia, meu amigo! Beleza?

Me fala a medida do pneu que você precisa, tipo 90/90-18, ou o modelo da moto que eu vejo aqui pra você.

---

**Cliente:** Cara tô procurando um parzinho da tiwistter 2019 tem aí ?

**Bot:**
Tenho sim, amigo. Twister 2019 usa 110/70-17 na frente e 140/70-17 atrás.

**Dianteiro:** 110/70-17 — **R$ 99,00**
**Traseiro:** 140/70-17 — **R$ 99,00**

O par sai **R$ 198,00**. Bora fechar?

---

**Cliente:** Caralho muito barato esses pneus são novos ?

**Bot:**
Não é novo não, amigo, mas relaxa. A gente trabalha com pneu meia vida selecionado — conferido aqui na loja, sem furo, sem rachadura, com bastante borracha ainda.

Roda igualzinho a novo pela metade do preço. É o tipo de pneu que mecânico bom indica pra quem usa moto pra trabalhar.

Esse serve pra você?

---

**Cliente:** Saquei vcs entregam retira aí na sua loja como que faz ?

**Bot:**
Os dois, cara. Entrego no seu endereço ou você retira aqui na loja, como ficar melhor.

Se for entrega eu calculo o frete pelo seu bairro. Vai querer entrega ou retirada?

---

**Cliente:** Então sou de Maria Paula

**Bot:**
Show, Maria Paula entrego sim. Frete **R$ 9,90**.

**Subtotal:** **R$ 198,00**
**Frete:** **R$ 9,90**
**Total:** **R$ 207,90**

Fica bom assim?

---

**Cliente:** Show

**Bot:**
Boa. Pra fechar me passa numa mensagem só:

**Nome:** completo
**Endereço:** rua, número e bairro
**Pagamento:** Pix, cartão ou dinheiro

---

**Cliente:** Wallace Fernandes rua Herculano Ramos 567 Maria Paula São Gonçalo vou pagar no pix

**Bot:**
Tá fechado, Wallace 👍

✅ **Pedido:** PED-0010
✅ **Dianteiro:** Pneu 110/70-17 — **R$ 99,00**
✅ **Traseiro:** Pneu 140/70-17 — **R$ 99,00**
✅ **Frete:** Maria Paula — **R$ 9,90**
✅ **Total:** **R$ 207,90**

📍 **Entrega:** _Rua Herculano Ramos, 567, Maria Paula, São Gonçalo_
💳 **Pagamento:** _Pix na entrega_

Já separamos e sai pra entrega. Qualquer coisa chama aqui 👍

---

## 3. Como vai ficar no WhatsApp do cliente

No WhatsApp, o `**texto**` deste documento vira `*texto*` (1 asterisco) na mensagem real, e o app renderiza em negrito. Assim:

```
Tá fechado, Wallace 👍

✅ *Pedido:* PED-0010
✅ *Dianteiro:* Pneu 110/70-17 — *R$ 99,00*
✅ *Traseiro:* Pneu 140/70-17 — *R$ 99,00*
✅ *Frete:* Maria Paula — *R$ 9,90*
✅ *Total:* *R$ 207,90*

📍 *Entrega:* _Rua Herculano Ramos, 567, Maria Paula, São Gonçalo_
💳 *Pagamento:* _Pix na entrega_
```

Cliente vê os labels (`Pedido`, `Dianteiro`, `Traseiro`, `Frete`, `Total`, `Entrega`, `Pagamento`) **em negrito**, e os valores também.

---

## 4. Lista de gatilhos de fechamento aprovados

Em vez de sempre "Pega?", rotacionar entre frases mais naturais que o cliente real usa:

| Frase | Quando usar |
|-------|-------------|
| **Bora fechar?** | Genérica, depois da cotação |
| **Esse serve?** | Quando apresentou produto, pergunta se atende a necessidade |
| **Manda fechado?** | Cliente já disse "show" mas falta confirmar |
| **Fecho pra você?** | Tom mais consultivo |
| **Posso separar?** | Quando estoque é limitado (gatilho de escassez) |
| **Fica bom assim?** | Após apresentar total com frete |
| **Te interessa?** | Quando cliente fez pergunta antes |
| **Manda os dados que já separo** | Frase que avança sem precisar de "sim" explícito |
| **Pode ser?** | Genérica e leve |

### ❌ NÃO usar

- "Pega?" — soa artificial, ninguém fala assim
- "Te separo?" — ninguém fala assim na rua
- "Quer ficar com ele?" — robótico

### Observação do dono (Wallace, 2026-05-26)

> "'Te separo?' essa palavra ninguém fala. 'Esse serve?' é o que cliente real usa."

---

## 5. Regras de preço

1. **Sempre 2 casas decimais**: `R$ 99,00`, não `R$ 99`
2. **Vírgula como separador decimal**: `R$ 207,90`, não `R$ 207.90`
3. **Espaço entre R$ e o número**: `R$ 99,00`, não `R$99,00`
4. **Negrito em todo valor monetário no resumo final e na cotação por posição**

---

## 6. Regras de formatação por posição (dianteiro/traseiro)

Quando cotar pneu com posição específica:

```
*Dianteiro:* [medida] — *R$ XX,XX*
*Traseiro:* [medida] — *R$ XX,XX*
```

Não usar mais:
```
Dianteiro 110/70-17 — R$ 99    ← formato antigo, sem negrito, sem :, sem vírgula
```

Quando for posição única ("apenas traseiro"):
```
*Traseiro:* 90/90-18 — *R$ 99,00*
```

Quando for medida sem posição definida:
```
*Pneu 130/70-13* — *R$ 99,00*
```

---

## 7. Resumo final padronizado

Template fixo do resumo após `criar_pedido`:

```
Tá fechado, [Nome] 👍

✅ *Pedido:* [PED-XXXX]
✅ *[Posição/Item]:* [Descrição simplificada] — *R$ [valor],00*
✅ *Frete:* [bairro] — *R$ [valor],00*    (se delivery)
✅ *Total:* *R$ [total],00*

📍 *Entrega:* _[endereço completo]_   (se delivery)
💳 *Pagamento:* _[forma] na entrega_

Já separamos e sai pra entrega. Qualquer coisa chama aqui 👍
```

---

## 8. Próximos passos — ESTÉTICA + AJUSTES APROVADOS

### 🎯 Pra aplicar AGORA (aprovados pelo Wallace 2026-05-26)

#### A. Estéticos (no prompt)
- [ ] Preço sempre `R$ XX,XX` com 2 casas e vírgula
- [ ] Formatação `*Dianteiro:*` / `*Traseiro:*` com `:` e negrito
- [ ] Negrito (`*texto*`) nos labels do resumo final (Pedido, Frete, Total, Entrega, Pagamento)
- [ ] Trocar "Pega?" / "Te separo?" pela nova lista de gatilhos (`Esse serve?`, `Bora fechar?`, etc)

#### B. Comportamentais (no prompt)
- [ ] **Antecipar "meia vida"** na primeira cotação, sem esperar cliente perguntar
- [ ] **Agradecimento curto** no final do resumo ("Valeu pela confiança!" ou "Tamo junto, [nome]!")

#### C. Saudação personalizada (código + dados)
- [ ] **Saudar recorrente pelo nome** — injetar contexto no system prompt baseado em `customer_journey_mv.is_returning` (NÃO precisa tool, é só contexto extra no prompt)

#### D. Operacional (env + código)
- [ ] **Subir `OPENAI_TIMEOUT_MS=60000`** no Coolify (30s → 60s)
- [ ] **Retry automático no código** quando der AbortError (tentar +1× antes de marcar failed)
- [ ] **Cron de retry como rede de segurança** — se o retry do código falhar, cron reseta failed → pending depois de 1min

#### E. SQL puro
- [ ] **Criar view `analytics.v_clientes_pra_recuperar`** — lista quem cotou mas não fechou. Pra mandar mensagem manual.

---

## 9. Pendências (NÃO aplicar agora, ficar pra depois)

Anotado pelo dono em 2026-05-26 que **não vai aplicar ainda**:

### Features novas (esforço maior)

- [ ] **Upsell de câmara/válvula** — precisa cadastrar câmaras no catálogo primeiro
- [ ] **Variação ampliada de saudação** — "E aí cara!", "Salve!", "Fala mano!" (hoje já varia algumas, dá pra esticar)
- [ ] **Prazo concreto no resumo** — "sai amanhã às X horas" precisa lógica de horário de entrega
- [ ] **Bot envia foto do pneu** — exige upload + tool nova + storage
- [ ] **Agendamento de horário de entrega** — exige campo novo em orders + lógica
- [ ] **Confirmação de pagamento Pix com comprovante** — exige Vision API + tool
- [ ] **Recuperação automática de carrinho 24h depois** — exige cron + envio Chatwoot ativo

### Observação

Essas pendências não bloqueiam nada do operacional. Bot funciona perfeito sem elas. Voltar a esta seção quando volume crescer ou prioridade mudar.

---

## 10. Decisões registradas

| Data | Decisão | Autor |
|------|---------|-------|
| 2026-05-26 | Preço sempre com vírgula e 2 casas | Wallace |
| 2026-05-26 | Negrito nos labels do resumo via `*texto*` (WhatsApp) | Wallace |
| 2026-05-26 | "Esse serve?" volta à lista, "Te separo?" sai | Wallace |
| 2026-05-26 | Antecipar "meia vida" sem cliente perguntar | Claude/Wallace |
| 2026-05-26 | Saudar recorrente pelo nome via contexto no prompt (sem tool) | Claude/Wallace |
| 2026-05-26 | Retry no código + cron como camadas redundantes | Claude/Wallace |
| 2026-05-26 | Demais features (upsell, foto, agendamento, etc) — adiadas | Wallace |
