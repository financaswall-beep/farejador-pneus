// Estoque do parceiro no casco moderno. A tela usa exclusivamente as rotas
// operacionais escopadas por unidade; custo e rotas administrativas da Matriz
// nunca entram neste adaptador.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerEstoque = function () {
  const emptyPending = () => ({ item_registrations: 0, stock_counts: 0 });
  return {
    partnerEstoque: {
      rows: [], pending: emptyPending(), loading: false, error: null, notice: '',
      busca: '', filtro: 'todos', request: 0, selected: null,
      history: [], historyPage: 1, historyTotal: 0, historyMore: false,
      detailLoading: false, detailError: null,
      count: { open: false, row: null, quantity: '', reason: 'rotina', detail: '', saving: false, error: '' },
    },

    async loadPartnerEstoque() {
      if (!this.isPartnerPanel() || !this.hasPanelModule('estoque')) return;
      const request = ++this.partnerEstoque.request;
      this.partnerEstoque.loading = true;
      this.partnerEstoque.error = null;
      const started = performance.now();
      try {
        const priceRequest = this.hasPanelModule('estoque')
          ? this.partnerApiGet('operacao/estoque-valores').catch(() => ({ rows: [] }))
          : Promise.resolve({ rows: [] });
        const [payload, pricePayload] = await Promise.all([
          this.partnerApiGet('operacao/estoque'), priceRequest,
        ]);
        if (request !== this.partnerEstoque.request) return;
        const prices = new Map((pricePayload.rows || []).map((row) => [row.stock_id, row.sale_price]));
        this.partnerEstoque.rows = (Array.isArray(payload.rows) ? payload.rows : [])
          .map((row) => ({ ...row, sale_price: prices.get(row.stock_id) ?? null }));
        this.partnerEstoque.pending = payload.pending || emptyPending();
        void this.partnerPanelTelemetry({
          page: 'estoque', event_type: 'read', operation: 'load_stock', outcome: 'success',
          duration_ms: Math.max(0, Math.round(performance.now() - started)), status_code: 200,
        });
      } catch (error) {
        if (request !== this.partnerEstoque.request) return;
        this.partnerEstoque.error = 'Não foi possível carregar o estoque desta unidade.';
        void this.partnerPanelTelemetry({
          page: 'estoque', event_type: 'read', operation: 'load_stock', outcome: 'error',
          duration_ms: Math.max(0, Math.round(performance.now() - started)),
          status_code: error?.status || null, error_code: this.partnerPanelErrorCode(error),
        });
      } finally {
        if (request === this.partnerEstoque.request) this.partnerEstoque.loading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    partnerEstoqueSummary() {
      const products = this.partnerEstoque.rows.filter((row) => row.item_type !== 'servico');
      return products.reduce((summary, row) => {
        summary.items += 1;
        summary.onHand += Number(row.quantity_on_hand || 0);
        summary.reserved += Number(row.quantity_reserved || 0);
        summary.available += Number(row.quantity_available || 0);
        if (['low_stock', 'out_of_stock', 'reserved'].includes(row.stock_status)) summary.low += 1;
        return summary;
      }, { items: 0, onHand: 0, reserved: 0, available: 0, low: 0 });
    },

    partnerEstoqueFiltered() {
      const query = String(this.partnerEstoque.busca || '').trim().toLocaleLowerCase('pt-BR');
      return this.partnerEstoque.rows.filter((row) => {
        if (row.item_type === 'servico') return false;
        const low = ['low_stock', 'out_of_stock', 'reserved'].includes(row.stock_status);
        const matchesFilter = this.partnerEstoque.filtro === 'todos'
          || (this.partnerEstoque.filtro === 'criticos' && low)
          || (this.partnerEstoque.filtro === 'reservados' && Number(row.quantity_reserved || 0) > 0)
          || (this.partnerEstoque.filtro === 'sem_saldo' && Number(row.quantity_available || 0) <= 0);
        if (!matchesFilter) return false;
        if (!query) return true;
        return [row.tire_size, row.brand]
          .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(query);
      });
    },

    partnerEstoqueRecent(limit = 4) {
      return this.partnerEstoque.rows
        .filter((row) => row.item_type !== 'servico')
        .slice()
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
        .slice(0, Math.max(1, Number(limit) || 4));
    },

    partnerEstoqueOpenEntry() {
      if (!this.isPartnerPanel?.() || !this.hasPanelModule?.('estoque')) {
        this.partnerEstoque.notice = 'Seu acesso não permite alterar o estoque.';
        return;
      }
      if (!this.hasPanelModule?.('compras') || typeof this.partnerComprasNew !== 'function') {
        this.partnerEstoque.notice = 'Libere o módulo Compras para registrar a entrada pelo fluxo seguro.';
        return;
      }
      this.currentPage = 'compras';
      this.partnerComprasNew();
    },

    partnerEstoqueOpenCatalog() {
      if (!this.hasPanelModule?.('catalogo')) return;
      this.currentPage = 'catalogo';
      if (typeof this.loadPartnerCatalogo === 'function') void this.loadPartnerCatalogo(1);
    },

    partnerEstoqueStatus(row) {
      if (row.item_type === 'servico') return { label: 'Serviço ativo', cls: 'bg-emerald-50 text-emerald-700' };
      const statuses = {
        in_stock: { label: 'Disponível', cls: 'bg-emerald-50 text-emerald-700' },
        low_stock: { label: 'Estoque baixo', cls: 'bg-amber-50 text-amber-700' },
        out_of_stock: { label: 'Sem estoque', cls: 'bg-gray-100 text-gray-700' },
        reserved: { label: 'Todo reservado', cls: 'bg-gray-100 text-gray-700' },
        untracked: { label: 'Não controlado', cls: 'bg-gray-100 text-gray-600' },
      };
      return statuses[row.stock_status] || statuses.in_stock;
    },

    partnerEstoqueIdentity(row) {
      return row.tire_size || row.item_name || 'Item sem identificação';
    },

    partnerEstoqueCondition(row) {
      return { novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' }[row.tire_condition] || '';
    },

    async partnerEstoqueOpen(row) {
      const started = performance.now();
      this.partnerEstoque.selected = row;
      this.partnerEstoque.history = [];
      this.partnerEstoque.detailLoading = true;
      this.partnerEstoque.detailError = null;
      try {
        const payload = await this.partnerApiGet(`operacao/estoque/${encodeURIComponent(row.stock_id)}?page=1&limit=20`);
        this.partnerEstoque.selected = payload.stock || row;
        this.partnerEstoque.history = payload.history?.rows || [];
        this.partnerEstoque.historyPage = 1;
        this.partnerEstoque.historyTotal = Number(payload.history?.total || 0);
        this.partnerEstoque.historyMore = Boolean(payload.history?.has_more);
        void this.partnerPanelTelemetry({
          page: 'estoque', event_type: 'read', operation: 'load_stock_detail', outcome: 'success',
          duration_ms: Math.max(0, Math.round(performance.now() - started)), status_code: 200,
        });
      } catch (error) {
        this.partnerEstoque.detailError = 'Não foi possível carregar as movimentações deste item.';
        void this.partnerPanelTelemetry({
          page: 'estoque', event_type: 'read', operation: 'load_stock_detail', outcome: 'error',
          duration_ms: Math.max(0, Math.round(performance.now() - started)),
          status_code: error?.status || null, error_code: this.partnerPanelErrorCode(error),
        });
      } finally {
        this.partnerEstoque.detailLoading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    partnerEstoqueClose() {
      this.partnerEstoque.selected = null;
      this.partnerEstoque.history = [];
      this.partnerEstoque.detailError = null;
    },

    async partnerEstoqueMore() {
      const row = this.partnerEstoque.selected;
      if (!row || !this.partnerEstoque.historyMore || this.partnerEstoque.detailLoading) return;
      const page = this.partnerEstoque.historyPage + 1;
      this.partnerEstoque.detailLoading = true;
      try {
        const payload = await this.partnerApiGet(`operacao/estoque/${encodeURIComponent(row.stock_id)}?page=${page}&limit=20`);
        this.partnerEstoque.history.push(...(payload.history?.rows || []));
        this.partnerEstoque.historyPage = page;
        this.partnerEstoque.historyMore = Boolean(payload.history?.has_more);
      } catch (_) {
        this.partnerEstoque.detailError = 'Não foi possível carregar mais movimentações.';
      } finally {
        this.partnerEstoque.detailLoading = false;
      }
    },

    partnerEstoqueMovement(row) {
      const labels = {
        purchase: 'Recebimento de compra', purchase_cancel: 'Estorno de compra',
        sale: 'Venda confirmada', sale_cancel: 'Cancelamento de venda',
        count: 'Contagem aprovada', registration: 'Cadastro aprovado',
        update: 'Cadastro atualizado', price: 'Preço atualizado',
        reservation: 'Reserva criada', reservation_release: 'Reserva liberada',
      };
      return labels[row.kind] || 'Movimentação';
    },

    partnerEstoqueOpenCount(row) {
      this.partnerEstoque.count = {
        open: true, row, quantity: row.quantity_on_hand ?? '', reason: 'rotina',
        detail: '', saving: false, error: '',
      };
    },

    partnerEstoqueCloseCount() {
      if (!this.partnerEstoque.count.saving) this.partnerEstoque.count.open = false;
    },

    async partnerEstoqueSubmitCount() {
      const count = this.partnerEstoque.count;
      const quantity = Number(count.quantity);
      if (!count.row || !Number.isInteger(quantity) || quantity < 0 || quantity > 999999) {
        count.error = 'Informe uma quantidade inteira válida.';
        return;
      }
      if (quantity < Number(count.row.quantity_reserved || 0)) {
        count.error = 'A contagem não pode ficar abaixo do que já está reservado.';
        return;
      }
      count.saving = true;
      count.error = '';
      const started = performance.now();
      try {
        const uuid = crypto.randomUUID();
        await this.partnerApiWrite('operacao/estoque/contagens', 'POST', {
          stock_id: count.row.stock_id, counted_quantity: quantity,
          reason: count.reason,
          reason_detail: String(count.detail || '').trim() || null,
          idempotency_key: `panel-count-${uuid}`,
        });
        this.partnerEstoque.notice = 'Contagem enviada para aprovação do proprietário.';
        count.open = false;
        void this.partnerPanelTelemetry({
          page: 'estoque', event_type: 'write', operation: 'request_stock_count', outcome: 'success',
          duration_ms: Math.max(0, Math.round(performance.now() - started)), status_code: 202,
        });
        await this.loadPartnerEstoque();
      } catch (error) {
        count.error = error?.code === 'stock_unavailable_for_count'
          ? 'Este item mudou. Atualize o estoque e tente novamente.'
          : 'Não foi possível enviar a contagem.';
        void this.partnerPanelTelemetry({
          page: 'estoque', event_type: 'write', operation: 'request_stock_count', outcome: 'error',
          duration_ms: Math.max(0, Math.round(performance.now() - started)),
          status_code: error?.status || null, error_code: this.partnerPanelErrorCode(error),
        });
      } finally {
        count.saving = false;
      }
    },
  };
};
