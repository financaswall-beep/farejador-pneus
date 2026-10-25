# Fotos da Matriz para o bot

Implementação de 25/10/2026. A galeria é exclusiva da Matriz. O pedido de foto aos parceiros continua no fluxo existente.

## Tela e operação

No Catálogo, a aba **Fotos para o bot** oferece busca por medida/marca/modelo, filtros de fotos ausentes/prontas/com erro,
cadastro por câmera ou galeria, três ângulos opcionais, escolha da principal, pausa do uso pelo bot e prévia do envio.
“Testar envio” abre uma prévia; não manda mensagem a clientes reais.
Ela está disponível no painel web e no Catálogo do app `/operacao`, com o mesmo cadastro e as mesmas regras.
O painel usa a sessão owner da Matriz; o app usa o Bearer `cs_` e exige proprietário, além da permissão de Estoque.
As imagens do app são lidas autenticadas e exibidas por URLs Blob locais, sem token na URL ou links públicos.

Uma foto basta. O sistema não inventa ângulos. Cada arquivo passa por validação, orientação, limite de pixels,
remoção de EXIF/GPS, redução e conversão para WebP. Guarda uma cópia sem marca e uma derivada com “2W”.
A marca usa curvas vetoriais e dispensa fontes no container. Fotos já processadas mantêm o arquivo existente;
o desenho corrigido é aplicado nos novos uploads/importações e nas substituições.
O bucket `farejador-matrix-catalog` é privado; somente rotas owner autenticadas servem as imagens no painel.
Os tokens do Supabase e do Google nunca são enviados ao navegador.
Substituir uma foto preserva a versão anterior no histórico técnico privado, mas tira a versão antiga do uso no bot.

## Atendimento

A ferramenta existente `pedir_foto` continua sendo a entrada. Se o cliente pediu referência da Matriz ou o produto
já foi escolhido na Matriz, `loja=matriz` consulta a galeria habilitada do produto exato e ambiente **24 horas**,
sem exigir estoque, localização do cliente ou loja aberta. A imagem não confirma estoque, reserva ou atendimento físico.
Nos demais casos, primeiro resolve produto, localização, estoque e loja pelas regras atuais. Somente se a unidade escolhida for `main` consulta a galeria.
Com imagem, enfileira a principal ou o ângulo pedido no outbox já existente. Sem imagem/ângulo, continua e cria o
pedido de foto à loja, sujeito ao expediente. Não substitui fotos de parceiros por imagens da Matriz.

Lojas fechadas não encerram o atendimento do bot: consultas de catálogo mantêm os dados e retornam a situação do
atendimento presencial separadamente. O bot não deve transformar ausência de loja aberta em prova de estoque zerado.
Pedidos, retirada/entrega imediata e fotos novas da equipe continuam protegidos pelas regras existentes de expediente.

Pedidos de foto atual, de exemplar ou de desgaste/sulcos seguem para a loja. A legenda da galeria diz explicitamente
que é referência do modelo, sem comprovar o estado de um seminovo. `foto_atual=true` também força o fluxo sob demanda.
`tipo_foto` aceita principal/lateral/detalhe/todas, sendo principal o padrão. O LLM não escolhe caminhos de Storage.

Repetir a ferramenta no mesmo pedido/mensagem não duplica o arquivo no outbox. Outro pedido explícito do cliente
em mensagem nova pode receber a imagem novamente. O sender respeita pausa humana e retomada, escopo do bot,
foto retirada/substituída, uso desativado e ambiente. O histórico de fotos distingue fila de envio confirmado.
`foto_enfileirada` nunca significa entrega confirmada. A confirmação segue o ACK/reconciliação do outbox.

## Publicação

1. Aplicar `0277_matrix_catalog_photos.sql` pelo fluxo de migrations auditadas. Não há alteração de dados existentes.
2. Configurar `MATRIZ_CATALOG_PHOTOS_ENABLED=true` e publicar o código. O compose encaminha a variável.
3. Reutilizar `SUPABASE_STORAGE_URL` e `SUPABASE_STORAGE_SERVICE_KEY` já usados para fotos operacionais.
   O primeiro upload cria/valida o novo bucket privado, sem alterar o bucket dos parceiros.
4. O bot precisa das flags operacionais existentes `PHOTO_REQUESTS=true`, `BOT_OUTBOX=true` e do escopo de conversas
   autorizado. A tela informa quando a galeria está disponível mas o envio pelo bot ainda não foi ativado.

Desativar a flag nova impede novas consultas e o envio de anexos de catálogo ainda pendentes. Fotos sob demanda
continuam sendo tratadas pelo fluxo existente. A migration é aditiva e não precisa ser revertida para desligar a galeria.

## Google Drive opcional

O servidor usa uma **conta de serviço dedicada** com escopo `drive.readonly`; não utiliza a conexão do plugin ChatGPT
nem depende de VS Code aberto. Não há delegação de usuário nem permissão de escrita no Drive.

1. No projeto Google Cloud, habilitar a Drive API, criar a conta de serviço e gerar sua chave JSON.
2. Guardar o JSON completo apenas na variável secreta `MATRIZ_PHOTOS_DRIVE_SERVICE_ACCOUNT_JSON` do servidor.
   Não colocar esse JSON em Git, mensagens ou formulários do painel. Essa é a única credencial adicional do Drive.
3. No app, abrir o pneu → **Importar automaticamente do Google Drive**. O painel mostra o e-mail da conta de serviço.
4. Criar uma pasta exclusiva desse pneu e compartilhá-la com esse e-mail como **leitor**.
5. Colocar `principal.jpg`, `lateral.jpg` e/ou `detalhe.jpg` (também PNG/WebP). `frontal`, `frente` e `traseira` são aliases.
6. Colar o link da pasta no cadastro do produto e ligar a importação automática. Não é necessário cadastrar três arquivos.

O worker roda no mesmo processo, verifica uma pasta por vez e espaça verificações de cada vínculo por pelo menos um
minuto. Em volume maior a rodada pode demorar mais. Consulta apenas filhos diretos da pasta vinculada; não percorre
todo o Drive. Pastas com mais de 100 imagens ou ângulos duplicados exigem ajuste e aparecem como erro, sem apagar a foto atual.
Nomes não reconhecidos não são associados automaticamente. Alteração de pasta/versão durante a importação cancela
a publicação daquele resultado. Arquivos são deduplicados, a integridade MD5 é conferida e falhas de rede tentam na próxima rodada.
Excluir arquivo do Drive não apaga uma foto já cadastrada. Para suspender seu envio, desative o uso no atendimento.

API oficial: [busca por pasta](https://developers.google.com/workspace/drive/api/guides/search-files) e
[download de imagens](https://developers.google.com/workspace/drive/api/guides/manage-downloads).

## Validação local

Há testes de codec/marca d’água, URLs e nomes do Drive, autenticação somente leitura, integridade/limites,
RLS e separação de ambiente/produto/unidade, substituição, dedup por mensagem, pausa humana,
versão concorrente, retomada, histórico do outbox e ferramenta completa com fallback à Matriz.
As telas são verificadas com dados fictícios em Chrome headless, tanto em desktop quanto em celular.

Resultado local desta entrega: 3.526 testes unitários, 24 testes de integração nas três suítes de fotos/pedidos,
build TypeScript/CSS, provas do painel (incluindo pools e 571 rotas), manifesto de migrations e verificação visual
do painel e do app aprovados. A verificação do app inclui upload, imagens autenticadas, prévia e exclusão de parceiros.

Ativação real do Drive e envio em WhatsApp dependem da configuração externa e de teste após publicação.
