# Apuração dos gastos do Bot — GPT-5.6 Sol

O painel substitui a tarifa genérica de R$ 5,50 por milhão de tokens pela estimativa de cada chamada à Responses API. Esta mudança não troca o modelo, o raciocínio, o prompt ou as ferramentas do atendimento.

Preços Standard consultados em 17/09/2026: por milhão de tokens, US$ 4 de entrada comum, US$ 0,40 de leitura de cache, US$ 5 de gravação de cache e US$ 20 de saída. Acima de 272 mil tokens de entrada por chamada, aplica-se o multiplicador oficial de 2 na entrada e 1,5 na saída. Tokens de raciocínio já integram a saída e não são somados novamente. A OpenAI informa preços promocionais pelo menos até 21/11/2026; revisar a tabela quando houver mudança.

Fontes: [modelo](https://developers.openai.com/api/docs/models/gpt-5.6-sol) e [cache](https://developers.openai.com/api/docs/guides/prompt-caching).

## Comportamento

- Registra todas as rodadas com ferramentas e cada tentativa HTTP, inclusive resposta incompleta, descartada, encaminhamento humano e timeout. Não depende de o texto ter sido enviado ao cliente.
- Guarda apenas identificadores e metadados de consumo em `ops.bot_model_usage`, sem prompts, mensagens, argumentos de ferramentas ou raciocínio. A identidade da resposta impede cobrança duplicada na estimativa.
- Entrada comum = entrada total − cache lido − cache gravado. Apura o preço por chamada, antes de somar por dia, na data civil de São Paulo.
- Modelo/tier sem tarifa cadastrada, uso incompleto e falha de transporte ficam com custo desconhecido. O card mostra apuração incompleta e subtotal conhecido, sem transformar a ausência de medição em custo zero. Turnos antigos sem medição detalhada também ficam pendentes.
- Sol e o alias `gpt-5.6` usam a mesma tarifa. Outros modelos não herdam preços do Sol. O nível de serviço considerado é `default`; não estimar Priority/Flex/Scale com tarifa Standard.
- Conversão em reais usa `OPENAI_USD_BRL`, com referência inicial **5,50**, explicitada na interface. É uma referência configurável, não cotação atual nem valor exato do cartão. O câmbio é gravado em cada chamada; mudar a configuração não recalcula o passado.
- Resumo, Bot e Rede consultam a mesma base. Os custos ficam separados do faturamento e do livro financeiro.
- Falha ao persistir telemetria gera aviso no log, sem repetir a chamada de IA ou impedir o atendimento. Para conciliar valores exatos, usar a fatura/Usage da OpenAI; interrupção abrupta do processo e chamadas sem resposta podem impedir a apuração completa. O card não inclui outros sistemas, transcrição/áudio, Google, WhatsApp, impostos ou spread cambial.

## Publicação

1. Aplicar `0239_bot_provider_usage_cost.sql` com o executor oficial e manifesto conferido.
2. Publicar o backend e os arquivos do painel juntos. Manter `OPENAI_MODEL=gpt-5.6-sol`; configurar `OPENAI_USD_BRL` se a referência de 5,50 não for a desejada.
3. Conferir uma conversa real pelo uso reportado, cache, total USD e referência BRL. Não reintroduzir os testes apagados em produção para validar esta mudança.

A migração não recria dados apagados nem altera pedidos, estoque, financeiro, regras de atendimento ou triggers existentes. Aplicada em produção em 17/09/2026 às 23:52 (America/Sao_Paulo), pelo executor oficial: versão 239 e checksum conferidos, contagens operacionais preservadas e verificações financeiras sem divergências. A ativação da nova medição depende da publicação do backend e do painel. Evidência local: `artifacts/bot-cost-migration-apply.json`. Em próximas limpezas operacionais, inventariar também `ops.bot_model_usage`; os executores antigos abortam ao detectar a nova tabela/versão.

## Validação local

- 60 testes unitários passaram: tarifas, leitura/gravação de cache, limite de contexto longo, ausência de medição, transporte, retries, interface e consultas relacionadas.
- 17 testes de integração distintos passaram em PostgreSQL local descartável: migrações, persistência/deduplicação, isolamento de ambientes, permissões, chamadas incompletas, datas e consistência dos cards. Nenhuma chamada paga à OpenAI nem mensagem ao Chatwoot foi feita para esses testes.
- TypeScript, manifesto das 240 migrations e whitespace conferidos.
- A checagem global de tamanho acusa nove arquivos preexistentes; todos estão idênticos ao `HEAD` e fora desta alteração. Evidência local: `artifacts/bot-cost-size-baseline.json`. A consulta compartilhada evita ultrapassar o limite nos arquivos alterados.
