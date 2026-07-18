window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.clientesIdentity = function () {
  return {
    async loadCustomerIdentities(reset = true) {
      if (!this.customerIdentityEnabled || this.customerIdentityLoading) return;
      this.customerIdentityLoading = true; this.customerIdentityError = null;
      try {
        const cursor = reset ? '' : (this.customerIdentityCursor || '');
        const filter = this.clientesBusca ? `&filter=${encodeURIComponent(this.clientesBusca)}` : '';
        const page = await this.apiGet(`/admin/api/clientes-v2?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${filter}`);
        this.customerIdentityRows = reset ? page.rows : [...this.customerIdentityRows, ...page.rows];
        this.customerIdentityCursor = page.next_cursor;
        if (!this.customerIdentitySelectedId && this.customerIdentityRows[0]) {
          this.customerIdentitySelectedId = this.customerIdentityRows[0].id;
        }
        const candidates = await this.apiGet('/admin/api/clientes-v2/candidates');
        this.customerIdentityCandidates = candidates.candidates || [];
      } catch (error) { this.customerIdentityError = error instanceof Error ? error.message : String(error); }
      finally { this.customerIdentityLoading = false; this.$nextTick(() => lucide.createIcons()); }
    },
    customerIdentitySelected() {
      return this.customerIdentityRows.find((row) => row.id === this.customerIdentitySelectedId) || null;
    },
    customerSourceLabel(type) {
      return ({ chatwoot_contact:'Chatwoot',walkin_customer:'Balcão',partner_customer:'Cliente de parceiro',
        wholesale_customer:'Atacado',network_partner:'Parceiro da rede',matriz_collaborator:'Colaborador' })[type] || type;
    },
    customerEntityLabel(type) {
      return ({ person:'Pessoa',organization:'Empresa',fleet:'Frota',tire_shop:'Borracharia',partner:'Parceiro',
        collaborator:'Colaborador',unknown:'Não classificado' })[type] || type;
    },
    async syncCustomerIdentities() {
      if (!confirm('Criar vínculos canônicos para as fontes atuais? Isso não altera nomes, telefones, vendas ou conversas.')) return;
      const reason = prompt('Motivo da sincronização:'); if (!reason || reason.trim().length < 5) return;
      this.customerIdentityLoading = true;
      try {
        const result = await this.apiPost('/admin/api/clientes-v2/backfill',{ reason,confirmation:'CRIAR IDENTIDADES' });
        this.customerIdentityNotice = `${result.identities_created} identidade(s) criada(s); ${result.candidates_created} revisão(ões).`;
        this.customerIdentityLoading = false;
        await this.loadCustomerIdentities(true);
      } catch (error) { this.customerIdentityError = error.message; }
      finally { this.customerIdentityLoading = false; }
    },
    exportCustomerIdentities() {
      const reason = prompt('Motivo da exportação com nomes e telefones completos:');
      if (!reason || reason.trim().length < 5) return;
      const filter = this.clientesBusca ? `&filter=${encodeURIComponent(this.clientesBusca)}` : '';
      location.assign(`/admin/api/clientes-v2/export?reason=${encodeURIComponent(reason)}${filter}`);
    },
    async inspectCustomerCandidate(candidate) {
      this.customerIdentityCandidate = candidate;
      try {
        this.customerIdentityCandidateSides = await Promise.all([
          this.apiGet(`/admin/api/clientes-v2/${candidate.left_identity_id}`),
          this.apiGet(`/admin/api/clientes-v2/${candidate.right_identity_id}`),
        ]);
      } catch (error) { this.customerIdentityError = error.message; }
    },
    async decideCustomerCandidate(decision) {
      const candidate = this.customerIdentityCandidate; if (!candidate) return;
      const reason = prompt(decision === 'approve' ? 'Por que estas fontes são a mesma pessoa/empresa?' : 'Por que não devem ser unidas?');
      if (!reason || reason.trim().length < 5) return;
      if (decision === 'approve' && !confirm('Confirmar união? Ela poderá ser desfeita por Separar.')) return;
      const body = { reason,...(decision === 'approve' ? { confirmation:'UNIR IDENTIDADES' } : {}) };
      await this.apiPost(`/admin/api/clientes-v2/candidates/${candidate.id}/${decision}`,body);
      this.customerIdentityCandidate = null; this.customerIdentityCandidateSides = [];
      await this.loadCustomerIdentities(true);
    },
    async splitSelectedCustomerIdentity() {
      const selected = this.customerIdentitySelected();
      if (!selected || !this.customerIdentitySplitLinks.length) return;
      const reason = prompt('Por que estas fontes pertencem a outra pessoa/empresa?');
      if (!reason || reason.trim().length < 5 || !confirm('Separar as fontes marcadas em uma nova identidade?')) return;
      await this.apiPost(`/admin/api/clientes-v2/${selected.id}/split`,{ reason,
        link_ids:this.customerIdentitySplitLinks,idempotency_key:crypto.randomUUID(),confirmation:'SEPARAR IDENTIDADE' });
      this.customerIdentitySplitLinks = []; await this.loadCustomerIdentities(true);
    },
    async previewSelectedCustomerPrivacy(requestType) {
      const selected = this.customerIdentitySelected(); if (!selected || !this.customerPrivacyEnabled) return;
      if (!confirm('Você confirmou a pessoa pelo canal já cadastrado?')) return;
      if (!confirm('Você conferiu uma segunda evidência transacional?')) return;
      try {
        const request = await this.apiPost('/admin/api/privacy/requests',{ identity_id:selected.id,
          request_type:requestType,idempotency_key:crypto.randomUUID() });
        await this.apiPost(`/admin/api/privacy/requests/${request.id}/verify`,{
          registered_channel_confirmed:true,transaction_evidence_confirmed:true });
        this.customerPrivacyPreview = await this.apiPost(`/admin/api/privacy/requests/${request.id}/preview`,{});
        this.customerPrivacyPreview.request_id = request.id;
      } catch (error) { this.customerIdentityError = error.message; }
    },
    async approveSelectedCustomerPrivacy() {
      const preview = this.customerPrivacyPreview; if (!preview) return;
      const reason = prompt('Motivo da aprovação:'); if (!reason || reason.trim().length < 5) return;
      await this.apiPost(`/admin/api/privacy/requests/${preview.request_id}/approve`,{
        reason,confirmation:'APROVAR SOLICITACAO' });
      if (preview.request.request_type === 'anonymization') {
        alert('Dry-run aprovado. A remoção de nomes continua bloqueada e nada foi apagado.'); return;
      }
      if (!confirm('Gerar agora o pacote de portabilidade?')) return;
      const result = await this.apiPost(`/admin/api/privacy/requests/${preview.request_id}/execute`,{
        confirmation:'EXECUTAR PORTABILIDADE' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(result.portability_package,null,2)],{ type:'application/json' }));
      link.download = `portabilidade-${preview.request.identity_id}.json`; link.click(); URL.revokeObjectURL(link.href);
    },
  };
};
