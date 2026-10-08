window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.atacadoRequests = function () {
  return {
    partnerRequests: [], partnerRequestsLoaded: false, partnerRequestsLoading: false,
    partnerRequestsBusy: '', partnerRequestsError: '', partnerRequestsFilter: 'requested',
    partnerRequestStatus(row) {
      if (row.receipt_status === 'received') return row.payment_status === 'paid' ? 'Recebido · pago' : 'Recebido · a receber';
      return ({requested:'Novo',approved:'Em separação',rejected:'Recusado',dispatched:'Enviado · aguardando recebimento'})[row.status] || row.status;
    },
    partnerRequestsVisible() {
      return this.partnerRequests.filter(row => !this.partnerRequestsFilter || row.status === this.partnerRequestsFilter);
    },
    async loadPartnerRequests() {
      if (this.partnerRequestsLoading) return;
      this.partnerRequestsLoading = true; this.partnerRequestsError = '';
      try {
        const response = await this.apiGet('/admin/api/wholesale/partner-requests');
        this.partnerRequests = (response.rows || []).map(row => ({...row,due_date:row.due_date || this.finHoje(),reason:''}));
        this.partnerRequestsLoaded = true;
      } catch (_) { this.partnerRequestsError = 'Não consegui atualizar os pedidos dos parceiros.'; }
      finally { this.partnerRequestsLoading = false; }
    },
    async decidePartnerRequest(row, action) {
      if (this.adminUser?.role !== 'owner' || this.partnerRequestsBusy) return;
      if (action === 'reject' && String(row.reason || '').trim().length < 3) {
        this.partnerRequestsError = 'Escreva o motivo da recusa.'; return;
      }
      if (action === 'dispatch' && !row.due_date) { this.partnerRequestsError = 'Informe o vencimento da cobrança.'; return; }
      this.partnerRequestsBusy = row.id; this.partnerRequestsError = '';
      try {
        await this.apiPost('/admin/api/wholesale/partner-requests/' + row.id + '/' + action,
          action === 'reject' ? {reason:row.reason.trim()} : action === 'dispatch' ? {due_date:row.due_date} : {});
        await this.loadPartnerRequests();
        if (action === 'dispatch') await this.loadAtacadoVendas();
      } catch (error) {
        const code = error?.message || '';
        this.partnerRequestsError = code.includes('price_changed') ? 'O preço mudou. Recuse este pedido e peça um novo envio ao parceiro.'
          : /stock_changed|offer_changed/.test(code) ? 'A disponibilidade mudou. Confira o catálogo antes de aprovar.'
          : code.includes('wholesale_finance_required') ? 'Habilite o financeiro do atacado para usar este fluxo.'
          : 'Não consegui concluir a ação. Atualize a lista para conferir o estado antes de tentar novamente.';
      } finally { this.partnerRequestsBusy = ''; }
    },
  };
};
