# Mudanças do BOT/PROMPT · 2026-06-07 (sessão 2 — pós 1º teste ao vivo)

> Doc curto pra próxima IA. Continuação de `SESSAO_2026-06-07_PICKUP_TO_PARTNER_HANDOFF.md`.
> A 1ª retirada ao vivo (cliente "José", conversa prod #633) virou auditoria. Aqui está o que
> mudou, por quê, e o que falta. Tudo verificado (typecheck + 314 testes). Deploy pendente do Wallace.

## O que o teste do José revelou (3 achados)

1. **Bot "indicou Itaboraí" no escuro.** Cliente de Copacabana pediu retirada; o bot mandou o link de
   uma loja de Itaboraí SEM saber de onde ele era. Causa: o bot perguntou o bairro no turno 1, o cliente
   respondeu só o pneu, o bot **nunca re-perguntou**, e na retirada chamou `localizacao_loja` sem bairro →
   o código caía no fallback "loja ativa mais antiga" (= Borracharia Rio do Ouro, endereço em Itaboraí).
2. **Resumo do pedido só tinha template de ENTREGA.** Na retirada o bot improvisava: só o nome da loja
   (sem endereço escrito) e "Pix **na entrega**" (errado — era retirada).
3. **A reserva NÃO disparou.** O pedido caiu na **matriz** (`commerce.orders`, slug=main), o estoque da
   loja seguiu intacto (0 reservado). O caminho pickup→parceiro+reserva exige `ROUTING_GEO` on **e** uma
   coordenada do cliente (pino OU geocode do bairro via `GOOGLE_MAPS_API_KEY`). No fluxo, o bairro veio
   tarde e provavelmente não foi passado ao `criar_pedido` → caiu na matriz.

## Correções aplicadas

### Código
- **`src/atendente-v2/fulfillment.ts` → `getUnitMapsUrl`:** não chuta mais a loja mais antiga. O fallback
  só devolve loja se houver **EXATAMENTE 1 unidade ativa** (mono-loja); com várias → `null` (o bot pergunta
  o bairro). Passou a devolver também `address` + `opening_hours` (campos `network.partner_units`).
- **`src/atendente-v2/tools.ts` → `localizacao_loja`:** devolve `endereco` + `horario`; quando não resolve
  loja, devolve `{encontrado:false, motivo:'sem_localizacao_pergunte_bairro'}` (o código manda o bot perguntar
  o bairro, em vez de torcer pra ele lembrar da regra). Descrição da tool reforça "sempre passe o bairro".

### Prompt (`src/atendente-v2/prompt.ts`)
- **RETIRADA exige o bairro antes de indicar loja** — nunca indica no escuro (regra + exemplo do caso
  Copacabana/Itaboraí).
- **Template de resumo de RETIRADA** novo: nome + **endereço escrito** + horário + "Pix **na retirada**".
- **Bot pergunta o horário** que o cliente quer (retirada: "que horas passa pra retirar?"; entrega: "melhor
  horário pra receber?") e ecoa no resumo numa linha 🕐 opcional. (Decisão Wallace: o bot PERGUNTA, não anuncia.)
- **Saudação reformada → BAIRRO-FIRST.** Antes pedia pneu + modelo da moto + bairro tudo de uma vez
  (interrogatório). Agora abre leve com UMA pergunta — o bairro, com o motivo no benefício do cliente
  ("pra te atender da loja mais perto de ti"). O pneu vem naturalmente; se o cliente abrir com o pneu, o bot
  **segura o "tenho sim"** até saber o bairro (estoque é por loja; preço e frete são iguais em toda a rede).

### Auditoria (2 agentes: contradição + redundância/fluxo) → 6 contradições reais corrigidas
- Exemplo "cliente abriu com o pneu" pedia bairro **+ nome** juntos (a mesma interrogação que tínhamos tirado) → só o bairro.
- **Cliente recorrente** reusava o bairro antigo do histórico sem confirmar → com a Rede, roteava pra loja
  errada se ele mudou de bairro → agora confirma "ainda aí no [bairro]?".
- Exemplo do turno 3 ("agora calcula frete") pulava a pergunta entrega/retirada → rótulo corrigido.
- Resposta "vocês são de onde?" cravava "a loja fica em São Gonçalo" (uma loja só) → fala da rede + pede o bairro.
- Exemplo de retirada re-pedia o nome já coletado → removido.
- Ordem de pedir o nome (turno seguinte vs. mesmo turno) → alinhada.
- **Redundâncias** (mesma regra repetida em 2–4 lugares) foram **MANTIDAS de propósito**: reforçam, não
  contradizem, e não custam na GPT-5.5 (prompt = ~6,1k tokens numa janela de 1.050.000).

## Verificação
`npm run typecheck` (limpo) · `npm test` (314 verdes) · prova da lógica do `getUnitMapsUrl` contra o banco
de prod (bairro desconhecido com 7 lojas → null; Copacabana → loja certa; loja real → endereço+horário fluem).

## O que falta / atenção
1. **Re-teste ao vivo** depois do deploy (roteiro na §11 do handoff). O fix da saudação força capturar o
   bairro → **aumenta a chance de a reserva disparar** agora.
2. ⚠️ **Confirmar no Coolify:** `ROUTING_GEO=true` + `GOOGLE_MAPS_API_KEY` preenchida (senão pickup→reserva
   não dispara — cai na matriz, sem regressão) **e** `OPENAI_MODEL=gpt-5.5` (o default no código é
   `gpt-4o-mini`; um fallback silencioso explicaria regra caindo). Reasoning effort não é setado → roda em
   `medium` (bom; **não baixar pra `low`** num bot cheio de regra).
3. **Persistir o horário** que o cliente informa no pedido/painel (hoje só aparece no resumo do WhatsApp) —
   precisa de 1 campo + célula no painel "Retiradas aguardando". Fast-follow.
