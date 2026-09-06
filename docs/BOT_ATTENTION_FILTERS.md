# Fila de atenção — períodos (06/09/2026)

## Comportamento

- Padrão: **Todas as pendentes**, sem vencimento automático por idade.
- Filtros opcionais: últimos 7, 15 ou 30 dias corridos, pela última mensagem do cliente ou atualização do atendimento.
- O aviso informa quantas pendências ficaram fora do período, independentemente da busca/situação. “Ver todas as pendentes” remove apenas o filtro de período.
- Conversas sem data comprovada continuam visíveis. Busca por nome/texto e filtro de situação continuam disponíveis.
- Uma linha por conversa, mais antigas primeiro, páginas de 20 itens. Paginar não descarta o restante nem muda o total.
- Fotos, origem e botão azul do controle automático permanecem. Falha na atualização mantém a última fila confirmada com aviso.

## O que é pendência

- Espera: última mensagem pública do cliente com pelo menos 5 minutos, ainda sem resposta do bot confirmada (`delivered`/`sent_api_ack`) cobrindo o gatilho, nem resposta humana pública posterior não falha.
- Mensagens próprias correlacionadas à outbox/turno não contam como intervenção humana. Uma resposta sobre um gatilho antigo não encerra a espera por uma pergunta nova.
- Encaminhamento: fato ativo `escalou=true`, sem expiração de 48h; retomada explícita posterior encerra esse encaminhamento antigo, mas não marca mensagens como respondidas.
- Atendimento humano permanece enquanto o controle estiver em `human`. A lista consulta também a última mensagem do cliente para não ocultar atividade recente em uma pausa antiga.
- Conversas resolvidas ou apagadas no Chatwoot ficam fora da fila. Nenhum desses filtros retoma o bot.

## Implantação e segurança

Sem migration e sem variáveis novas. Publicar backend e painel juntos; os dois scripts alterados têm versão de cache nova.

As consultas continuam somente leitura e separadas por `environment`. Não há reprocessamento, disparo de mensagens, alteração de controle ou mudança nas regras de envio da Meta. Os limites silenciosos de 20/10/200 registros foram removidos; a paginação é apenas visual. A consulta da última mensagem usa o índice existente por conversa/data, sem criar uma fila persistida paralela.

Validação: testes unitários de filtros/limites/paginação/mesclagem/falha de rede; integração PostgreSQL isolada com pendências antigas, 201 conversas, respostas humanas/bot, retomada, resolução, privacidade e separação de ambientes; regressão dos canais e do handoff silencioso.
