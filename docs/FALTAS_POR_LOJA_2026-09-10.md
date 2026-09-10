# Faltas por loja — 10/09/2026

Tela em **Bot → Faltas por loja**, conforme o modelo aprovado. A aba Demanda e estoque mantém seu mapa e agora também oferece um atalho para o relatório.

## Interação

- Semana (segunda a domingo), mês e intervalo personalizado de até 366 dias. Datas e horários em São Paulo; períodos futuros recusados.
- Resumo geral e ranking das lojas representam o período inteiro. Clicar em uma loja filtra as medidas e as consultas. O chip ou “Todas as lojas” remove o filtro.
- A busca textual filtra medidas. Selecionar uma medida abre as consultas que tiveram indisponibilidade nela e na loja filtrada.
- Cada consulta preserva todas as lojas observadas, inclusive as que tinham disponibilidade. Os parceiros aparecem na ordem usada na busca de estoque por proximidade, quando disponível; a Matriz aparece ao final. A leitura dos parceiros é feita em conjunto, não uma sequência inventada de chamadas individuais.
- Prévia de três consultas e lista paginada em blocos de vinte. CSV respeita período, loja e busca de medida, limita a dez mil registros e neutraliza fórmulas de planilha.
- Estados distintos de carregamento, erro, ausência de dados e ausência de medida no filtro. Proteção contra respostas fora de ordem ao trocar rapidamente de loja/período.

## Fonte e contagem

A migration `0224_bot_stock_searches.sql` cria `ops.bot_stock_searches`. O registro é determinístico, imutável e separado por ambiente; guarda medida, filtros de produto, município e disponibilidade por loja, com referência interna à conversa/mensagem. Não copia mensagens, telefone, endereço ou coordenadas.

O coletor observa os resultados que `buscar_produto` e `buscar_compatibilidade` já consultaram. Usa contexto isolado por execução e chave idempotente de job/rodada/chamada/medida. Não altera o JSON entregue ao modelo, o prompt, as regras de roteamento, o saldo ou o pedido. Falha no registro é capturada; não bloqueia a resposta normal da ferramenta. Não executa na transação de criação de pedido.

Uma falta representa **loja + medida + consulta sem oferta disponível**, respeitando os filtros e os produtos efetivamente consultados. Várias marcas da mesma medida não multiplicam a falta; basta um dos produtos consultados estar disponível na loja para ela não contar como falta. Pode ocorrer indisponibilidade por reserva ou bloqueio da oferta; não é necessariamente saldo físico zero. A Matriz só é nomeada quando a busca usou a fonte explícita do estoque unificado; o saldo legado da rede não é atribuído a ela.

“Consultas com falta” conta uma execução de busca uma vez, mesmo quando ela consulta duas medidas ou registra falta em várias lojas. “Faltas nas lojas” soma as ocorrências por loja/medida. “Lojas com falta” conta apenas lojas que tiveram indisponibilidade.

O estoque atual é mostrado separadamente: soma física por medida entre marcas/condições, sem descontar reservas. Não reconstitui o histórico. Sem linha de estoque aparece “Sem registro”.

Os facts antigos de `faltou_estoque`, ou buscas sem detalhamento por loja, aparecem como registros não incluídos nos totais detalhados. Não há backfill inventando lojas a partir do estoque atual. Falta de referência de moto/ano e ausência de produto no catálogo não geram artificialmente uma falta na Matriz ou nos parceiros.

## Validação e publicação

- Build/TypeScript e 1.781 testes unitários em 335 arquivos aprovados.
- Quatro testes do relatório em PostgreSQL 17 temporário: contagens, fuso, ambientes, filtro com consulta completa, estoque atual, CSV, idempotência, imutabilidade, acesso negado ao parceiro e resposta da ferramenta real preservada.
- Dezesseis testes existentes de demanda e pedidos do bot aprovados, incluindo Matriz/parceiro e reservas idempotentes.
- Provas visuais com HTML e módulos reais, APIs fictícias locais: `scripts/prova-bot-faltas-ui.cjs` e `scripts/prova-bot-demanda-ui.cjs`. Desktop/celular, erro, vazio, recuperação, clique, concorrência e exportação; sem consultas externas nesses testes.
- Os verificadores gerais ainda têm nove divergências preexistentes de Catálogo/Clientes no baseline e violações antigas de tamanho. Os novos módulos estão abaixo de 300 linhas; a consulta de saldo por município foi extraída sem mudança de SQL para manter `fulfillment.ts` dentro de seu teto.

Em 10/09/2026 a migration 0224 foi validada com rollback e aplicada no banco novo de produção em São Paulo pelo executor oficial. Versão 224 e checksum confirmados, tabela inicialmente vazia. Nenhuma configuração do bot ou estoque alterada. Sem variável nova. O registro de buscas começa após o deploy desta versão; deploy realizado pelo usuário.
