/**
 * app.push.js — fábrica `push` do painel do parceiro (PWA, 0109).
 * MORA AQUI: a notificação NATIVA do celular (Web Push) — registra o service
 * worker (sw.js), pede permissão, inscreve o aparelho e manda a inscrição pro
 * servidor. Resolve o furo que o dono achou na operação (2026-06-17): o som da
 * página (app.foto.js) só toca com a aba aberta; isto avisa com o app FECHADO.
 * NÃO MORA AQUI: o disparo do push (servidor, src/parceiro/push.ts) nem o ESTADO
 * push* (fica na raiz, app.js). Tudo degrada quieto se o navegador não suportar.
 * REGRA: teto 300 (npm run checar-tamanho); `this` é o objeto único de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.push = () => ({
    // Banner "Ativar avisos" aparece só quando: logado, o aparelho suporta, o
    // servidor tem push ligado, ainda não ativou, não foi negado e não foi dispensado.
    get pushShouldOfferBanner() {
      return this.authed && this.pushSupported && this.pushServerEnabled
        && !this.pushEnabled && this.pushPermission !== 'denied' && !this.pushBannerDismissed;
    },

    // Roda no boot (core.init, logado). Detecta suporte, confere se o servidor tem
    // push ligado, registra o ajudante (sw.js) e — se a permissão já foi dada —
    // garante a inscrição viva (cobre assinatura rotacionada / troca de loja / banco limpo).
    async initPush() {
      this.pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      if (!this.pushSupported) return;
      this.pushPermission = Notification.permission;
      try { this.pushBannerDismissed = localStorage.getItem(`farejador_push_dismiss_${this.slug}`) === '1'; }
      catch (e) { /* localStorage indisponível: mostra o banner nesta sessão */ }
      let vp;
      try { vp = await this.api('push/vapid-key'); }
      catch (e) { return; } // sem servidor/sessão: não insiste
      this.pushServerEnabled = !!(vp && vp.enabled && vp.key);
      if (!this.pushServerEnabled) return; // flag off no servidor: nem registra o SW
      let reg;
      try { reg = await navigator.serviceWorker.register('./sw.js'); }
      catch (e) { this.pushSupported = false; return; } // SW não registrou (http?/bloqueio)
      if (this.pushPermission === 'granted') {
        try {
          const existing = await reg.pushManager.getSubscription();
          if (existing) { await this._pushSaveSub(existing); this.pushEnabled = true; }
        } catch (e) { /* não crava enabled; o banner reaparece se precisar */ }
      }
    },

    // Chamado pelo botão "Ativar" (o clique é o gesto que o navegador exige pra
    // pedir permissão). Pede permissão → inscreve → manda pro servidor.
    async enablePush() {
      if (this.pushBusy) return;
      if (!this.pushSupported) {
        this.flash('Esse aparelho/navegador não aceita avisos. Tenta pelo Chrome no Android.');
        return;
      }
      this.pushBusy = true;
      try {
        const vp = await this.api('push/vapid-key');
        if (!vp.enabled || !vp.key) {
          this.flash('Os avisos ainda não estão ligados no servidor.');
          return;
        }
        const perm = await Notification.requestPermission();
        this.pushPermission = perm;
        if (perm !== 'granted') {
          this.flash('Pra receber aviso com o app fechado, precisa tocar em "Permitir".');
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this._pushUrlB64ToUint8(vp.key),
        });
        await this._pushSaveSub(sub);
        this.pushEnabled = true;
        this.flash('🔔 Avisos ativados neste aparelho!', 'success');
      } catch (err) {
        console.warn('push_enable_failed', err);
        this.flash('Não consegui ativar os avisos agora. Tenta de novo.');
      } finally {
        this.pushBusy = false;
      }
    },

    // "Agora não": esconde o banner neste aparelho (não some pra sempre — some
    // até o cara limpar o navegador; o objetivo é não importunar a cada login).
    dismissPushBanner() {
      this.pushBannerDismissed = true;
      try { localStorage.setItem(`farejador_push_dismiss_${this.slug}`, '1'); }
      catch (e) { /* localStorage indisponível: dispensa só nesta sessão */ }
    },

    // Manda a inscrição (endpoint + chaves) pro servidor guardar. O backend escopa
    // por unidade (RLS). PushSubscription.toJSON() = { endpoint, keys:{p256dh,auth} }.
    async _pushSaveSub(sub) {
      const json = sub.toJSON();
      await this.api('push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
    },

    // A chave VAPID vem em base64url; o pushManager.subscribe exige Uint8Array.
    _pushUrlB64ToUint8(base64) {
      const padding = '='.repeat((4 - (base64.length % 4)) % 4);
      const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(b64);
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    },
});
