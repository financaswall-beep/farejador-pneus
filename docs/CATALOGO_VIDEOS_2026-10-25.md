# Fotos e vídeos do catálogo da Matriz

O catálogo aceita fotos e um vídeo ativo por pneu, vinculados ao produto exato. O painel web e o app de operação usam a mesma seção **Catálogo → Fotos e vídeos para o bot**. O fluxo dos parceiros permanece separado.

## Uso

1. Escolher o pneu por medida e marca.
2. Fotografar/escolher uma imagem ou gravar/escolher um vídeo de até 15 segundos.
3. Aguardar o processamento e conferir a prévia. A marca 2W é aplicada por código.
4. O controle de uso no atendimento permite ou pausa fotos e vídeo daquele produto.

A assinatura dos novos envios combina o logo 2W, o ícone do WhatsApp e **(21) 97250-9411** em uma faixa verde no canto inferior direito. Logo e letras usam curvas vetoriais, sem fontes instaladas no container; o tamanho acompanha a mídia e preserva uma margem nas bordas. A alteração vale para novos processamentos. Fotos e vídeos já guardados mantêm a marca existente, e não há migration ou variável adicional.

Novas fotos guardam somente o WebP final, com até 1.600 pixels em cada lado. Os originais antigos continuam disponíveis; nenhuma limpeza de arquivos históricos é executada pela migration.

Vídeos aceitam MP4/MOV/WebM de até 80 MiB. A conversão preserva a orientação e a proporção dos vídeos comuns de celular, limita a resolução a 1.280 × 720 ou 720 × 1.280, e produz MP4/H.264 com áudio AAC quando presente. O original existe somente em diretório temporário do processo, removido no encerramento, inclusive em falha. Somente o MP4 final, limitado a 8 MiB, vai ao bucket privado `farejador-matrix-catalog-videos`.

Arquivos substituídos são desativados no catálogo; seu histórico não é apagado. Falhas anteriores à confirmação no banco tentam remover somente o objeto novo. Se o resultado do COMMIT ficar incerto, o arquivo é preservado para não apagar mídia que possa estar em uso.

## Drive e atendimento

A pasta opcional de cada pneu aceita `principal.jpg`, `lateral.jpg`, `detalhe.jpg` e um `video.mp4`, `video.mov` ou `video.webm`. A identidade de importação continua somente leitura. Nenhuma pasta é descoberta por nome ou vinculada automaticamente a outro produto.

O bot usa `pedir_video` apenas quando o cliente solicita vídeo da Matriz ou do produto já escolhido nela. A galeria funciona fora do expediente; não confirma estoque, reserva ou estado atual de um exemplar. Sem vídeo, o bot oferece foto. Os dois pneus escolhidos podem ser consultados juntos, com resultado individual. A outbox preserva deduplicação, pausa humana, guarda após retomada e revogação de mídia substituída/desativada. O vídeo segue como anexo MP4 no Chatwoot.

## Publicação

1. Aplicar **0279_matrix_catalog_videos.sql** antes de publicar o novo código. Ela cria a tabela privada, mantém os gatilhos de ambiente e habilita `video_attachment` na outbox; `original_path` passa a aceitar NULL para novas fotos.
2. Publicar a versão nova. Não há variável adicional: o recurso acompanha `MATRIZ_CATALOG_PHOTOS_ENABLED`, as credenciais de Storage e as flags de envio já existentes.
3. A imagem Docker já inclui FFmpeg/FFprobe. O build verifica H.264 e a opção de orientação necessária. O processamento reutiliza o executor com limites de tempo, memória e CPU já utilizado pelo publicador, sem shell nem acesso a URLs externas do arquivo.
4. Enviar um vídeo do próprio catálogo, conferir marca/orientação/tamanho e pedir o vídeo em conversa controlada.

O processamento não chama IA. Os custos continuam sendo CPU, armazenamento e transferência, além das chamadas normais do bot quando ele conversa.

## Verificação local

- Suíte unitária completa e testes adicionais de persistência: controle de acesso, limites, ausência de original persistido, compensação de falhas e preservação após COMMIT incerto.
- Integrações em PostgreSQL 17 descartável: fotos e vídeos, isolamento, lote parcial, idempotência, pausa humana, retomada, substituição e envio MP4.
- Encoder real: MOV de 15 s com áudio passou de 37.544.933 para 3.235.687 bytes; também foram verificados MP4 vertical, WebM e MP4 com rotação na matriz de exibição. Esse resultado é uma amostra técnica, não uma garantia de tamanho para qualquer gravação.
- Marca inspecionada em frame gerado pelo encoder. Nenhum dado ou arquivo de produção foi alterado por essas verificações.
- Telas web e app conferidas em 390 e 1.280 pixels, incluindo upload, estado de processamento, prévia privada e ausência de rolagem horizontal.

Referências técnicas: [FFmpeg — opções de vídeo e orientação](https://ffmpeg.org/ffmpeg.html), [filtros](https://ffmpeg.org/ffmpeg-filters.html) e [Storage privado](https://supabase.com/docs/guides/storage/buckets/fundamentals).
