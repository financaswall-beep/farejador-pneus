# Cache e custo do bot GPT-6.1

O modelo continua `gpt-6.1-sol`, com o mesmo esforço de raciocínio, ferramentas, limite de saída e carregamento de histórico. Esta alteração não resume nem corta mensagens. Cache reaproveita processamento do prefixo; não é a memória do cliente.

## Regras fixas e contexto

No 6.1, o primeiro bloco `developer` contém apenas `SYSTEM_PROMPT` e os blocos estáveis de localização/fotos habilitados. Ele recebe `prompt_cache_breakpoint: { mode: 'explicit' }`, com `prompt_cache_options: { mode: 'explicit', ttl: '30m' }`. As definições fixas das ferramentas também precedem esse ponto no contexto do provedor.

O segundo bloco, de igual prioridade, mantém o contexto variável na mesma ordem anterior: cadastro, memória comercial, origem, áudio, localização, foto solicitada, escolhas atuais e confirmação vigente de estoque. Depois seguem todas as mensagens carregadas, chamadas de ferramentas e resultados. Endereço, correções, quantidade e pagamento continuam disponíveis; não entram no prefixo fixo. As regras existentes mandam aproveitar dados já informados e confirmar o endereço de uma compra anterior antes de reutilizá-lo.

Entre rodadas de ferramentas, o estado efêmero mantém também os outputs opacos e o reasoning criptografado, como antes. `store: false` permanece. Não há novo armazenamento de conversas, chave por cliente ou aquecimento pago. Outros modelos mantêm o formato e o cache implícito anteriores.

## Medição

O medidor passa a reconhecer 6.1 e snapshots datados, no tier `default`. Preços standard em USD por milhão de tokens, conferidos em 25/10/2026:

| Componente | Até 272 mil tokens de entrada por chamada | Acima de 272 mil |
|---|---:|---:|
| Entrada comum | 2,00 | 4,00 |
| Leitura de cache | 0,10 | 0,20 |
| Gravação de cache 30m | 2,50 | 5,00 |
| Gravação de cache 12h | 5,00 | 10,00 |
| Resposta, incluindo reasoning | 10,00 | 15,00 |

`input_tokens` já inclui leitura e escrita de cache. Entrada comum é a diferença; cada componente é cobrado uma vez. Quando o provedor distingue TTLs de escrita, o cálculo usa essa divisão. Sem preço/tier/contadores conhecidos, o custo continua pendente. As tarifas do 6 e do 5.6 permanecem.

O painel **Bot → Custo do bot → Detalhar em US$** mostra os quatro componentes das novas chamadas com preço verificável. Só agrega registros da versão atual cuja soma confere com o custo gravado. Registros antigos, ausentes ou com retenção não reconstruível ficam fora do detalhamento e são sinalizados; seus totais originais não são reescritos. O total do painel mantém o câmbio de referência de cada chamada. Não são valores de faturamento da OpenAI nem incluem impostos/spread.

## Publicação e comparação

Sem migration e sem variável nova. Faça o deploy do código mantendo o modelo atual. A primeira chamada de um prefixo e chamadas após sua expiração ainda podem pagar gravação; mudanças nas ferramentas/regras geram outro prefixo. Não há percentual de economia garantido.

Validação local usa respostas simuladas e PostgreSQL descartável, sem gasto com OpenAI. Depois do deploy, use chamadas normais para comparar tarefas equivalentes, primeira chamada e reutilização. A auditoria abaixo só lê metadados agregados e não aciona o bot:

```powershell
npx tsx --env-file=<arquivo-local-com-DATABASE_URL> scripts/auditar-cache-bot.ts prod 2026-10-25 2026-10-26
```

As datas são inclusivas no horário de São Paulo. O script separa dia, modelo, tier, versão do preço e presença de leitura de cache, mostrando tokens, média e custo conhecido em USD. `null` não significa zero. Não compare chamadas de tarefas diferentes como se fossem uma medição controlada. O histórico antigo do 6.1 sem estimativa permanece sem estimativa.

Fontes: [cache de prompts](https://developers.openai.com/api/docs/guides/prompt-caching), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
