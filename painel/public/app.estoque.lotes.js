window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.estoqueLotes = function () {
  return {
    get tireLotSelected() { return this.tireLots.rows.find(row => row.id === this.tireLots.selectedId) || null; },
    get tireLotSource() { return this.tireLots.sources.find(row => row.id === this.tireLots.form.stock_id) || null; },
    get tireLotSeparationCost() {
      const source = this.tireLotSource, quantity = Number(this.tireLots.form.quantity);
      if (!source || !Number.isInteger(quantity) || quantity < 1 || quantity > source.available_quantity) return 0;
      // Match PostgreSQL's rounded stock value before/after; no lost cents on 100/3.
      const [whole, fraction = ''] = String(source.unit_cost).split('.');
      const unit = BigInt(whole || '0') * 1000000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
      const cents = count => (unit * BigInt(count) + 5000n) / 10000n;
      return Number(cents(source.quantity_on_hand) - cents(source.quantity_on_hand - quantity)) / 100;
    },
    tireLotIcons() { this.$nextTick(() => window.lucide?.createIcons()); },
    tireLotStatus(row) { return ({ open: 'Aberto', pending: 'A caminho', closed: 'Esgotado', cancelled: 'Cancelado' })[row?.status] || '—'; },
    tireLotDate(value, time = false) {
      if (!value) return '—';
      return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short',
        ...(time ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(value));
    },
    tireLotMovement(row) {
      return ({ purchase_receipt: 'Recebimento da compra ' + (row.purchase_code || ''),
        purchase_cancel: 'Cancelamento da compra ' + (row.purchase_code || ''),
        sale: 'Venda de lotes #' + String(row.order_id || '').slice(0,8),
        sale_cancel: 'Cancelamento da venda #' + String(row.order_id || '').slice(0,8),
        separation_in: 'Separação do estoque cadastrado' })[row.source] || 'Movimentação do lote';
    },
    async tireLotsOpen(tab = 'lotes') {
      this.stockTab = tab;
      this.tireLots.movementPage = 1;
      this.tireLotIcons();
      await Promise.all([this.tireLotsLoad(), this.tireLotsLoadMovements()]);
    },
    async loadTireLotsPage() {
      if (this.isMatrixPanel() && ['lotes','lotes-movimentos'].includes(this.stockTab)) {
        await Promise.all([this.tireLotsLoad(), this.tireLotsLoadMovements()]);
      }
    },
    async tireLotsLoad(reset = false) {
      const s = this.tireLots;
      if (reset) s.page = 1;
      const request = ++s.request;
      s.loading = true; s.error = '';
      try {
        const data = await this.apiGet('/admin/api/wholesale/lots?' + new URLSearchParams({ vehicle_type: this.tireLotVehicleType || 'all',
          status: s.status, search: s.search, page: s.page }));
        if (request !== s.request) return;
        s.rows = data.rows; s.total = data.total; s.summary = data.summary;
        if (!s.rows.some(row => row.id === s.selectedId)) s.selectedId = s.rows[0]?.id || null;
        this.tireLotIcons();
      } catch (_) { if (request === s.request) { s.rows = []; s.summary = null; s.selectedId = null; s.error = 'Não foi possível consultar os lotes. Tente novamente.'; } }
      finally { if (request === s.request) s.loading = false; }
    },
    async tireLotsLoadMovements() {
      const s = this.tireLots, request = ++s.movementRequest;
      s.movementLoading = true; s.movementError = '';
      try {
        const data = await this.apiGet('/admin/api/wholesale/lot-movements?page=' + s.movementPage);
        if (request !== s.movementRequest) return;
        s.movements = data.rows; s.movementTotal = data.total; this.tireLotIcons();
      } catch (_) { if (request === s.movementRequest) { s.movements = []; s.movementError = 'Não foi possível consultar as movimentações.'; } }
      finally { if (request === s.movementRequest) s.movementLoading = false; }
    },
    async tireLotBuy() {
      this.currentPage = 'compras'; this.lotPurchaseOpen(); await this.loadCompras();
    },
    async tireLotOrigin() {
      if (!this.hasPanelModule('compras') || !this.tireLotSelected?.purchase_id || this.tireLots.originLoading) return;
      this.tireLots.originLoading = true;
      try {
        const purchase = await this.apiGet('/admin/api/wholesale/lots/' + this.tireLotSelected.id + '/purchase');
        this.currentPage = 'compras'; this.comprasTab = 'historico';
        await this.compraOpenDetails(purchase); this.tireLotIcons();
      } catch (_) { this.tireLots.error = 'Não foi possível abrir a compra de origem.'; }
      finally { this.tireLots.originLoading = false; }
    },
    tireLotSelect(id) { this.tireLots.selectedId = id; this.tireLotIcons(); },
    tireLotTrap(event) {
      const nodes = [...event.currentTarget.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')]
        .filter(node => node.offsetParent !== null && !node.closest('fieldset:disabled'));
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    },
    tireLotSeparationKey() { return 'farejador:lot-separation:' + this.serverEnvironment + ':' + (this.adminUser?.id || this.adminUser?.username || 'owner'); },
    async tireLotSeparationOpen() {
      if (this.adminUser?.role !== 'owner') return;
      const s = this.tireLots;
      s.separationOpen = true; s.separationError = '';
      try {
        const pending = JSON.parse(sessionStorage.getItem(this.tireLotSeparationKey()) || 'null');
        if (pending) { s.pending = pending; s.form = { ...pending }; }
      } catch (_) { /* The form remains usable if session storage is unavailable. */ }
      await this.tireLotSourcesLoad(); this.tireLotIcons();
      this.$nextTick(() => document.getElementById('lot-separation-title')?.focus({ preventScroll: true }));
    },
    async tireLotSourcesLoad() {
      const s = this.tireLots, request = ++s.sourceRequest;
      s.sourceLoading = true;
      try {
        const data = await this.apiGet('/admin/api/wholesale/lot-separation-sources?search=' + encodeURIComponent(s.sourceSearch));
        if (request === s.sourceRequest) s.sources = data.rows;
      } catch (_) { if (request === s.sourceRequest) { s.sources = []; s.separationError = 'Não foi possível consultar o estoque de origem.'; } }
      finally { if (request === s.sourceRequest) s.sourceLoading = false; }
    },
    async tireLotSeparationSubmit() {
      const s = this.tireLots;
      if (s.saving || this.adminUser?.role !== 'owner') return;
      s.separationError = '';
      if (!s.pending) {
        const quantity = Number(s.form.quantity);
        if (!this.tireLotSource || !Number.isInteger(quantity) || quantity < 1 || quantity > this.tireLotSource.available_quantity) {
          s.separationError = 'Selecione a origem e uma quantidade dentro do saldo disponível.'; return;
        }
        s.pending = { stock_id: s.form.stock_id, description: s.form.description.trim(), quantity,
          reason: s.form.reason.trim(), idempotency_key: crypto.randomUUID() };
        try { sessionStorage.setItem(this.tireLotSeparationKey(), JSON.stringify(s.pending)); }
        catch (_) { s.pending = null; s.separationError = 'Habilite o armazenamento desta sessão para registrar a separação com segurança.'; return; }
      }
      s.saving = true;
      try {
        const result = await this.apiPost('/admin/api/wholesale/lot-separations', s.pending);
        try { sessionStorage.removeItem(this.tireLotSeparationKey()); } catch (_) { /* Replaying the saved key is harmless. */ }
        s.pending = null; s.separationOpen = false;
        s.form = { stock_id: '', description: '', quantity: '', reason: '' }; s.selectedId = result.id;
        s.status = 'open'; s.search = ''; s.page = 1;
        await Promise.allSettled([this.tireLotsLoad(), this.tireLotsLoadMovements(), this.loadAtacado()]);
      } catch (error) {
        const code = error?.payload?.error || error?.data?.error || error?.message || '';
        const messages = { lot_source_insufficient: 'O saldo mudou. Atualize a origem e confira a quantidade.',
          lot_source_not_found: 'O estoque de origem não está mais disponível.',
          lot_source_cost_missing: 'Informe o custo no estoque de origem antes de separar.',
          invalid_body: 'Confira a descrição, a quantidade e o motivo (mínimo de 5 caracteres).' };
        const known = Object.keys(messages).find(key => code.includes(key));
        s.separationError = known ? messages[known] : 'Não foi possível confirmar. Tente novamente: a mesma separação será reutilizada.';
        if (known) {
          try { sessionStorage.removeItem(this.tireLotSeparationKey()); } catch (_) { /* No committed mutation in these validation failures. */ }
          s.pending = null; await this.tireLotSourcesLoad();
        }
      } finally { s.saving = false; }
    },
  };
};
