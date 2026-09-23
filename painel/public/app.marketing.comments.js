window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingComments = function () {
  return {
    async loadMarketingComments() {
      const seq = ++this.mcoRequestSeq;
      this.mcoLoading = true; this.mcoError = '';
      try {
        const data = await this.apiGet('/admin/api/marketing/comments?page=' + this.mcoPage);
        if (seq !== this.mcoRequestSeq) return;
        this.mcoData = data;
        this.mcoSelected = data.rows.find(row => row.id === this.mcoSelected?.id) || data.rows[0] || null;
      } catch { if (seq === this.mcoRequestSeq) this.mcoError = 'Não foi possível carregar os comentários. Tente atualizar.'; }
      finally { if (seq === this.mcoRequestSeq) { this.mcoLoading = false; this.$nextTick(() => lucide.createIcons()); } }
    },
    mcoStatus(status) {
      return ({pending:'Aguardando análise',generating:'IA analisando',queued:'Na fila de execução',sending:'Executando',
        replied:'Respondido',deleted:'Apagado',ignored:'Sem ação',failed:'Falha',uncertain:'Sem confirmação da Meta'})[status] || status;
    },
    mcoLabel() {
      const data = this.mcoData;
      if (!data?.ready) return 'Aguardando instalação';
      if (data.paused) return 'Automação pausada';
      const c = data.configuration;
      if (c.account_scope_valid === false) return 'Bloqueada: conta diferente da 2W Pneus ou @2wp.pneus';
      if (!c.enabled || !c.token_configured || !c.ai_configured || !c.webhook_configured) return 'Aguardando configuração';
      if (!c.publishing) return 'Publicação ainda não ativada';
      return 'Automação ativada';
    },
    async mcoPause() {
      if (this.mcoBusy || !this.mcoData?.ready) return;
      this.mcoBusy = true; this.mcoError = '';
      try { await this.apiPost('/admin/api/marketing/comments/pause',{paused:!this.mcoData.paused}); await this.loadMarketingComments(); }
      catch { this.mcoError = 'Não foi possível alterar a pausa. Tente novamente.'; }
      finally { this.mcoBusy = false; }
    },
    async mcoConnection() {
      if (this.mcoBusy) return;
      this.mcoBusy = true; this.mcoConnectionMessage = '';
      try {
        const check = await this.apiPost('/admin/api/marketing/comments/connection',{});
        const parts = [check.page_matches ? 'Página do Facebook reconhecida.' : 'A página não corresponde à configuração.'];
        if (this.mcoData?.configuration?.instagram_configured) parts.push(check.instagram_matches ? 'Instagram vinculado reconhecido.' : 'Confira o vínculo da conta do Instagram.');
        if (!check.permissions_checked) parts.push('Permissões ainda não verificadas: configure o ID e o segredo do aplicativo.');
        else {
          if (check.token_valid !== true || check.app_matches !== true) parts.push('Token inválido ou pertencente a outro aplicativo.');
          const missing = [...new Set([...(check.facebook_missing || []),...(this.mcoData?.configuration?.instagram_configured ? check.instagram_missing || [] : [])])];
          parts.push(missing.length ? 'Permissões pendentes: ' + missing.join(', ') : 'Permissões de comentários presentes.');
        }
        parts.push('O recebimento dos comentários depende dos webhooks da Meta.');
        this.mcoConnectionMessage = parts.join(' ');
      } catch { this.mcoConnectionMessage = 'Não foi possível validar a conexão. Confira o token da página, o aplicativo e suas permissões no servidor.'; }
      finally { this.mcoBusy = false; }
    },
    mcoPageChange(delta) { this.mcoPage = Math.max(1,this.mcoPage+delta); void this.loadMarketingComments(); },
  };
};
