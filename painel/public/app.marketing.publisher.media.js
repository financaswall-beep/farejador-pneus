window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingPublisherMedia = function () {
    return {
        mpUploadBusy: false,
        mpUploadName: '',
        mpUploadPhase: '',
        mpResumeMedia: null,
        mpUploadSessions: {},
        mpFileMime(file) {
            const accepted = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime'];
            if (accepted.includes(file.type))
                return file.type;
            if (file.type && file.type !== 'application/octet-stream')
                throw new Error('publisher_media_invalid');
            const extensions = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
                heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime' };
            const mime = extensions[file.name.split('.').pop()?.toLowerCase()];
            if (!mime)
                throw new Error('publisher_media_invalid');
            return mime;
        },
        async mpFileFingerprint(file) {
            const edge = 256 * 1024;
            const sample = new Blob([file.slice(0, edge), file.slice(Math.max(edge, file.size - edge))]);
            const digest = await crypto.subtle.digest('SHA-256', await sample.arrayBuffer());
            const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            return [file.name, file.size, file.lastModified, hash].join(':');
        },
        mpReadUploadSession(id) {
            if (this.mpUploadSessions[id])
                return this.mpUploadSessions[id];
            try {
                return JSON.parse(localStorage.getItem('farejador-publisher-upload:' + id) || 'null');
            }
            catch {
                return null;
            }
        },
        mpStoreUploadSession(id, session) {
            if (session)
                this.mpUploadSessions[id] = session;
            else
                delete this.mpUploadSessions[id];
            try {
                const key = 'farejador-publisher-upload:' + id;
                if (session)
                    localStorage.setItem(key, JSON.stringify(session));
                else
                    localStorage.removeItem(key);
            }
            catch { /* Retomada na mesma aba funciona mesmo sem armazenamento local. */ }
        },
        async mpTusLibrary() {
            if (window.PublisherTus)
                return window.PublisherTus;
            if (!window.publisherTusLoading) {
                window.publisherTusLoading = new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = '/admin/painel/vendor/publisher-tus-4.3.1.min.js';
                    script.onload = () => window.PublisherTus ? resolve(window.PublisherTus) : reject(new Error('publisher_upload_unavailable'));
                    script.onerror = () => reject(new Error('publisher_upload_unavailable'));
                    document.head.appendChild(script);
                }).catch(error => { window.publisherTusLoading = null; throw error; });
            }
            return window.publisherTusLoading;
        },
        mpUploadLocation(location, endpoint) {
            const base = new URL(endpoint);
            const url = new URL(location, base);
            if (url.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password ||
                !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/'))
                throw new Error('publisher_upload_failed');
            return url.href;
        },
        async mpResumableUpload(reserved, file, mime, fingerprint) {
            const config = reserved.resumable;
            if (!config?.endpoint || !config.token || config.chunk_size !== 6 * 1024 * 1024)
                throw new Error('publisher_upload_unavailable');
            const endpoint = new URL(config.endpoint);
            if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
                throw new Error('publisher_upload_failed');
            const session = this.mpReadUploadSession(reserved.id);
            if (session && session.fingerprint !== fingerprint)
                throw new Error('publisher_resume_mismatch');
            const uploadUrl = session?.url ? this.mpUploadLocation(session.url, config.endpoint) : null;
            const tus = await this.mpTusLibrary();
            return new Promise((resolve, reject) => {
                const upload = new tus.Upload(file, {
                    endpoint: config.endpoint, uploadUrl, chunkSize: config.chunk_size,
                    retryDelays: [0, 1000, 3000, 5000, 10000], uploadDataDuringCreation: true,
                    storeFingerprintForResuming: false,
                    headers: { 'x-signature': config.token, 'x-upsert': 'false' },
                    metadata: { bucketName: config.bucket, objectName: config.object, contentType: mime, cacheControl: '3600' },
                    onBeforeRequest: request => {
                        const url = request.getURL();
                        if (url !== config.endpoint)
                            this.mpUploadLocation(url, config.endpoint);
                        const xhr = request.getUnderlyingObject();
                        xhr.withCredentials = false;
                        xhr.timeout = 120000;
                        xhr.ontimeout = () => xhr.onerror?.(new Error('publisher_upload_timeout'));
                    },
                    onUploadUrlAvailable: () => {
                        const url = this.mpUploadLocation(upload.url, config.endpoint);
                        // Nenhum token é persistido. A mesma reserva renova a assinatura ao retomar.
                        this.mpStoreUploadSession(reserved.id, { url, fingerprint });
                    },
                    onProgress: (sent, total) => { this.mpUploadProgress = Math.round(100 * sent / total); },
                    onShouldRetry: error => {
                        const status = error.originalResponse?.getStatus() || 0;
                        this.mpUploadPhase = 'Reconectando para continuar o envio…';
                        return status === 0 || [409, 423, 429].includes(status) || status >= 500;
                    },
                    onError: () => reject(new Error('publisher_upload_failed')),
                    onSuccess: () => {
                        this.mpStoreUploadSession(reserved.id, { url: this.mpUploadLocation(upload.url, config.endpoint), fingerprint, complete: true });
                        resolve();
                    },
                });
                upload.start();
            });
        },
        async mpFinalizeMedia(id) {
            this.mpUploadPhase = 'Conferindo o arquivo no servidor…';
            try {
                await this.apiPost('/admin/api/marketing/publisher/media/' + id + '/complete', {});
            }
            catch (error) {
                if (['publisher_storage_object_missing', 'publisher_upload_incomplete'].includes(error.message))
                    this.mpStoreUploadSession(id, null);
                throw error;
            }
            this.mpStoreUploadSession(id, null);
            await this.mpLoad(true);
            const media = this.mpMedia.find(item => item.id === id && item.status === 'ready');
            if (media)
                this.mpSelectMedia(media);
        },
        async mpUploadFiles(event, resume = this.mpResumeMedia) {
            const files = Array.from(event.target?.files || event.dataTransfer?.files || []);
            if (event.target?.value)
                event.target.value = '';
            if (this.mpUploadBusy || !files.length || !this.mpConfig?.enabled || !this.mpConfig?.storage_ready)
                return;
            if (this.marketingIsMock?.()) {
                this.mpError = 'O envio de arquivos não está disponível no modo demonstrativo.';
                return;
            }
            this.mpUploadBusy = true;
            this.mpError = '';
            this.mpMessage = '';
            let completed = 0;
            try {
                for (const file of files) {
                    const mime = this.mpFileMime(file);
                    const limit = Math.min(this.mpConfig.max_file_bytes, mime.startsWith('image/') ? 8 * 1024 * 1024 : Infinity);
                    if (file.size > limit)
                        throw new Error('publisher_media_too_large');
                    if (resume && (resume.name !== file.name || Number(resume.bytes) !== file.size || resume.mime !== mime))
                        throw new Error('publisher_resume_mismatch');
                    this.mpUploadName = file.name;
                    this.mpUploadProgress = 0;
                    this.mpUploadPhase = 'Preparando envio…';
                    const fingerprint = await this.mpFileFingerprint(file);
                    const prior = resume || this.mpMedia.find(item => ['uploading', 'failed'].includes(item.status) && item.name === file.name &&
                        Number(item.bytes) === file.size && item.mime === mime && this.mpReadUploadSession(item.id)?.fingerprint === fingerprint);
                    const id = prior?.id || crypto.randomUUID();
                    const previous = this.mpReadUploadSession(id);
                    if (previous && previous.fingerprint !== fingerprint)
                        throw new Error('publisher_resume_mismatch');
                    const reserved = await this.apiPost('/admin/api/marketing/publisher/media', { id, name: file.name, mime, bytes: file.size });
                    this.mpUploadPhase = 'Enviando arquivo…';
                    if (!reserved.already_uploaded && !previous?.complete)
                        await this.mpResumableUpload(reserved, file, mime, fingerprint);
                    await this.mpFinalizeMedia(id);
                    completed++;
                    resume = null;
                }
                this.mpMessage = completed + ' arquivo(s) enviado(s) e conferido(s).';
            }
            catch (error) {
                this.mpError = this.mpErrorText(error);
                await this.mpLoad(true);
            }
            finally {
                this.mpUploadBusy = false;
                this.mpUploadProgress = null;
                this.mpUploadName = '';
                this.mpUploadPhase = '';
                this.mpResumeMedia = null;
            }
        },
        async mpReprocessMedia(media) {
            if (this.mpBusy || this.mpUploadBusy || this.marketingIsMock?.())
                return;
            this.mpUploadBusy = true;
            this.mpUploadName = media.name;
            this.mpError = '';
            try {
                await this.mpFinalizeMedia(media.id);
                this.mpMessage = 'Arquivo conferido e disponível para publicação.';
            }
            catch (error) {
                this.mpError = this.mpErrorText(error);
            }
            finally {
                this.mpUploadBusy = false;
                this.mpUploadName = '';
                this.mpUploadPhase = '';
            }
        },
        async mpRemoveMedia(media) {
            if (this.mpBusy || this.mpUploadBusy || !window.confirm('Remover ' + media.name + ' da biblioteca?'))
                return;
            if (this.marketingIsMock?.()) {
                this.mpError = 'A remoção não está disponível no modo demonstrativo.';
                return;
            }
            this.mpBusy = true;
            this.mpError = '';
            this.mpMessage = '';
            try {
                await this.apiPost('/admin/api/marketing/publisher/media/' + media.id + '/remove', {});
                this.mpStoreUploadSession(media.id, null);
                if (this.mpResumeMedia?.id === media.id)
                    this.mpResumeMedia = null;
                this.mpMedia = this.mpMedia.filter(item => item.id !== media.id);
                if (this.mpForm?.media_id === media.id) {
                    this.mpForm.media_id = null;
                    this.mpDirty = true;
                }
                this.mpMessage = 'Arquivo removido da biblioteca.';
                await this.mpLoad(true);
            }
            catch (error) {
                this.mpError = this.mpErrorText(error);
            }
            finally {
                this.mpBusy = false;
            }
        },
        async mpOpenPreview(media) {
            if (!media || media.status && media.status !== 'ready')
                return;
            this.mpError = '';
            if (this.marketingIsMock?.()) {
                this.mpPreview = { ...media, url: media.thumbnail_url };
                this.$nextTick(() => window.lucide?.createIcons());
                return;
            }
            try {
                const result = await this.apiPost('/admin/api/marketing/publisher/media/' + media.id + '/preview', {});
                this.mpPreview = { ...media, url: result.url };
                this.$nextTick(() => window.lucide?.createIcons());
            }
            catch (error) {
                this.mpError = this.mpErrorText(error);
            }
        },
    };
};
