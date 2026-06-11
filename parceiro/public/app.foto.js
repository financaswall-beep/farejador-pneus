/**
 * app.foto.js - fabrica `foto` do painel do parceiro (obra <=300, passo 4/11).
 * MORA AQUI: foto sob demanda (0094) - fila de pedidos de foto da Rede, canal
 * GLOBAL de tempo real (SSE + poll de seguranca, vive desde o login), countdown
 * e urgencia do card, captura + compressao (EXIF) + envio do JPEG cru, bip de
 * oficina (unlockAudio/photoBeep/togglePhotoSound), thumb autenticada e lightbox.
 * NAO MORA AQUI: o ESTADO photo* (fica na raiz ate o passo 10) nem o chat da
 * aba Bate-papo (passo 5) - o SSE do chat continua onde estava.
 * VEIO DE: app.js commit 2089903, linhas 2361-2574 VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.foto = () => ({
    // ─── FOTO SOB DEMANDA (0094) ─────────────────────────────────────────
    // O canal de tempo real é GLOBAL (vive desde o login): o borracheiro pode
    // estar no caixa/estoque quando o pedido de foto cai. O SSE reusa o mesmo
    // stream do chat; eventos kind='photo_request' recarregam a fila e alertam.

    get photoPendingCount() {
      return this.photoRequests.filter((p) => p.status === 'pending').length;
    },

    async loadPhotoRequests() {
      if (!this.apiToken || !this.canSee('batepapo')) return;
      try {
        const data = await this.api('photo-requests');
        this.photoRequests = data.photo_requests || [];
        const pending = this.photoPendingCount;
        // Card NOVO chegou → bip + título piscando (o banner/badge são reativos).
        if (pending > this.photoLastPendingCount) {
          this.photoBeep();
          this.flash('📷 Pedido de foto da Rede — toca no banner pra atender!');
        }
        this.photoLastPendingCount = pending;
        this.syncPhotoTick();
        this.$nextTick(() => lucide.createIcons());
      } catch (err) {
        console.warn('photo_requests_load_failed', err);
      }
    },

    startPhotoGlobal() {
      if (!this.apiToken || !this.canSee('batepapo')) return;
      this.stopPhotoGlobal();
      void this.loadPhotoRequests();
      // SSE global: MESMO endpoint do chat (auth por token na query). Só reage
      // a kind='photo_request' — o chat continua dono dos eventos dele na aba.
      if (window.EventSource) {
        try {
          const url = `/parceiro/${this.slug}/api/chat/stream?token=${encodeURIComponent(this.apiToken)}`;
          const es = new EventSource(url);
          es.addEventListener('message', (ev) => {
            try {
              const payload = JSON.parse(ev.data || '{}');
              if (payload.kind === 'photo_request') void this.loadPhotoRequests();
            } catch (e) { /* payload não-JSON: ignora */ }
          });
          this.photoES = es;
        } catch (err) {
          console.warn('photo_sse_failed', err);
        }
      }
      // Rede de segurança: poll lento sempre (pega evento perdido / SSE caído).
      this.photoPollTimer = setInterval(() => { void this.loadPhotoRequests(); }, 25000);
    },
    stopPhotoGlobal() {
      if (this.photoPollTimer) { clearInterval(this.photoPollTimer); this.photoPollTimer = null; }
      if (this.photoES) { this.photoES.close(); this.photoES = null; }
      if (this.photoTickTimer) { clearInterval(this.photoTickTimer); this.photoTickTimer = null; }
    },
    // Tick de 1s SÓ enquanto há card pendente (countdown vivo sem custo à toa —
    // o nowTimer geral é de 30s, grosso demais pro relógio do card).
    syncPhotoTick() {
      const need = this.photoPendingCount > 0;
      if (need && !this.photoTickTimer) {
        if (!this._origTitle) this._origTitle = document.title;
        this.photoTickTimer = setInterval(() => {
          this.nowTick = Date.now();
          // Título piscando: visível com a aba em segundo plano (celular no bolso).
          const n = this.photoPendingCount;
          if (n > 0) {
            document.title = document.title.startsWith('(')
              ? this._origTitle
              : `(${n}) 📷 FOTO — ${this._origTitle}`;
          }
        }, 1000);
      } else if (!need && this.photoTickTimer) {
        clearInterval(this.photoTickTimer);
        this.photoTickTimer = null;
        if (this._origTitle) document.title = this._origTitle;
      }
    },

    photoSecondsLeft(item) {
      return Math.max(0, Math.floor((new Date(item.expires_at).getTime() - this.nowTick) / 1000));
    },
    photoCountdown(item) {
      const s = this.photoSecondsLeft(item);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    },
    photoUrgency(item) {
      const s = this.photoSecondsLeft(item);
      if (s > 300) return 'ok';      // verde: > 5 min
      if (s > 120) return 'warn';    // laranja: 2–5 min (tema não usa amarelo)
      return 'late';                 // vermelho pulsando: < 2 min
    },

    // Captura da câmera → comprime no aparelho (3G de loja) → preview.
    async photoPickFile(item, event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = ''; // permite "tirar outra" com o mesmo input
      if (!file) return;
      try {
        const blob = await this.photoCompress(file);
        this.photoPreview = { id: item.id, blob, dataUrl: URL.createObjectURL(blob) };
        this.$nextTick(() => lucide.createIcons());
      } catch (err) {
        console.warn('photo_compress_failed', err);
        this.flash('Não consegui ler essa foto. Tenta de novo.');
      }
    },
    // createImageBitmap com from-image APLICA a orientação EXIF (senão a foto
    // de celular chega deitada). Canvas → JPEG ~80% máx 1600px (~150-400KB).
    async photoCompress(file) {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      return new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob falhou'))), 'image/jpeg', 0.8);
      });
    },
    photoRetakeCancel() {
      if (this.photoPreview.dataUrl) URL.revokeObjectURL(this.photoPreview.dataUrl);
      this.photoPreview = { id: null, dataUrl: null, blob: null };
    },
    async photoSend(item) {
      const preview = this.photoPreview;
      if (!preview.blob || preview.id !== item.id || this.photoSending[item.id]) return;
      this.photoSending = { ...this.photoSending, [item.id]: true };
      try {
        // Corpo CRU de imagem (sem multipart): o backend re-encoda e o banco
        // trava duplo-clique (retry = no-op). Content-Type sobrescreve o JSON.
        await this.api(`photo-requests/${item.id}/photo`, {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg' },
          body: preview.blob,
        });
        this.photoRetakeCancel();
        this.flash('✅ Foto enviada pro cliente!', 'success');
        await this.loadPhotoRequests();
      } catch (err) {
        const reason = err && err.payload && err.payload.error;
        if (reason === 'photo_request_not_found') this.flash('Esse pedido de foto não existe mais.');
        else if (reason === 'rate_limited') this.flash('Calma aí — muitos envios seguidos. Espera 1 minuto.');
        else this.flash('Não consegui enviar a foto. Tenta de novo.');
        console.warn('photo_send_failed', err);
      } finally {
        this.photoSending = { ...this.photoSending, [item.id]: false };
      }
    },

    // Bip de oficina (2 tons) via AudioContext — sem asset, atravessa barulho.
    // Política de autoplay: só funciona depois de UM gesto (destravado no init).
    unlockAudio() {
      if (this.audioUnlocked) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        this._audioCtx = this._audioCtx || new Ctx();
        void this._audioCtx.resume();
        this.audioUnlocked = true;
      } catch (e) { /* sem áudio: alerta visual segura sozinho */ }
    },
    photoBeep() {
      if (!this.photoSoundOn || !this.audioUnlocked || !this._audioCtx) return;
      try {
        const ctx = this._audioCtx;
        const beep = (freq, t0, dur) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.frequency.value = freq;
          osc.type = 'square';
          gain.gain.setValueAtTime(0.18, ctx.currentTime + t0);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t0 + dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(ctx.currentTime + t0);
          osc.stop(ctx.currentTime + t0 + dur);
        };
        beep(880, 0, 0.18);    // "pa"
        beep(1320, 0.22, 0.25); // "pá!"
      } catch (e) { /* áudio falhou: visual cobre */ }
    },
    togglePhotoSound() {
      this.photoSoundOn = !this.photoSoundOn;
      try { localStorage.setItem(`farejador_photo_sound_${this.slug}`, this.photoSoundOn ? '1' : '0'); }
      catch (e) { /* localStorage indisponível */ }
    },

    // Thumb da foto no card de separação: <img> não manda Bearer → busca os
    // bytes autenticado e vira objectURL (cacheado por id; poucos cards ativos).
    async photoLoadThumb(photoRequestId) {
      if (!photoRequestId || this.photoThumbUrls[photoRequestId]) return;
      try {
        const res = await fetch(`/parceiro/${this.slug}/api/photo-requests/${photoRequestId}/image`, {
          headers: { Authorization: `Bearer ${this.apiToken}` },
        });
        if (!res.ok) return; // sem foto/sem permissão: thumb simplesmente não aparece
        const blob = await res.blob();
        this.photoThumbUrls = { ...this.photoThumbUrls, [photoRequestId]: URL.createObjectURL(blob) };
      } catch (err) {
        console.warn('photo_thumb_failed', err);
      }
    },
    openPhotoLightbox(photoRequestId) {
      const url = this.photoThumbUrls[photoRequestId];
      if (!url) return;
      this.photoLightbox = { open: true, url };
    },
    closePhotoLightbox() {
      this.photoLightbox = { open: false, url: null };
    },
});
