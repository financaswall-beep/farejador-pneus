# Acompanhamento da Milly por eventos

Implementação inicial de 24/10/2026; ampliação de avisos e controles em 25/10/2026 (migration 0276).
O monitor começa desligado (`DOT_EVENTS_ENABLED=false`).
O acompanhamento pode investigar, organizar pendências e preparar rascunhos privados. Qualquer lançamento financeiro da conexão de acompanhamento exige aprovação individual do dono.

## Autonomia por evento

Aplicar `0290_dot_monitor_actions.sql` antes do deploy da versão MCP 1.8.0. Depois, atualizar o conector. Em **Avisos do assistente**, habilitar **Revisar rascunhos de publicação** e **Lotes disponíveis para conferir**, e pedir à Milly para assinar os dois eventos junto aos anteriores. O próprio cliente renova suas assinaturas antes de `refreshBefore`. A assinatura, a entrega do evento e o aviso efetivamente visto pelo dono são verificações distintas.

- `farejador.marketing.rascunho` acompanha edições de rascunhos no publicador da Matriz. A Milly pode consultar o texto e as legendas por destino em `ops.publisher_posts`. Um post criado diretamente no Instagram pode aparecer no contexto de um atendimento, mas não gera este evento do publicador.
- `farejador.estoque.lote` acompanha movimentações registradas em lotes com saldo livre. A Milly pode pedir conferência e cruzar os dados com procura e entradas. Somente uma medida efetivamente identificada pode sustentar uma oferta.
- Com o `eventId`, a Milly pode registrar, consultar e encerrar pendências internas. Os rascunhos e as tarefas ficam disponíveis ao dono por MCP. **Avisos do assistente** mostra até 20 abertas, priorizando as de prioridade alta. No ChatGPT, a Milly pode avisar o que fez de relevante e pedir decisão com os dados da operação.
- A primeira assinatura verificada protege as conexões desta Milly para o mesmo dono e recurso, inclusive após reconectar, pausar ou expirar os avisos. A migration inclui assinaturas já verificadas. Propostas financeiras valem por 15 minutos. O dono confere os dados na Matriz, onde pode aprovar ou recusar. A aprovação conclui a operação quando os dados continuam válidos. Para fotos ou arquivos de comprovante, a Milly repete a mesma chamada após a aprovação, mantendo os bytes e a URL temporária fora da tabela de propostas.

## Propostas de vencimento

Em **Avisos do assistente → Permissões da Milly**, o proprietário pode habilitar propostas de mudança de vencimento em parcelas abertas de atacado ou lote. Com o acompanhamento por eventos, a Milly entrega um link válido por 15 minutos para o dono conferir e confirmar. O Farejador revalida o vencimento e o saldo antes de gravar no histórico da venda. A opção de confirmação por voz ou texto continua disponível para proprietários que ainda não ativaram o acompanhamento com esse cliente.

O mesmo link permite **Restaurar vencimento anterior** enquanto a parcela continuar aberta com o vencimento confirmado. **Voltar para somente consulta** cancela propostas pendentes daquela conexão. As configurações de avisos são independentes.

## Avisos disponíveis

- `farejador.conversa.atualizada`: conversa com novas mensagens públicas, encerramento e espera sem resposta.
  A Milly consulta o histórico para avaliar necessidade de humano, venda travada, contradições e encerramento com pendência.
  O evento não afirma que houve erro: interpretação fica com o Dot.
- `farejador.entrega.atencao`: falha registrada, data vencida ou, quando habilitado no painel,
  ausência de atualização além do limite. Sem data combinada, informa parada, sem afirmar atraso prometido.
  Entrega concluída/cancelada deixa de ser elegível.
- `farejador.estoque.procura`: contatos distintos buscaram a mesma medida sem disponibilidade nas lojas consultadas.
  Repetições do mesmo contato não aumentam a contagem. O evento pede conferir estoque atual e entradas previstas.
- `farejador.estoque.disponivel`: interesse consentido pendente encontra estoque vendável na Matriz, conforme as regras
  da lista de espera (condição, quantidade disponível, reservas e custo). Não envia mensagem ao cliente.
- `farejador.atendimento.inconsistencia`: último turno entregue tem bloqueio estruturado de pedido por preço/estoque.
  Não classifica texto livre como promessa errada. A análise de promessas e contradições continua nos eventos de conversa.
- `farejador.financeiro.atencao`: contas a pagar/receber vencidas ou próximas do vencimento e sinais de conciliação do livro central.
  Inclui origens duplicadas, órfãs, desequilíbrios e datas de caixa ausentes. Uma origem duplicada não prova cobrança duplicada.
  Não enxerga movimentações bancárias ainda não registradas no Farejador.
- `farejador.marketing.atencao`: campanha própria verificada, em BRL, supera gasto mínimo com poucos resultados da plataforma.
  Meta usa conversas; Google usa conversões. Isso não equivale a conversas qualificadas ou vendas realizadas.
  Métricas ausentes/desatualizadas geram pedido de conferência de rastreamento, nunca zero inventado.
- `farejador.sistema.atencao`: fila antiga/falha, dead letters pendentes, ingestão com erro e sincronizações Meta/Google atrasadas.
  Sem tráfego não significa falha. A tolerância de sincronização soma o intervalo real do worker ao limite configurado.
  Queda total requer o processo externo descrito abaixo.
- `consultar_acompanhamento_matriz`: ferramenta de leitura para verificar assinaturas, limites e contadores.

As seis categorias novas começam desligadas. Não há tarefa de resumo diário instalada automaticamente no Dot.
Nenhuma variável adicional por categoria é necessária.

## Fluxo e controle de excesso

1. Triggers leves criam/atualizam uma referência em `ops.dot_monitor_targets`, somente quando existe assinatura ativa.
   A transação de ingestão não chama rede nem LLM. Mensagens em partições mensais usam argumento explícito do trigger.
2. Worker no mesmo processo roda a cada 30 segundos. Espera 90 segundos de silêncio e agrupa rajadas por até cinco minutos.
3. O worker lê fontes em transações `READ ONLY`, respeitando ambiente, conta Chatwoot e exclusões.
4. Fila persistente `ops.dot_event_deliveries` impede repetição do mesmo estado na mesma ativação.
   Mudanças/casos resolvidos cancelam pendências; toda entrega reconsulta a fonte e a autorização.
5. Por padrão: intervalo mínimo de dez minutos por caso, teto de 30 eventos/hora por proprietário (todas as assinaturas juntas)
   e silêncio de 22h a 8h em São Paulo. Isso limita eventos enviados ao Dot, não garante quantas notificações o cliente ChatGPT mostrará.
   Falha de entrega registrada pode passar pelo silêncio, se permitido no painel; respeita teto, intervalo e deduplicação.
6. A Milly recebe IDs/fatos, lê as consultas existentes e decide se vale chamar o proprietário. Conversas e notas não são instruções.
7. A cada minuto, somente categorias habilitadas com assinatura ativa são consultadas. Fontes usam transação `READ ONLY`,
   timeout e limite explícito de volume. Fonte indisponível aparece como indisponível; as demais categorias continuam.
   Sinais são revalidados antes do envio, e a fila expira em 24 horas mesmo se a fonte permanecer indisponível.

O teto adia eventos; casos ainda pendentes por mais de 24 horas são cancelados para não gerar alertas antigos.
Reinícios preservam assinaturas e filas. O bloqueio de remetente usa transação aberta com advisory lock transacional,
compatível com pooler Supabase: antes de cada envio, a conexão que mantém o bloqueio é conferida.
Se a assinatura expirar ou for desconectada, não há replay desse intervalo (`cursor=null`). Reconexão cria nova geração;
fila da geração anterior nunca é reenviada. Histórico técnico encerrado fica por sete dias.
As consultas periódicas podem avisar sobre entregas e outros casos ainda pendentes no momento da assinatura; não reconstituem eventos históricos.

## Configuração

Aplicar `db/migrations/0275_dot_events.sql` e `db/migrations/0276_dot_alert_controls.sql` pelo processo de migrations do projeto, antes do deploy dependente.
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

Horas iguais desligam o silêncio. As variáveis são valores iniciais. Após salvar no painel, prevalecem as preferências do banco.
Em **Avisos do assistente**, o proprietário pode pausar tudo, escolher categorias, limites, horário e exceção para falha de entrega.
Os limites são propostas ajustáveis, não regras comerciais preexistentes.
`GET/PUT /admin/api/dot/alerts` exigem sessão humana de proprietário; PUT exige mesma origem, schema estrito e versão atual.
Histórico privado imutável registra autor/versão/preferências. Pausa ou desativação cancela envios pendentes.
O dono configura os avisos no painel. O publicador e o financeiro têm permissões próprias em **Permissões da Milly**. Ligar uma categoria não cria assinatura no Dot.
A chave deve ser gerada no ambiente seguro e guardada nos secrets do Coolify, nunca no Git, logs ou conversa.
Preservar a chave entre deploys. Trocar a chave exige desligar eventos e refazer assinaturas, ou uma migração de recifragem.
O boot com eventos solicitados valida chave e tabelas. Configuração incompleta bloqueia apenas os eventos:
o servidor continua disponível, registra `dot_events_disabled` com motivo seguro e não anuncia a capacidade de eventos.
`consultar_acompanhamento_matriz` permanece disponível quando a flag foi solicitada e informa a indisponibilidade,
sem expor segredos nem inventar contadores. Corrigir as variáveis exige redeploy/reinício para uma nova validação.
`DATABASE_POOL_MAX` deve ser pelo menos 2 (padrão do projeto: 10), pois uma conexão mantém o bloqueio do worker.

## Ativação e prova real

1. Aplicar a migration, configurar chave, habilitar flag e fazer deploy pelo Coolify.
2. Atualizar as ferramentas do plugin Farejador. Na versão 1.8.0, conferir dez eventos e as ferramentas de pendências internas.
3. No próprio Dot Milly, pedir assinatura para uma conversa escolhida, com `ids` contendo o UUID de `core.conversations`.
   Para entregas, usar UUID de `commerce.orders`. `ids:[]` não acompanha nada. Ausência do filtro acompanha novos acontecimentos.
4. Confirmar `server/discover`, `events/list`, assinatura, verificação de callback e presença da assinatura na consulta de acompanhamento.
5. Usar um atendimento controlado autorizado e verificar: atualização agrupada chega, a Milly consulta o histórico e fica silenciosa
   quando não há decisão; pendência real produz um aviso útil; resposta posterior cancela aviso ainda na fila.
6. Pedir para parar o acompanhamento. Confirmar `events/unsubscribe` e ausência de novos envios.
7. Só ampliar para todas as conversas após conferir a qualidade do piloto.
8. Para as categorias novas, habilitar no painel e solicitar a assinatura correspondente à Milly.
   IDs dos sinais são UUIDs determinísticos do caso, informados no evento; não são IDs de cliente.

Conectar o plugin sozinho não assina eventos. Um `2xx` do webhook prova apenas recebimento pelo ChatGPT;
o sucesso ponta a ponta depende de observar a análise da Milly. Testes locais usam receptor simulado e não provam esse passo.

Instrução inicial sugerida para o piloto:

> Acompanhe os eventos desta conversa no Farejador. Consulte o histórico completo e os registros necessários antes de concluir.
> Organize as pendências e os rascunhos por conta própria. Avise-me do que fez de relevante e quando precisar de uma decisão minha.
> Se precisar comprar, movimentar estoque, registrar dinheiro, publicar ou falar com alguém, mostre a proposta e aguarde minha autorização.
> Não anuncie cada atualização, não envie avisos de que tudo está bem e não repita casos sem piora ou informação relevante.
> Se eu disser que já estou cuidando, pare de cobrar esse caso. Não responda a clientes nem altere registros comerciais.

Para excluir casos no próprio servidor, substituir a assinatura anterior por uma com `ignorar_ids`; alterações de filtros geram
outra identidade de assinatura, então é necessário encerrar a anterior. O controle de notificação e memória da Milly continua no ChatGPT.

## Piloto privado de negociação

A atendente responde pelo fluxo habitual. Depois, a Milly pode avaliar uma objeção e guardar o que teria feito. O dono consegue comparar a proposta dela com a mensagem pública que a atendente enviou naquele turno. Só o conector privado do dono oferece as ferramentas do piloto.

**Teste local do piloto**

Com as dependências instaladas e Docker disponível, rode `npx vitest run --config vitest.integration.config.ts tests/integration/dot-negotiation-shadow.integration.test.ts`. Em máquinas com PostgreSQL portátil, a variável `FAREJADOR_TEST_POSTGRES_BIN` pode apontar para a pasta de binários da versão 17. O teste cria seu próprio banco temporário, simula o destinatário do evento e usa um parecer de teste para verificar o que o sistema permite registrar e comparar.

**Para experimentar em homologação**

1. Use um ambiente com banco, conta e conversas sintéticos. Aplique a migration `0295_dot_negotiation_shadow.sql` pelo processo usual. Configure a conta Chatwoot do ambiente, o acompanhamento por eventos e `DOT_NEGOTIATION_SHADOW_CONVERSATIONS` com até 50 UUIDs de `core.conversations`, separados por vírgula. Lista vazia, asterisco ou UUID inválido desativam o piloto inteiro.
2. Reinicie o serviço e atualize o conector da Milly. Em **Avisos do assistente**, habilite o acompanhamento do atendimento. Confirme uma assinatura ativa de `farejador.conversa.atualizada` para as conversas escolhidas. A Milly reconhece um evento do piloto pelo campo `sombra_negociacao` igual a `true`.
3. Em uma conversa de teste, faça uma oferta como “faz R$ 80 nesse pneu com entrega?”. Com o evento recebido, a ferramenta `consultar_contexto_negociacao_sombra` identifica o turno e recorta o histórico até a pergunta. A Milly considera os dados que consegue confirmar e pode manter o preço, aceitar, fazer contraproposta ou aguardar um dado. Ao oferecer um valor, registra o total e a modalidade de entrega ou retirada. O parecer fica associado à mensagem que motivou o turno, inclusive se a conversa prosseguir enquanto a Milly avalia.
4. No privado, peça à Milly **“Me mostra a proposta do cliente, o que a atendente respondeu e o que você teria feito. Explica o motivo.”** Ela lista os pareceres com `consultar_negociacoes_sombra` e usa as referências de turno e mensagem para ler a conversa original. Se a resposta ainda estiver aguardando registro do Chatwoot, a comparação fica pendente. Cada turno guarda o primeiro parecer recebido.
5. Para desativar apenas o piloto, esvazie `DOT_NEGOTIATION_SHADOW_CONVERSATIONS` e reinicie o serviço. Os pareceres acompanham o descarte dos eventos pelo monitor, normalmente após sete dias. A anonimização do contato também remove os pareceres relacionados.

O monitor agrupa eventos. Alguns turnos podem não gerar parecer e o tempo até o registro inclui esperas da fila. A Milly é orientada a ler a resposta da atendente só depois de registrar sua alternativa. O acesso de proprietário também permite consultar o histórico integral, o que limita o uso deste piloto como avaliação às cegas. A comparação mostra diferenças nas propostas. Para medir se uma delas fecharia mais vendas ou se um desconto chega intacto à cobrança, é necessário um teste específico de fechamento.

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

## Consultar a Milly no atendimento de varejo da Matriz

Em **Matriz → Bot → Visão geral** ou **Conversas**, o proprietário usa **Consultar a Milly** e **Parar consultas à Milly**. A configuração começa desligada, vale por ambiente e persiste entre reinicializações. O controle usa a sessão do proprietário. O painel também indica a disponibilidade da conexão com o Dot.

Para receber consultas, a instalação precisa da migration `0296_milly_consulta_comercial.sql`, da atendente V2 com envio pela outbox e do MCP com eventos. A conexão do proprietário deve ter uma assinatura verificada de conversas que cubra a conversa em atendimento. Duas assinaturas elegíveis para a mesma consulta tornam o destino ambíguo. A atendente segue pelo catálogo nesse caso.

Com o controle ligado, a atendente pode pedir uma decisão sobre um pneu da Matriz. O evento identifica a consulta. No MCP, a Milly lê a ficha por `consultar_negociacao_atendente` e responde por `orientar_negociacao_atendente`. A ficha traz a variante, o saldo, as reservas, o giro e o custo disponíveis naquele momento. Para entrega, o histórico de viagens ajuda na análise. Um desconto em entrega exige comprovação do custo de acrescentar a parada. Quando essa informação falta, a Milly pode orientar a atendente a oferecer a avaliação de retirada.

A Milly vê quantas entregas em rotas abertas têm o mesmo município cadastrado e quantas estão sem município. A ficha identifica quando a cidade veio do roteamento ou de uma referência recente da conversa. As médias financeiras de viagens encerradas incluem o número de viagens com registro. Os custos informados permitem avaliar a contribuição direta antes das taxas de pagamento e despesas fixas.

A consulta tem prazo de 50 segundos. A indisponibilidade do Dot e o fim desse prazo devolvem a negociação ao fluxo habitual. Uma oferta aprovada tem validade de 30 minutos e vale para a loja, produto, quantidade, pagamento e modalidade indicados. A publicação tem confirmação pela outbox do Chatwoot ou pelo eco da mensagem com o mesmo conteúdo autorizado. Se o cliente responder depois do vencimento, a atendente apresenta as condições atuais e pede novo aceite antes de fechar pelo preço de tabela.

**Para interromper**, use **Parar consultas à Milly**. A pausa impede novas condições e invalida pareceres ainda pendentes. Uma oferta válida e já comunicada continua disponível para aceitar e fechar o pedido nas condições anunciadas. O preço de tabela continua servindo aos demais clientes. O controle afeta a negociação comercial da atendente e pode ser operado independentemente do monitor geral de eventos.

## Monitor externo de queda total

Código preparado, **não hospedado automaticamente**. Rodar a cada minuto em host diferente do Farejador:

```sh
node --env-file=/caminho/protegido/farejador-monitor.env dist/admin/dot/events/external-cli.js
```

O arquivo protegido utiliza a configuração existente de ambiente, banco, OAuth e chave de eventos. Nunca versionar credenciais.
Para uma única verificação, acrescentar `--once`. O processo não inicializa os workers comerciais nem o servidor HTTP.
Faz GET somente no `/healthz` da origem configurada, com DNS público fixado, TLS, sem redirects e com timeout.
HTTP 200 `ok`/`degraded` significa serviço acessível; 503, timeout ou resposta inválida contam como falha.
O padrão exige três falhas consecutivas; uma pausa maior que três minutos reinicia a contagem. Recuperação cancela aviso pendente.
Compartilha o bloqueio de envio com o worker normal e entrega somente seu próprio sinal de saúde.
Verificação antiga não confirma monitor ativo; conferir data no painel. Se banco, rede externa ou receptor também estiverem fora,
esse caminho não garante entrega: é necessário um monitor independente com outro canal para cobrir essa falha conjunta.

Referências: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events),
[MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic).
