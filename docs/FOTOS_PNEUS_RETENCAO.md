# Fotos de pneus: armazenamento e retenção

- Aplicar `0270_tire_photo_storage_retention.sql` antes do deploy. O boot confere o schema.
- Reutiliza `SUPABASE_STORAGE_URL` e `SUPABASE_STORAGE_SERVICE_KEY`, somente no servidor.
- Com Storage configurado, o worker cria/verifica o bucket privado `farejador-tire-photos` (2 MiB por arquivo, JPEG/WebP). Não usa o bucket de marketing.
- Celular reduz a imagem a 1200 px e faz PUT por URL assinada específica. API recebe somente UUIDs; a conexão do parceiro continua restrita por RLS.
- Worker determinístico processa um arquivo por vez no mesmo container. Confere bytes reais, aplica orientação, elimina EXIF/GPS e guarda WebP de qualidade 82, até 1200 px. WhatsApp recebe JPEG gerado na memória; não se guarda uma segunda versão final.
- Banco conserva vínculo com solicitação/pneu/unidade/ambiente, MIME, tamanho, dimensões e SHA-256. Anexos antigos migram gradualmente, preservando leitura de BYTEA até o PUT concluir.
- Cada arquivo tem UUID próprio no outbox. Retentar upload/finalização não duplica anexos; três fotos continuam sendo o limite por solicitação.
- Limpeza a partir de 48h do encerramento: retirada realizada, entrega realizada/cancelamento ou atendimento resolvido sem pedido ativo. Reabertura, preparação, espera de retirada, entrega em andamento e outbox pendente/falha/ambíguo protegem a imagem. Metadados e evento de limpeza ficam; bytes e caminho saem.
- Originais temporários de upload saem em 24h. A URL assinada pode permanecer válida por 2h; a limpeza posterior cobre PUTs tardios e uploads abandonados. Órfãos de finalização abortada também são removidos.
- Sem configuração de Storage, mantém compatibilidade: fotos compactas no banco com a mesma retenção, sem upload direto. Arquivos já migrados exigem Storage para leitura/limpeza; indisponibilidade preserva referência para retry.
- Só fotos operacionais de pneus são abrangidas. Comprovantes financeiros, imagens de catálogo, materiais de marketing e mídias mantidas pelo Chatwoot têm ciclos próprios.

Verificação: testes unitários de codec, upload e Storage; integração com Postgres descartável para retenção, pedidos ativos, outbox, concorrência, RLS e migração gradual.
