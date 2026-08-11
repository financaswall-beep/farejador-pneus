/**
 * Aprovação segura do estoque: o funcionário solicita; só o dono altera o
 * estoque oficial. Cadastros recebem custo/preço e contagens usam snapshot.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.estoqueAprovacoes = () => ({
  stockAdminTab: 'current',
  stockApprovalFilter: 'all',
  stockApprovalData: { registrations: [], updates: [], counts: [], pending_total: 0 },
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

  get stockPendingUpdates() {
    return this.stockApprovalData?.updates || [];
  },

  stockReviewError(error, fallback) {
    const code = error?.payload?.error || error?.message || '';
    const messages = {
      partner_forbidden_owner_only: 'Somente o dono pode revisar o estoque.',
      stock_request_not_found: 'Esta solicitação não existe mais.',
      stock_request_already_reviewed: 'Esta solicitação já foi revisada.',
      stock_request_not_pending: 'Esta solicitação já saiu da fila.',
      stock_update_stale: 'O cadastro mudou depois do pedido. Rejeite e peça uma nova edição.',
      stock_update_conflict: 'Os novos dados entram em conflito com outro item do estoque.',
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

  stockUpdateFields(item) {
    const fields = [
      ['Nome', item?.current_item_name, item?.item_name],
      ['Marca', item?.current_brand, item?.brand],
      ['Medida', item?.current_tire_size, item?.tire_size],
      ['Condição', item?.current_tire_condition, item?.tire_condition],
      ['Posição', item?.current_tire_position, item?.tire_position],
      ['Estoque mínimo', item?.current_minimum_quantity, item?.minimum_quantity],
      ['Localização', item?.current_shelf_location, item?.shelf_location],
      ['Código', item?.current_local_sku, item?.local_sku],
    ];
    return fields.filter((field) => String(field[1] ?? '') !== String(field[2] ?? ''));
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

  async openCountApproval(item) {
    this.stockApprovalItem = item;
    this.stockApprovalModal = 'count';
    this.photoLightbox = { open: false, url: null };
    this.$nextTick(() => lucide.createIcons());
    if (!item?.has_evidence) return;
    const key = `stock-count:${item.id}`;
    if (!this.photoThumbUrls[key]) {
      try {
        const response = await fetch(`/parceiro/${this.slug}/api/operacao/estoque/contagens/${item.id}/foto`, {
          headers: { Authorization: `Bearer ${this.apiToken}` },
        });
        if (!response.ok) throw new Error('photo_load_failed');
        const blob = await response.blob();
        this.photoThumbUrls = { ...this.photoThumbUrls, [key]: URL.createObjectURL(blob) };
      } catch (_) {
        this.flash('A contagem existe, mas não foi possível abrir a foto.', 'error');
        return;
      }
    }
    if (this.stockApprovalItem?.id === item.id) {
      this.photoLightbox = { open: false, url: this.photoThumbUrls[key] };
    }
  },

  openUpdateApproval(item) {
    this.stockApprovalItem = item;
    this.stockApprovalModal = 'update';
    this.$nextTick(() => lucide.createIcons());
  },

  closeStockApproval() {
    if (this.stockApprovalBusy) return;
    this.stockApprovalModal = null;
    this.stockApprovalItem = null;
    this.photoLightbox = { open: false, url: null };
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

  async approveUpdateRequest() {
    const item = this.stockApprovalItem;
    if (!item || this.stockApprovalBusy) return;
    this.stockApprovalBusy = true;
    try {
      await this.api(`operacao/estoque/edicoes/${item.id}/aprovar`, {
        method: 'POST', body: JSON.stringify({}),
      });
      this.stockApprovalModal = null;
      this.stockApprovalItem = null;
      this.flash('Alteração aprovada. Cadastro atualizado sem mexer no saldo.', 'success');
      await this.loadData();
    } catch (error) {
      const code = error?.payload?.error;
      this.flash(this.stockReviewError(error, 'Não foi possível aprovar a alteração.'), 'error');
      if (code === 'stock_update_stale') await this.loadStockRequests(true);
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
    const plural = this.stockRejectKind === 'contagem' ? 'contagens' : 'cadastros';
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
