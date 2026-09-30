window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingPublisherHelpers = function () {
    return {
        mpErrorText(error) {
            const messages = { publisher_disabled: 'A Central está desativada no servidor. Ative a configuração após aplicar a migration.',
                publisher_send_disabled: 'O envio ainda não está habilitado. Confira as contas, as permissões e o Storage.',
                publisher_storage_missing: 'Configure o Supabase Storage para enviar arquivos.', publisher_bucket_must_be_private: 'O bucket de publicações precisa ser privado.',
                publisher_storage_unavailable: 'O Storage está temporariamente indisponível. Seus rascunhos e histórico continuam preservados.',
                publisher_storage_rejected: 'O armazenamento recusou esta operação. Confira o arquivo e a configuração da biblioteca antes de tentar novamente.',
                publisher_storage_response: 'Não foi possível preparar o envio para a biblioteca. Atualize a página e tente novamente.',
                publisher_bucket_file_limit: 'Este arquivo excede o limite configurado no bucket. Confira os limites antes de enviar.',
                publisher_bucket_mime_rejected: 'O bucket não aceita este formato de arquivo. Revise os tipos permitidos na configuração do Storage.',
                publisher_upload_incomplete: 'O arquivo ainda não foi recebido por inteiro. Selecione o mesmo arquivo em Continuar envio.',
                publisher_processing_required: 'Arquivo recebido. Use Conferir arquivo para concluir o processamento sem reenviar.',
                publisher_storage_object_missing: 'O envio não foi concluído no Storage. Selecione o mesmo arquivo para continuar.',
                publisher_upload_active: 'Este envio ainda está ativo. Aguarde sua conclusão ou tente remover depois.',
                publisher_upload_conflict: 'Este arquivo já mudou ou foi concluído. Atualize a biblioteca e confira o item antes de reenviar.',
                publisher_media_not_ready: 'O arquivo ainda precisa ser conferido. Use Conferir arquivo na biblioteca antes de publicar.',
                publisher_media_not_found: 'O arquivo não está mais disponível na biblioteca. Atualize a lista antes de continuar.',
                publisher_unavailable: 'A Central está temporariamente indisponível. Atualize para conferir o estado antes de repetir a operação.',
                publisher_media_too_large: 'Foto: até 8 MB. Vídeo: até o limite mostrado na biblioteca.', publisher_library_full: 'A biblioteca atingiu o limite operacional. Libere arquivos antes de enviar outros.',
                publisher_version_conflict: 'Este rascunho mudou em outra aba ou a resposta anterior se perdeu. Atualize e reabra o rascunho para conferir.',
                publisher_media_in_use: 'Este arquivo está vinculado a um rascunho ou envio. Cancele a publicação antes de removê-lo.',
                publisher_upload_mismatch: 'O arquivo enviado não corresponde ao arquivo reservado. Envie novamente.',
                publisher_media_invalid: 'Não foi possível validar a mídia. Use JPG, PNG, WebP, HEIC, MP4 ou MOV compatível.',
                publisher_upload_failed: 'O envio foi interrompido. Escolha o mesmo arquivo em Continuar envio para retomar os bytes já recebidos.',
                publisher_upload_unavailable: 'Não foi possível carregar o envio retomável. Atualize a página e tente novamente.',
                publisher_resume_mismatch: 'Escolha exatamente o mesmo arquivo para continuar este envio. Para outro arquivo, inicie um novo envio.',
                publisher_processing_failed: 'O arquivo foi recebido, mas sua conferência falhou. Use Conferir arquivo para tentar novamente sem reenviar.',
                publisher_processing_unavailable: 'A conferência de mídia está indisponível. O arquivo enviado foi preservado para nova tentativa.',
                publisher_media_processor_missing: 'O servidor precisa do processador de mídia. O arquivo foi preservado para conferência depois da configuração.',
                publisher_media_processing_busy: 'Há outros arquivos sendo conferidos. Aguarde e use Conferir arquivo novamente.',
                publisher_media_processing_timeout: 'A conferência excedeu o tempo permitido. O arquivo foi preservado; tente novamente.',
                publisher_media_probe_limit: 'Não foi possível inspecionar este arquivo dentro dos limites. Exporte uma cópia em MP4 com otimização para reprodução na internet.',
                publisher_media_inspection_required: 'Este vídeo precisa ser conferido no servidor antes de publicar. Use Conferir arquivo na biblioteca.',
                publisher_media_dimensions_required: 'Faltam as dimensões verificadas da mídia. Confira o arquivo novamente na biblioteca.',
                publisher_heic_conversion_failed: 'Não foi possível converter esta foto HEIC. Confira o arquivo ou exporte uma cópia em JPEG.',
                publisher_media_aspect_ratio: 'A proporção da mídia não é compatível com um dos destinos. Confira o formato escolhido.',
                publisher_media_dimensions: 'As dimensões da mídia não são compatíveis com um dos destinos.',
                publisher_video_codec: 'Este vídeo usa um codec incompatível com a publicação. Exporte em H.264 ou HEVC, com áudio AAC.',
                publisher_instagram_feed_ratio: 'O Feed do Instagram aceita fotos entre 4:5 e 1,91:1. Escolha outra foto ou use Story.',
                publisher_instagram_photo_width: 'A foto para Instagram precisa ter largura entre 320 e 1440 pixels.',
                publisher_instagram_video_width: 'O vídeo para Instagram excede a largura de 1920 pixels. Exporte uma cópia compatível.',
                publisher_instagram_video_fps: 'O vídeo para Instagram precisa ter entre 23 e 60 quadros por segundo.',
                publisher_instagram_video_bitrate: 'O vídeo para Instagram excede a taxa de 25 Mbps. Exporte uma cópia com taxa menor.',
                publisher_instagram_audio_codec: 'O áudio do vídeo para Instagram precisa estar em AAC.',
                publisher_facebook_reel_dimensions: 'O Reel do Facebook precisa ser vertical, em 9:16, com pelo menos 540 por 960 pixels.',
                publisher_facebook_video_fps: 'O vídeo para Facebook precisa ter entre 24 e 60 quadros por segundo.',
                publisher_instagram_reel_duration: 'Reels do Instagram precisam ter entre 3 segundos e 15 minutos.',
                publisher_publish_permissions_missing: 'Faltam permissões de publicação. Abra Gerenciar contas e confira a conexão antes de enviar.',
                publisher_permissions_unavailable: 'Não foi possível conferir as permissões de publicação. Verifique as contas e tente novamente.',
                publisher_permissions_unchecked: 'As permissões de publicação não puderam ser verificadas. Abra Gerenciar contas e confira a configuração.',
                publisher_permissions_missing: 'Faltam permissões de publicação. Abra Gerenciar contas e confira a conexão.',
                publisher_token_invalid: 'O token da conta é inválido. Atualize a conexão no servidor.',
                publisher_token_expired: 'O token da conta expirou. Atualize a conexão no servidor.',
                publisher_library_unavailable: 'A biblioteca está temporariamente indisponível. Calendário e histórico continuam acessíveis.',
                publisher_posts_unavailable: 'As publicações estão temporariamente indisponíveis. A biblioteca continua acessível.',
                publisher_reconciliation_ambiguous: 'A rede ainda não permite confirmar se houve publicação. Mantenha a conferência pendente ou encerre este destino sem reenviar.',
                publisher_reconciliation_not_allowed: 'Este destino já mudou. Atualize as publicações antes de conferir novamente.',
                publisher_reconciliation_evidence_required: 'Informe o ID da publicação para conferir sua existência na conta conectada.',
                publisher_provider_required: 'Informe o ID da publicação para conferir sua existência na conta conectada.',
                publisher_provider_invalid: 'Use o ID numérico da Meta, com números e, quando houver, um sublinhado. O link e o código curto do Instagram não são esse ID.',
                meta_post_owner_mismatch: 'Este ID pertence a outra conta. Informe o ID da publicação na conta conectada à Central.',
                publisher_reconciliation_unavailable: 'Não foi possível consultar a rede. A conferência continua pendente e nenhum reenvio foi liberado.',
                publisher_already_published: 'A rede indica que este conteúdo já foi publicado. Registre a publicação encontrada; o reenvio permanece bloqueado.',
                publisher_verified_not_published: 'A rede confirmou que o envio anterior não foi publicado. Você pode repetir este destino.',
                publisher_abandoned_no_retry: 'Destino encerrado pela conferência manual. Nenhum reenvio será feito.',
                publisher_format_incompatible: 'Use Feed ou Story para foto; Reel ou Story para vídeo.', publisher_schedule_invalid: 'Escolha um horário futuro, com pelo menos um minuto de antecedência.',
                publisher_story_too_long: 'Stories de vídeo aceitam até 60 segundos nesta Central.', publisher_reel_too_long: 'O vídeo excede a duração permitida para Reel.',
                publisher_facebook_reel_duration: 'Para publicar Reel no Facebook, use um vídeo entre 4 e 60 segundos.',
                publisher_ai_rate_limit: 'Limite de 10 gerações de texto por hora atingido.', publisher_ai_missing: 'A geração de texto ainda não está configurada.',
                publisher_already_started: 'O envio já começou. Aguarde a confirmação antes de tomar outra ação.',
                publisher_retry_not_allowed: 'Só é possível repetir destinos com falha confirmada. Envios incertos precisam de conferência.',
                invalid_publisher_request: 'Confira os campos e os limites antes de continuar.' };
            return messages[error?.message] || 'Não foi possível concluir. As alterações foram mantidas; atualize para conferir o estado antes de tentar novamente.';
        },
        mpVisibleMedia() {
            const query = this.mpSearch.trim().toLocaleLowerCase('pt-BR');
            return this.mpMedia.filter(media => (this.mpKind === 'all' || media.kind === this.mpKind) &&
                (!query || media.name.toLocaleLowerCase('pt-BR').includes(query)));
        },
        mpSelectedMedia() { return this.mpMedia.find(media => media.id === this.mpForm?.media_id && !this.mpMediaNeedsRecovery(media)) || null; },
        mpThumbnail(media) {
            return media?.thumbnail_url || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120"%3E%3Crect width="160" height="120" fill="%23eef3f5"/%3E%3Cg stroke="%238293a1" stroke-width="3" fill="none"%3E%3Crect x="52" y="37" width="56" height="46" rx="5"/%3E%3Ccircle cx="68" cy="51" r="5"/%3E%3Cpath d="M55 77l17-17 12 11 11-10 10 16"/%3E%3C/g%3E%3C/svg%3E';
        },
        mpMediaCanFinalize(media) {
            return Boolean(media.can_finalize || this.mpMediaReceived(media));
        },
        mpMediaReceived(media) {
            return Boolean(media.upload_completed_at || this.mpReadUploadSession?.(media.id)?.complete);
        },
        mpMediaNeedsRecovery(media) {
            return Boolean(media.status && (media.status !== 'ready' || media.kind === 'video' && !media.inspection?.verified));
        },
        mpCount(status) { return this.mpPosts.filter(p => p.status === status).length; },
        mpAttention() {
            return this.mpPosts.filter(post => post.deliveries?.length ?
                post.deliveries.some(delivery => ['failed', 'uncertain'].includes(delivery.status)) : post.status === 'failed').length;
        },
        mpUpcoming() { return this.mpPosts.filter(p => p.status === 'scheduled').sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)).slice(0, 3); },
        mpStatus(status) { return ({ draft: 'Rascunho', scheduled: 'Agendada', publishing: 'Enviando', published: 'Publicada', partial: 'Publicado parcialmente', failed: 'Precisa de atenção', cancelled: 'Cancelada', queued: 'Na fila', uploading: 'Envio pendente', ready: 'Pronto para publicar', preparing: 'Preparando', processing: 'Processando', verifying: 'Conferindo', uncertain: 'Conferir na rede' })[status] || status; },
        mpFormat(format) { return ({ feed: 'Feed', reel: 'Reel', story: 'Story' })[format] || format; },
        mpDateLabel(date) { return date ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(date)) : 'Sem agendamento'; },
        mpBytes(bytes) { return Number(bytes) >= 1024 * 1024 * 1024 ? (Number(bytes) / 1024 / 1024 / 1024).toFixed(1) + ' GB' : (Number(bytes) / 1024 / 1024).toFixed(1) + ' MB'; },
        mpFilteredPosts() {
            const states = this.mpTab === 'drafts' ? ['draft'] : ['published', 'partial', 'failed', 'publishing', 'cancelled'];
            const q = this.mpHistorySearch.toLocaleLowerCase('pt-BR');
            return this.mpPosts.filter(p => states.includes(p.status) && (!q || p.title.toLocaleLowerCase('pt-BR').includes(q)) &&
                (this.mpHistoryNetwork === 'all' || p.destinations.some(d => d.platform === this.mpHistoryNetwork)));
        },
        mpPayload() {
            return { version: this.mpForm.version, title: this.mpForm.title, media_id: this.mpForm.media_id, caption: this.mpForm.caption,
                delete_after_publish: this.mpForm.delete_after_publish, destinations: this.mpForm.destinations.filter(d => d.selected)
                    .map(d => ({ platform: d.platform, format: d.format, ...(this.mpCustom ? { caption: d.caption } : {}) })) };
        },
        mpConnectionLabel(platform) {
            const connection = this.mpConnections.find(item => item.platform === platform);
            if (!connection)
                return 'Permissões ainda não conferidas';
            if (!connection.verified)
                return 'Revisar conexão da conta';
            if (!connection.permissions_checked)
                return 'Conta identificada; permissões não conferidas';
            return connection.publish_allowed ? 'Permissões de publicação confirmadas' : 'Faltam permissões para publicar';
        },
        mpMissingPermissions(platform) {
            const connection = this.mpConnections.find(item => item.platform === platform);
            return (connection?.missing_permissions || []).join(', ');
        },
        mpConnectionError(platform) {
            const code = this.mpConnections.find(connection => connection.platform === platform)?.error_code;
            return code ? this.mpErrorText({ message: code }) : '';
        },
        mpKnownPermissionBlock() {
            return this.mpForm?.destinations.some(destination => destination.selected &&
                this.mpConnections.some(connection => connection.platform === destination.platform && !connection.publish_allowed));
        },
        mpCalendarMove(delta) {
            const [year, month] = this.mpCalendarMonth.split('-').map(Number);
            const d = new Date(Date.UTC(year, month - 1 + delta, 1));
            this.mpCalendarMonth = d.toISOString().slice(0, 7);
        },
        mpCalendarLabel() { return this.mpCalendarMonth ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(this.mpCalendarMonth + '-01T12:00:00Z')) : ''; },
        mpCalendarDays() {
            if (!this.mpCalendarMonth)
                return [];
            const [y, m] = this.mpCalendarMonth.split('-').map(Number);
            const start = new Date(Date.UTC(y, m - 1, 1));
            const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
            return Array.from({ length: start.getUTCDay() + count }, (_, i) => {
                const day = i - start.getUTCDay() + 1;
                if (day < 1)
                    return { key: 'empty' + i, day: null, posts: [] };
                const date = this.mpCalendarMonth + '-' + String(day).padStart(2, '0');
                return { key: date, day, posts: this.mpPosts.filter(p => p.scheduled_at && ['scheduled', 'publishing', 'published', 'partial', 'failed'].includes(p.status) &&
                        new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date(p.scheduled_at)) === date) };
            });
        },
    };
};
