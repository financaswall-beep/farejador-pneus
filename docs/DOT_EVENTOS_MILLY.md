# Acompanhamento da Milly por eventos

Implementação de 24/10/2026. O monitor começa desligado (`DOT_EVENTS_ENABLED=false`).
Os dados comerciais continuam somente leitura. Não há respostas automáticas para clientes nem alterações em pedidos/estoque/caixa.

## Escopo desta primeira entrega

- `farejador.conversa.atualizada`: conversa com novas mensagens públicas, encerramento e espera sem resposta.
  A Milly consulta o histórico para avaliar necessidade de humano, venda travada, contradições e encerramento com pendência.
  O evento não afirma que houve erro: interpretação fica com o Dot.
- `farejador.entrega.atencao`: falha registrada ou data de entrega vencida na Matriz.
  Sem data combinada, não inventa atraso. Entrega concluída/cancelada deixa de ser elegível.
- `consultar_acompanhamento_matriz`: ferramenta de leitura para verificar assinaturas, limites e contadores.

Os demais itens propostos (reposição, retorno de interessados, conciliação, marketing e monitor externo de indisponibilidade)
não fazem parte deste piloto. Também não há tarefa de resumo diário instalada automaticamente no Dot.

## Fluxo e controle de excesso

1. Triggers leves criam/atualizam uma referência em `ops.dot_monitor_targets`, somente quando existe assinatura ativa.
   A transação de ingestão não chama rede nem LLM. Mensagens em partições mensais usam argumento explícito do trigger.
2. Worker no mesmo processo roda a cada 30 segundos. Espera 90 segundos de silêncio e agrupa rajadas por até cinco minutos.
3. O worker lê fontes em transações `READ ONLY`, respeitando ambiente, conta Chatwoot e exclusões.
4. Fila persistente `ops.dot_event_deliveries` impede repetição do mesmo estado na mesma ativação.
   Mudanças/casos resolvidos cancelam pendências; toda entrega reconsulta a fonte e a autorização.
5. Eventos normais têm intervalo mínimo de dez minutos por caso, teto de 30 avaliações/hora por assinatura e silêncio
   de 22h a 8h em São Paulo. Isso limita eventos enviados ao Dot, não garante quantas notificações o cliente ChatGPT mostrará.
   Falha de entrega registrada passa pelo horário e teto, mas continua sujeita a deduplicação e confirmação da fonte.
6. A Milly recebe IDs/fatos, lê as consultas existentes e decide se vale chamar o proprietário. Conversas e notas não são instruções.

O teto adia eventos; casos ainda pendentes por mais de 24 horas são cancelados para não gerar alertas antigos.
Reinícios preservam assinaturas e filas. O bloqueio de remetente usa transação aberta com advisory lock transacional,
compatível com pooler Supabase: antes de cada envio, a conexão que mantém o bloqueio é conferida.
Se a assinatura expirar ou for desconectada, não há replay desse intervalo (`cursor=null`). Reconexão cria nova geração;
fila da geração anterior nunca é reenviada. Histórico técnico encerrado fica por sete dias.

## Configuração

Aplicar `db/migrations/0275_dot_events.sql` pelo processo de migrations do projeto, antes de habilitar os eventos.
A migration foi preparada para aplicação explícita: esta implementação não a aplica em produção automaticamente.

Variáveis novas, já encaminhadas pelo Compose:

| Variável | Padrão |
| --- | --- |
| `DOT_EVENTS_ENABLED` | `false` |
| `DOT_EVENTS_ENCRYPTION_KEY` | vazia; obrigatório fornecer 32 bytes aleatórios em base64 para ativar |
| `DOT_EVENTS_WAIT_MINUTES` | `10` |
| `DOT_EVENTS_COOLDOWN_MINUTES` | `10` |
| `DOT_EVENTS_MAX_PER_HOUR` | `30` |
| `DOT_EVENTS_QUIET_START_HOUR` | `22` |
| `DOT_EVENTS_QUIET_END_HOUR` | `8` |

Horas iguais desligam o silêncio. Esses valores são pontos de partida ajustáveis, não foram apresentados como regra comercial existente.
A chave deve ser gerada no ambiente seguro e guardada nos secrets do Coolify, nunca no Git, logs ou conversa.
Preservar a chave entre deploys. Trocar a chave exige desligar eventos e refazer assinaturas, ou uma migração de recifragem.
O boot com eventos ativos valida chave e tabelas; configuração incompleta falha explicitamente.
`DATABASE_POOL_MAX` deve ser pelo menos 2 (padrão do projeto: 10), pois uma conexão mantém o bloqueio do worker.

## Ativação e prova real

1. Aplicar a migration, configurar chave, habilitar flag e fazer deploy pelo Coolify.
2. Atualizar/reescanear o plugin Farejador. Conferir os dois eventos e a ferramenta de acompanhamento.
3. No próprio Dot Milly, pedir assinatura para uma conversa escolhida, com `ids` contendo o UUID de `core.conversations`.
   Para entregas, usar UUID de `commerce.orders`. `ids:[]` não acompanha nada. Ausência do filtro acompanha novos acontecimentos.
4. Confirmar `server/discover`, `events/list`, assinatura, verificação de callback e presença da assinatura na consulta de acompanhamento.
5. Usar um atendimento controlado autorizado e verificar: atualização agrupada chega, a Milly consulta o histórico e fica silenciosa
   quando não há decisão; pendência real produz um aviso útil; resposta posterior cancela aviso ainda na fila.
6. Pedir para parar o acompanhamento. Confirmar `events/unsubscribe` e ausência de novos envios.
7. Só ampliar para todas as conversas após conferir a qualidade do piloto.

Conectar o plugin sozinho não assina eventos. Um `2xx` do webhook prova apenas recebimento pelo ChatGPT;
o sucesso ponta a ponta depende de observar a análise da Milly. Testes locais usam receptor simulado e não provam esse passo.

Instrução inicial sugerida para o piloto:

> Acompanhe os eventos desta conversa no Farejador. Consulte o histórico completo e os registros necessários antes de concluir.
> Avise-me somente se houver uma decisão concreta para mim: humano necessário sem atendimento, venda travada,
> informação contraditória ou conversa encerrada com pendência. Traga evidência, link e ação sugerida.
> Não anuncie cada atualização, não envie avisos de que tudo está bem e não repita casos sem piora ou informação relevante.
> Se eu disser que já estou cuidando, pare de cobrar esse caso. Não responda a clientes nem altere registros comerciais.

Para excluir casos no próprio servidor, substituir a assinatura anterior por uma com `ignorar_ids`; alterações de filtros geram
outra identidade de assinatura, então é necessário encerrar a anterior. O controle de notificação e memória da Milly continua no ChatGPT.

## Segurança e protocolo

- MCP `2026-07-28` tem despacho HTTP próprio limitado a descoberta, consultas e eventos; SDK existente serve clientes legados.
  Todos usam o mesmo OAuth de proprietário, limites, validação de origem e concorrência.
- Assinaturas duram no máximo um dia, renováveis pelo cliente, e nunca além do grant original.
- Callback HTTPS público, DNS verificado e fixado a cada conexão; sem redirects, proxy implícito, IP privado ou resposta ilimitada.
- Challenge fresco e assinado antes da ativação. Geração pendente impede que verificação antiga desfaça unsubscribe/refresh mais novo.
- HMAC Standard Webhooks sobre bytes exatos, ID estável no retry, timestamps renovados. Chaves cifradas AES-256-GCM com AAD da assinatura.
- Rotação preserva chave anterior por dois minutos apenas na mesma autorização ativa. Reativação remove chaves anteriores.
- Revalidação de grant, pessoa, proprietário, ambiente, cliente, recurso e escopo em cada envio.
- Retentativa limitada para falhas transitórias; `410` encerra assinatura, `413` não é repetido.
- Tabelas privadas têm RLS, sem grants para parceiro/anon/authenticated/service_role e fora do catálogo de consultas.

Rollback operacional: `DOT_EVENTS_ENABLED=false` e redeploy. Consultas permanecem disponíveis.
Para interromper captura também, encerrar as assinaturas/desconectar o Dot; os triggers só capturam enquanto houver assinatura não expirada.
Não remover as tabelas antes dos triggers nem alterar dados de conversas para desfazer esta funcionalidade.

Referências: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events),
[MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic).
