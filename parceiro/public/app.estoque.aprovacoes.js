/**
 * Aprovação segura do estoque: o funcionário solicita; só o dono altera o
 * estoque oficial. Cadastros recebem custo/preço e contagens usam snapshot.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.estoqueAprovacoes = () => ({
  stockAdminTab: 'current',
  stockApprovalFilter: 'all',
  stockApprovalData: { registrations: [], counts: [], pending_total: 0 },
  stockApprovalLoading: false,
  stockApprovalBusy: false,
  stockApprovalModal: null,
  stockApprovalItem: null,
  stockApprovalForm: {
    average_cost: null, sale_price: null, quantity_on_hand: 0,
    minimum_quantity: null, supplier_name: '',
  },
  stockRejectOpen: false,
  stockRejectKind: '',
  stockRejectItem: null,
  stockRejectReason: '',

  get stockPendingTotal() {
    return Number(this.stockApprovalData?.pending_total || 0);
  },

  get stockPendingRegistrations() {
    return this.stockApprovalData?.registrations || [];
  },

  get stockPendingCounts() {
    return this.stockApprovalData?.counts || [];
  },

  stockReviewError(error, fallback) {
    const code = error?.payload?.error || error?.message || '';
    const messages = {
      partner_forbidden_owner_only: 'Somente o dono pode revisar o estoque.',
      stock_request_not_found: 'Esta solicitação não existe mais.',
      stock_request_already_reviewed: 'Esta solicitação já foi revisada.',
      stock_request_not_pending: 'Esta solicitação já saiu da fila.',
    };
    return messages[code] || (code && code !== 'internal_error' && !code.startsWith('api_')
      ? this.errMessage(error) : fallback);
  },

  async loadStockRequests(silent = false) {
    if (!this.isOwner || !this.apiToken) return;
    if (!silent) this.stockApprovalLoading = true;
    try {
      this.stockApprovalData = await this.api('operacao/estoque/solicitacoes');
    } catch (error) {
      if (!silent) this.flash(this.stockReviewError(error, 'Não foi possível carregar as solicitações.'), 'error');
    } finally {
      this.stockApprovalLoading = false;
      this.$nextTick(() => lucide.createIcons());
    }
  },

  async setStockAdminTab(tab) {
    this.stockAdminTab = tab;
    if (tab === 'requests') await this.loadStockRequests();
  },

  stockRequestTypeLabel(item) {
    if (item?.item_type === 'servico') return 'Serviço';
    if (item?.item_type === 'insumo') return 'Insumo';
    return 'Pneu';
  },

  stockRequestDiff(item) {
    return Number(item?.counted_quantity || 0) - Number(item?.quantity_snapshot || 0);
  },

  stockRequestDiffLabel(item) {
    const diff = this.stockRequestDiff(item);
    return `${diff > 0 ? '+' : ''}${diff}`;
  },

  openRegistrationApproval(item) {
    this.stockApprovalItem = item;
    this.stockApprovalModal = 'registration';
    this.stockApprovalForm = {
      average_cost: null,
      sale_price: null,
      quantity_on_hand: item.item_type === 'servico' ? null : 0,
      minimum_quantity: item.minimum_quantity ?? null,
      supplier_name: '',
    };
    this.$nextTick(() => lucide.createIcons());
  },

  openCountApproval(item) {
    this.stockApprovalItem = item;
    this.stockApprovalModal = 'count';
    this.$nextTick(() => lucide.createIcons());
  },

  closeStockApproval() {
    if (this.stockApprovalBusy) return;
    this.stockApprovalModal = null;
    this.stockApprovalItem = null;
  },

  async approveRegistrationRequest() {
    const item = this.stockApprovalItem;
    if (!item || this.stockApprovalBusy) return;
    const cost = Number(this.stockApprovalForm.average_cost);
    const price = Number(this.stockApprovalForm.sale_price);
    const quantity = item.item_type === 'servico'
      ? null : Number(this.stockApprovalForm.quantity_on_hand);
    if (!Number.isFinite(cost) || cost < 0) return this.flash('Informe um custo válido.', 'error');
    if (!Number.isFinite(price) || price <= 0) return this.flash('Informe um preço de venda maior que zero.', 'error');
    if (item.item_type !== 'servico' && (!Number.isInteger(quantity) || quantity < 0)) {
      return this.flash('Informe o saldo inicial em unidades inteiras.', 'error');
    }
    this.stockApprovalBusy = true;
    try {
      await this.api(`operacao/estoque/cadastros/${item.id}/aprovar`, {
        method: 'POST',
        body: JSON.stringify({
          average_cost: cost,
          sale_price: price,
          quantity_on_hand: quantity,
          minimum_quantity: item.item_type === 'servico'
            ? null : (this.stockApprovalForm.minimum_quantity ?? null),
          supplier_name: this.stockApprovalForm.supplier_name || null,
        }),
      });
      this.stockApprovalModal = null;
      this.stockApprovalItem = null;
      this.flash('Item aprovado e cadastrado no estoque.', 'success');
      await this.loadData();
    } catch (error) {
      const message = error?.payload?.error === 'stock_registration_conflict'
        ? 'Já existe um item com esse código no estoque.'
        : this.stockReviewError(error, 'Não foi possível aprovar o cadastro.');
      this.flash(message, 'error');
    } finally {
      this.stockApprovalBusy = false;
      this.$nextTick(() => lucide.createIcons());
    }
  },

  async approveCountRequest() {
    const item = this.stockApprovalItem;
    if (!item || this.stockApprovalBusy) return;
    this.stockApprovalBusy = true;
    try {
      await this.api(`operacao/estoque/contagens/${item.id}/aprovar`, {
        method: 'POST', body: JSON.stringify({}),
      });
      this.stockApprovalModal = null;
      this.stockApprovalItem = null;
      this.flash('Contagem aprovada e saldo atualizado.', 'success');
      await this.loadData();
    } catch (error) {
      const code = error?.payload?.error;
      const message = code === 'stock_count_stale'
        ? 'O estoque mudou depois da contagem. Peça uma nova contagem antes de aprovar.'
        : (code === 'stock_count_below_reserved'
          ? 'A contagem é menor que a quantidade reservada. Revise as vendas abertas.'
          : this.stockReviewError(error, 'Não foi possível aprovar a contagem.'));
      this.flash(message, 'error');
      if (code === 'stock_count_stale') await this.loadStockRequests(true);
    } finally {
      this.stockApprovalBusy = false;
      this.$nextTick(() => lucide.createIcons());
    }
  },

  openStockRejection(kind, item) {
    this.stockRejectKind = kind;
    this.stockRejectItem = item;
    this.stockRejectReason = '';
    this.stockRejectOpen = true;
    this.$nextTick(() => lucide.createIcons());
  },

  closeStockRejection() {
    if (this.stockApprovalBusy) return;
    this.stockRejectOpen = false;
    this.stockRejectItem = null;
  },

  async rejectStockRequest() {
    if (!this.stockRejectItem || this.stockApprovalBusy) return;
    const reason = this.stockRejectReason.trim();
    if (reason.length < 3) return this.flash('Explique o motivo da rejeição.', 'error');
    this.stockApprovalBusy = true;
    const plural = this.stockRejectKind === 'cadastro' ? 'cadastros' : 'contagens';
    try {
      await this.api(`operacao/estoque/${plural}/${this.stockRejectItem.id}/rejeitar`, {
        method: 'POST', body: JSON.stringify({ reason }),
      });
      this.stockRejectOpen = false;
      this.stockRejectItem = null;
      this.flash('Solicitação rejeitada. O estoque não foi alterado.', 'success');
      await this.loadStockRequests();
    } catch (error) {
      this.flash(this.stockReviewError(error, 'Não foi possível rejeitar a solicitação.'), 'error');
    } finally {
      this.stockApprovalBusy = false;
    }
  },
});
