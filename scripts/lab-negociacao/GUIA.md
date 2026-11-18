# Conversar com a atendente e a Milly no laboratório

Abra [o laboratório neste computador](http://127.0.0.1:4328/). Se o computador tiver reiniciado, dê dois cliques em `abrir-laboratorio.cmd` nesta pasta e mantenha a janela aberta. O serviço escuta somente no endereço local. O servidor usa o mesmo cliente da API Responses da atendente. A chave informada na página fica na memória até o processo encerrar. As chamadas ao modelo usam o saldo da conta vinculada à chave.

## Primeiro atendimento

1. Conecte a chave na página e escolha **Estoque alto e rota confirmada**.
2. Na conversa pública, escreva “Estou no Centro. Tem um pneu novo 110/70-13 pra retirar? Quanto fica no Pix?”.
3. Depois da cotação, escreva “Achei caro. Faz por R$ 80 pra eu buscar?”. A objeção abre uma consulta privada. A caixa **Ouvir a Milly neste turno** também permite pedir o parecer em qualquer mensagem.
4. Na opção manual, copie a consulta para a conversa da sua Milly no ChatGPT. Cole o JSON que ela devolver no campo de parecer. Na opção automática, abra **Conectar minha Milly no Chrome** e siga o pareamento com a aba da Milly. A conversa pública mostra a resposta da atendente depois que o parecer chega. **Continuar sem parecer** permite ouvir o bot sozinho.
5. Compare com o cenário de **últimas unidades**, usando a medida **140/70-17**. O laboratório tem uma unidade fictícia de atendimento no bairro Centro.

## O que é real nesta comparação

O modelo de texto configurado é `gpt-6.1-sol`, observado no registro operacional do bot em 18/11/2026. O prompt, as instruções de contexto aplicáveis, as definições das ferramentas e o cliente HTTP vêm do código V2 da revisão implantada `562c1a8b` conferida nessa data. O contexto adicional com o parecer da Milly faz parte do experimento. A atendente recebe a decisão, o valor e a modalidade. A justificativa com custos fica no painel privado.

O estoque, o histórico do cliente, a rota, as respostas das ferramentas comerciais e os pedidos são de teste. O laboratório cobre conversas de texto de varejo. O verificador de preço do V2 continua exigindo o valor do catálogo fictício. Um modelo ainda pode escrever uma promessa equivocada no chat, o que a comparação permite observar. O laboratório encerra qualquer tentativa de criar pedido antes de um lançamento comercial. Ele não mede conversão nem o tempo de resposta em produção.

As opções de localização, fotos e outros recursos alteram partes do prompt e a lista de ferramentas. A página identifica o perfil em uso. Para reproduzir também as opções do processo instalado, um operador com acesso ao terminal da aplicação pode obter este JSON somente de leitura e colá-lo em **Usar configuração da instalação**.

```sh
node --input-type=module -e "import {env} from './dist/shared/config/env.js'; const ks=['ROUTING_GEO','PHOTO_REQUESTS','DELIVERY_FREIGHT_FROM_PIN','BOT_AUDIO_ENABLED','PARTNER_STOCK_CONFIRMATION','BOT_OUTBOX','MATRIZ_CATALOG_PHOTOS_ENABLED','AGENT_V2_MAX_OUTPUT_TOKENS']; console.log(JSON.stringify(Object.fromEntries(ks.map(k=>[k,env[k]]))))"
```

Use somente diálogos fictícios. Na ponte automática, a extensão atua na aba do ChatGPT que você seleciona e o ChatGPT recebe a ficha e o diálogo enviados para avaliação. A ponte depende dos controles visíveis do site. Se a página mudar ou a sessão vencer, o painel também aceita o parecer por cópia e colagem.
