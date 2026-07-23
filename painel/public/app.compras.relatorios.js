// Relatórios conciliados da tela Compras. Cada fatia carrega de forma independente:
// uma falha em preços não apaga histórico, fornecedores, estoque ou financeiro.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasRelatorios = function () {
  return {
    async loadCompras() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      const baseJobs = [
        ['suppliers', this.apiGet('/admin/api/wholesale/suppliers')],
        ['measures', this.apiGet('/admin/api/wholesale/measures')],
        ['stock', this.apiGet('/admin/api/wholesale/stock')],
        ['finance', this.apiGet('/admin/api/wholesale/finance')],
      ];
      const tasks = [
        this.loadComprasOverview(), this.loadComprasHistory(),
        this.loadComprasSuppliers(), this.loadComprasPrices(),
      ];
      const base = await Promise.allSettled(baseJobs.map(([, request]) => request));
      base.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.warn(`compras ${baseJobs[index][0]} falhou:`, result.reason?.message || result.reason);
          return;
        }
        const value = result.value;
        if (baseJobs[index][0] === 'suppliers') this.fornecedores = value.rows || [];
        if (baseJobs[index][0] === 'measures') this.atacadoMeasures = value.rows || [];
        if (baseJobs[index][0] === 'stock') this.atacadoStock = value.rows || [];
        if (baseJobs[index][0] === 'finance') {
          this.atacadoFinance = value && value.enabled ? value : null;
        }
      });
      await Promise.allSettled(tasks);
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    async loadComprasOverview() {
      this.comprasLoading.overview = true;
      this.comprasErrors.overview = null;
      try {
        const report = await this.apiGet('/admin/api/wholesale/purchases/report?period=all&page=1&page_size=4');
        this.comprasOverview = report;
        this.compras = report.rows || [];
      } catch (err) {
        this.comprasErrors.overview = err.message;
      } finally {
        this.comprasLoading.overview = false;
      }
    },
    comprasHistoryQuery(overrides = {}) {
      const f = { ...this.comprasHistoryFilters, ...overrides };
      const qs = new URLSearchParams({
        period: f.period, status: f.status, payment: f.payment,
        page: String(f.page), page_size: String(f.pageSize),
      });
      if (f.search.trim()) qs.set('search', f.search.trim());
      return qs.toString();
    },
    async loadComprasHistory(resetPage = false) {
      if (resetPage) this.comprasHistoryFilters.page = 1;
      this.comprasLoading.history = true;
      this.comprasErrors.history = null;
      try {
        this.comprasHistory = await this.apiGet(
          '/admin/api/wholesale/purchases/report?' + this.comprasHistoryQuery(),
        );
      } catch (err) {
        this.comprasErrors.history = err.message;
      } finally {
        this.comprasLoading.history = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    async loadComprasSuppliers() {
      this.comprasLoading.suppliers = true;
      this.comprasErrors.suppliers = null;
      try {
        const payload = await this.apiGet('/admin/api/wholesale/suppliers/insights');
        this.comprasSuppliers = payload.rows || [];
        this.fornecedorRanking = this.comprasSuppliers;
        if (!this.comprasSupplierSelectedId && this.comprasSuppliers[0]) {
          this.comprasSupplierSelectedId = this.comprasSuppliers[0].supplier_id;
        }
      } catch (err) {
        this.comprasErrors.suppliers = err.message;
      } finally {
        this.comprasLoading.suppliers = false;
      }
    },
    comprasPricesQuery() {
      const f = this.comprasPriceFilters;
      const qs = new URLSearchParams({ period: f.period });
      if (f.supplierId) qs.set('supplier_id', f.supplierId);
      if (f.search.trim()) qs.set('search', f.search.trim());
      return qs.toString();
    },
    async loadComprasPrices() {
      this.comprasLoading.prices = true;
      this.comprasErrors.prices = null;
      try {
        const payload = await this.apiGet(
          '/admin/api/wholesale/suppliers/prices?' + this.comprasPricesQuery(),
        );
        this.comprasPriceRows = payload.rows || [];
        this.fornecedorBreakdown = this.comprasPriceRows;
        const groups = this.comprasPriceGroups();
        if (!groups.some((group) => group.measure === this.comprasPriceSelectedMeasure)) {
          this.comprasPriceSelectedMeasure = groups[0]?.measure || null;
        }
      } catch (err) {
        this.comprasErrors.prices = err.message;
      } finally {
        this.comprasLoading.prices = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    comprasOpenTab(tab) {
      this.comprasTab = tab;
      if (tab === 'historico') void this.loadComprasHistory();
      if (tab === 'fornecedores') void this.loadComprasSuppliers();
      if (tab === 'precos') void this.loadComprasPrices();
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    comprasResumo() {
      const s = this.comprasOverview.summary;
      return {
        registradas: Number(s?.purchases_count || 0),
        pneus: Number(s?.received_tires || 0),
        total: Number(s?.total_committed || 0),
        transito: Number(s?.pending_receipts || 0),
        prazo: this.atacadoFinance ? Number(this.atacadoFinance.a_pagar_total || 0) : 0,
        prazoCount: this.atacadoFinance ? Number(this.atacadoFinance.a_pagar_count || 0) : Number(s?.open_payments || 0),
      };
    },
    compraFormSummary() {
      const valid = this.compraForm.items.filter((item) =>
        item.measure && Number(item.quantity) > 0);
      return {
        tires: valid.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        measures: new Set(valid.map((item) => item.measure.trim())).size,
        total: this.compraFormTotal(),
      };
    },
    compraConsequences() {
      const rows = [{ label: 'Compra registrada', active: true }];
      if (this.compraForm.receipt_status === 'received') {
        rows.push({ label: 'Galpão e custo médio atualizados', active: true });
        rows.push({ label: 'Movimento gravado no filme', active: true });
      } else {
        rows.push({ label: 'Galpão não muda até o recebimento', active: false });
      }
      if (this.compraForm.payment_status === 'pending' && this.atacadoFinance) {
        rows.push({ label: 'Título criado em Contas a pagar', active: true });
      } else {
        rows.push({ label: 'Pagamento registrado no caixa', active: true });
      }
      return rows;
    },
    compraPaymentLabel(row) {
      if (row.payment_status === 'paid') return 'Pago';
      return 'A pagar' + (row.due_date ? ' · ' + this.financeDate(row.due_date) : '');
    },
    compraReceiptLabel(row) {
      if (row.status === 'cancelled') return row.stock_applied ? 'Recebida antes do cancelamento' : 'Não recebida';
      return row.stock_applied ? 'Recebido' : 'Aguardando';
    },
    comprasHistoryPageNumbers() {
      const current = Number(this.comprasHistory.pagination?.page || 1);
      const pages = Number(this.comprasHistory.pagination?.pages || 1);
      const start = Math.max(1, Math.min(current - 2, pages - 4));
      return Array.from({ length: Math.min(5, pages) }, (_, index) => start + index);
    },
    comprasHistoryPage(page) {
      if (page < 1 || page > Number(this.comprasHistory.pagination?.pages || 1)) return;
      this.comprasHistoryFilters.page = page;
      void this.loadComprasHistory();
    },
    comprasSupplierRows() {
      const search = this.comprasSupplierSearch.trim().toLowerCase();
      if (!search) return this.comprasSuppliers;
      return this.comprasSuppliers.filter((row) =>
        [row.name, row.phone, row.document].some((value) =>
          String(value || '').toLowerCase().includes(search)));
    },
    comprasSupplierSelected() {
      return this.comprasSuppliers.find((row) =>
        row.supplier_id === this.comprasSupplierSelectedId) || null;
    },
    comprasSupplierCards() {
      const rows = this.comprasSuppliers;
      const purchases = rows.reduce((sum, row) => sum + Number(row.purchases_count || 0), 0);
      const total = rows.reduce((sum, row) => sum + Number(row.total_spent || 0), 0);
      return {
        active: rows.length,
        top: rows[0] || null,
        ticket: purchases ? total / purchases : 0,
        stale: rows.filter((row) => Number(row.days_since_last || 0) > 60).length,
      };
    },
    comprasSupplierSelect(row) {
      this.comprasSupplierSelectedId = row.supplier_id;
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    comprasSupplierHistory(row) {
      this.comprasHistoryFilters = {
        ...this.comprasHistoryFilters, search: row.name, status: 'all', payment: 'all', page: 1,
      };
      this.comprasOpenTab('historico');
    },
    comprasSupplierInitials(row) {
      return String(row?.name || '?').split(/\s+/).filter(Boolean).slice(0, 2)
        .map((part) => part[0].toUpperCase()).join('');
    },
    comprasPriceGroups() {
      const groups = new Map();
      for (const row of this.comprasPriceRows) {
        if (!groups.has(row.measure)) groups.set(row.measure, []);
        groups.get(row.measure).push({ ...row });
      }
      return [...groups.entries()].map(([measure, rows]) => {
        rows.sort((a, b) => Number(a.avg_cost) - Number(b.avg_cost));
        const best = Number(rows[0]?.avg_cost || 0);
        rows.forEach((row, index) => {
          row.cheapest = index === 0;
          row.diff_pct = best > 0 ? ((Number(row.avg_cost) - best) / best) * 100 : 0;
        });
        return { measure, suppliers: rows, qty: rows.reduce((sum, row) => sum + Number(row.qty_total || 0), 0) };
      }).sort((a, b) => b.qty - a.qty || a.measure.localeCompare(b.measure));
    },
    comprasPriceSelected() {
      return this.comprasPriceGroups().find((group) =>
        group.measure === this.comprasPriceSelectedMeasure) || null;
    },
    comprasPriceCards() {
      const groups = this.comprasPriceGroups();
      const wins = new Map();
      const spreads = [];
      for (const group of groups) {
        const first = group.suppliers[0];
        if (first) wins.set(first.supplier_name, (wins.get(first.supplier_name) || 0) + 1);
        if (group.suppliers.length > 1 && Number(first?.avg_cost) > 0) {
          const last = group.suppliers[group.suppliers.length - 1];
          spreads.push(((Number(last.avg_cost) - Number(first.avg_cost)) / Number(first.avg_cost)) * 100);
        }
      }
      const top = [...wins.entries()].sort((a, b) => b[1] - a[1])[0] || null;
      return {
        measures: groups.length,
        top: top ? { name: top[0], count: top[1] } : null,
        spread: spreads.length ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length : 0,
      };
    },
    comprasUsePrice(row) {
      if (!row.supplier_archived) this.compraForm.supplierKey = row.supplier_id;
      let item = this.compraForm.items.find((candidate) => !candidate.measure);
      if (!item) {
        this.compraAddItem();
        item = this.compraForm.items[this.compraForm.items.length - 1];
      }
      item.measure = row.measure;
      this.compraMsg = {
        ok: true,
        text: row.supplier_archived
          ? 'Medida preenchida. Escolha um fornecedor ativo e confirme o custo atual — o preço histórico não foi copiado.'
          : 'Medida e fornecedor preenchidos. Confirme o custo atual — o preço histórico não foi copiado.',
      };
      this.comprasOpenTab('nova');
    },
    async comprasExportCsv() {
      const rows = [];
      let page = 1;
      let pages = 1;
      do {
        const report = await this.apiGet('/admin/api/wholesale/purchases/report?'
          + this.comprasHistoryQuery({ page, pageSize: 100 }));
        rows.push(...(report.rows || []));
        pages = Number(report.pagination?.pages || 1);
        page += 1;
      } while (page <= pages);
      const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
      const header = ['Data', 'Fornecedor', 'Pneus', 'Total', 'Pagamento', 'Recebimento', 'Status'];
      const lines = rows.map((row) => [
        this.compraData(row), row.supplier_name, row.items_count, row.total_amount,
        row.payment_status === 'paid' ? 'Pago' : 'A pagar',
        row.stock_applied ? 'Recebido' : 'Aguardando', row.status,
      ].map(quote).join(';'));
      const blob = new Blob(['\uFEFF' + [header.map(quote).join(';'), ...lines].join('\n')],
        { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `compras-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    },
  };
};
