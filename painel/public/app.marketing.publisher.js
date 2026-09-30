window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingPublisher = function () {
    return {
        ...window.PAINEL_MODULES.marketingPublisherHelpers(),
        mpMarkup: window.MARKETING_PUBLISHER_TEMPLATE,
        mpTab: 'create', mpConfig: null, mpMedia: [], mpPosts: [], mpLoading: false, mpBusy: false, mpError: '', mpMessage: '', mpWarnings: [],
        mpSearch: '', mpKind: 'all', mpHistorySearch: '', mpHistoryNetwork: 'all', mpUploadProgress: null,
        mpForm: null, mpDirty: false, mpBrief: '', mpAiBusy: false, mpCustom: false, mpWhen: 'now', mpDate: '', mpTime: '09:00',
        mpConnectionsOpen: false, mpConnections: [], mpConnectionBusy: false, mpPreview: null, mpTimer: null, mpCalendarMonth: '',
        mpReconciliation: null,
        mpFresh() {
            this.mpForm = { id: crypto.randomUUID(), version: 0, title: '', media_id: null, caption: '', delete_after_publish: true,
                destinations: [{ platform: 'instagram', format: 'feed', selected: true, caption: '' }, { platform: 'facebook', format: 'feed', selected: true, caption: '' }] };
            this.mpDirty = false;
            this.mpBrief = '';
            this.mpCustom = false;
            this.mpWhen = 'now';
            this.mpDate = '';
            this.mpTab = 'create';
        },
        async mpLoad(quiet = false) {
            if (this.mpLoading)
                return;
            this.mpLoading = true;
            if (!quiet)
                this.mpError = '';
            try {
                if (this.marketingIsMock?.()) {
                    this.mpConfig = { enabled: false, sending: false, schema_ready: true, storage_ready: false, ai_ready: false };
                    this.mpMedia = [];
                    this.mpPosts = [];
                    this.mpError = 'A Central de publicações usa dados reais. Saia do modo demonstrativo para acessá-la.';
                    return;
                }
                const data = await this.apiGet('/admin/api/marketing/publisher');
                this.mpConfig = data.config;
                this.mpMedia = data.media;
                this.mpPosts = data.posts;
                this.mpWarnings = data.warnings || [];
                if (!this.mpForm)
                    this.mpFresh();
                if (!this.mpCalendarMonth)
                    this.mpCalendarMonth = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(new Date());
                clearTimeout(this.mpTimer);
                if (this.mpPosts.some(p => ['scheduled', 'publishing'].includes(p.status)))
                    this.mpTimer = setTimeout(() => {
                        if (this.currentPage === 'marketing' && this.moView === 'publisher')
                            void this.mpLoad(true);
                    }, 15000);
            }
            catch (error) {
                this.mpError = this.mpErrorText(error);
            }
            finally {
                this.mpLoading = false;
                this.$nextTick(() => window.lucide?.createIcons());
            }
        },
        mpClose() {
            clearTimeout(this.mpTimer);
            this.mpTimer = null;
            this.mpPreview = null;
            this.mpReconciliation = null;
        },
        mpSelectMedia(media) {
            if (this.mpMediaNeedsRecovery(media))
                return;
            if (!this.mpForm)
                this.mpFresh();
            this.mpForm.media_id = media.id;
            this.mpDirty = true;
            if (!this.mpForm.title)
                this.mpForm.title = media.name.replace(/\.[^.]+$/, '');
            this.mpForm.destinations.forEach(destination => {
                if (media.kind === 'photo' && destination.format === 'reel') destination.format = 'feed';
                if (media.kind === 'video' && destination.format === 'feed') destination.format = 'reel';
            });
        },
        async mpPersist() {
            if (this.marketingIsMock?.())
                throw new Error('publisher_demo_disabled');
            const saved = await this.apiPut('/admin/api/marketing/publisher/posts/' + this.mpForm.id, this.mpPayload());
            this.mpForm.version = saved.version;
            this.mpDirty = false;
            return saved;
        },
        async mpSave() {
            if (this.mpBusy)
                return;
            this.mpBusy = true;
            this.mpError = '';
            this.mpMessage = '';
            try {
                await this.mpPersist();
                this.mpMessage = 'Rascunho salvo.';
                await this.mpLoad(true);
            }
            catch (error) {
                this.mpError = this.mpErrorText(error);
            }
            finally {
                this.mpBusy = false;
            }
        },
        async mpSubmit() {
            if (this.mpBusy || !this.mpConfig?.sending || this.marketingIsMock?.())
                return;
            if (this.mpKnownPermissionBlock()) {
                this.mpError = 'Abra Gerenciar contas e resolva as permissões dos destinos selecionados antes de publicar.';
                return;
            }
            if (!this.mpSelectedMedia()) {
                this.mpError = 'Escolha uma foto ou um vídeo.';
                return;
            }
            const selected = this.mpForm.destinations.filter(d => d.selected);
            if (!selected.length) {
                this.mpError = 'Escolha pelo menos uma rede social.';
                return;
            }
            const scheduled = this.mpWhen === 'schedule' ? new Date(this.mpDate + 'T' + this.mpTime + ':00-03:00') : null;
            if (scheduled && (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() < Date.now() + 60000)) {
                this.mpError = 'Escolha uma data e um horário futuros, em Brasília.';
                return;
            }
            if (!window.confirm((scheduled ? 'Agendar' : 'Publicar agora') + ' em ' + selected.map(d => d.platform === 'instagram' ? 'Instagram' : 'Facebook').join(' e ') + '? Confira o texto e a mídia antes de confirmar.'))
                return;
            this.mpBusy = true;
            this.mpError = '';
            this.mpMessage = '';
            try {
                await this.mpPersist();
                if (this.marketingIsMock?.())
                    throw new Error('publisher_demo_disabled');
                await this.apiPost('/admin/api/marketing/publisher/posts/' + this.mpForm.id + '/submit', { version: this.mpForm.version, scheduled_at: scheduled?.toISOString() || null });
                this.mpFresh();
                this.mpTab = scheduled ? 'calendar' : 'published';
                this.mpMessage = scheduled ? 'Publicação agendada.' : 'Envio iniciado. Acompanhe a confirmação de cada rede.';
                await this.mpLoad(true);
            }
            catch (error) {
                this.mpError = this.mpErrorText(error);
                await this.mpLoad(true);
            }
            finally {
                this.mpBusy = false;
            }
        },
        mpEdit(post) {
            if (this.mpDirty && !window.confirm('Abrir outro rascunho e descartar as alterações não salvas?'))
                return;
            this.mpForm = { ...post, destinations: ['instagram', 'facebook'].map(platform => {
                    const d = post.destinations.find(d => d.platform === platform);
                    return { ...(d || { platform, format: 'feed', caption: '' }), selected: Boolean(d) };
                }) };
            this.mpCustom = post.destinations.some(d => Object.hasOwn(d, 'caption'));
            this.mpTab = 'create';
            this.mpDirty = false;
        },
        mpNew() {
            if (this.mpDirty && !window.confirm('Descartar as alterações não salvas?')) return;
            this.mpFresh();
        },
        async mpAction(post, action) {
            if (this.mpBusy || this.marketingIsMock?.() || !window.confirm(action === 'cancel' ? 'Cancelar esta publicação?' : 'Tentar novamente somente as redes com falha confirmada?'))
                return;
            this.mpBusy = true;
            this.mpError = '';
            try {
                await this.apiPost('/admin/api/marketing/publisher/posts/' + post.id + '/action', { action });
                await this.mpLoad(true);
            }
            catch (error) {
                this.mpError = this.mpErrorText(error);
            }
            finally {
                this.mpBusy = false;
            }
        },
        mpOpenReconciliation(post, delivery) {
            if (this.mpBusy || delivery.status !== 'uncertain' || this.marketingIsMock?.())
                return;
            this.mpReconciliation = { post_id: post.id, title: post.title, version: post.version,
                platform: delivery.platform, decision: 'published', provider_id: delivery.post_url || delivery.provider_id || '', note: '', confirmed: false };
            this.$nextTick(() => window.lucide?.createIcons());
        },
        async mpReconcile() {
            const form = this.mpReconciliation;
            if (this.mpBusy || !form || !form.confirmed || form.note.trim().length < 10 || this.marketingIsMock?.())
                return;
            const provider = form.provider_id.trim();
            const isId = /^[0-9_]{1,100}$/.test(provider);
            const isLink = /^https:\/\/\S+$/i.test(provider) && provider.length <= 2048;
            if (form.decision === 'published' && (!provider || (!isId && !isLink))) {
                this.mpError = this.mpErrorText({ message: provider ? 'publisher_provider_invalid' : 'publisher_provider_required' });
                return;
            }
            this.mpBusy = true;
            this.mpError = '';
            try {
                await this.apiPost('/admin/api/marketing/publisher/posts/' + form.post_id + '/reconcile', {
                    version: form.version, platform: form.platform, decision: form.decision, confirmed: true,
                    note: form.note.trim(), ...(form.decision === 'published'
                        ? (isId ? { provider_id: provider } : { post_url: provider }) : {}),
                });
                this.mpReconciliation = null;
                this.mpMessage = form.decision === 'not_published' ? 'Ausência de publicação confirmada. O reenvio fica disponível como uma ação separada.' :
                    form.decision === 'abandon' ? 'Destino encerrado sem reenviar. A mídia e o registro da conferência foram preservados.' : 'Publicação confirmada na conta conectada.';
                await this.mpLoad(true);
            }
            catch (error) {
                this.mpError = this.mpErrorText(error);
            }
            finally {
                this.mpBusy = false;
            }
        },
        async mpGenerateCaption() {
            if (this.mpAiBusy || !this.mpBrief.trim() || this.marketingIsMock?.())
                return;
            this.mpAiBusy = true;
            this.mpError = '';
            try {
                const result = await this.apiPost('/admin/api/marketing/publisher/caption', { brief: this.mpBrief });
                if (this.mpForm.caption && !window.confirm('Substituir a legenda atual pela sugestão da IA?'))
                    return;
                this.mpForm.caption = result.caption;
                this.mpDirty = true;
                this.mpMessage = 'Texto sugerido. Revise os fatos antes de publicar.';
            }
            catch (error) {
                this.mpError = this.mpErrorText(error);
            }
            finally {
                this.mpAiBusy = false;
            }
        },
        async mpCheckConnections() {
            if (this.marketingIsMock?.())
                return;
            this.mpConnectionsOpen = true;
            this.$nextTick(() => window.lucide?.createIcons());
            this.mpConnectionBusy = true;
            this.mpConnections = [];
            try {
                this.mpConnections = (await this.apiPost('/admin/api/marketing/publisher/connections', {})).connections;
            }
            catch (error) {
                this.mpError = this.mpErrorText(error);
            }
            finally {
                this.mpConnectionBusy = false;
            }
        },
    };
};
