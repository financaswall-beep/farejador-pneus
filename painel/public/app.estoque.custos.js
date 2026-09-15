window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.estoqueCustos = function () {
  const number = value => Number(value || 0);
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return {
    async stockCostsOpen() { this.stockTab = 'custos'; await this.loadStockCostsPage(); },
    async loadStockCostsPage() {
      if (!this.isMatrixPanel() || this.stockTab !== 'custos') return;
      const s = this.stockCosts, request = ++s.request;
      s.loading = true; s.error = ''; s.data = null; s.detail = null;
      try {
        const data = await this.apiGet('/admin/api/wholesale/stock/costs');
        if (request !== s.request) return;
        s.data = data; this.$nextTick(() => window.lucide?.createIcons());
      } catch (_) {
        if (request === s.request) s.error = 'Não foi possível consultar os custos do estoque. Tente novamente.';
      } finally { if (request === s.request) s.loading = false; }
    },
    get scSummary() { return this.stockCosts.data?.summary || {}; },
    get scRows() {
      const s = this.stockCosts, term = normalize(s.search), catalog = s.mode === 'catalog';
      return (s.data?.[s.mode] || []).filter(row =>
        (!catalog || !s.condition || row.tire_condition === s.condition)
        && normalize(catalog ? row.measure : row.lot_code + ' ' + row.description).includes(term));
    },
    get scTotals() {
      return this.scRows.reduce((total, row) => {
        for (const key of ['quantity_on_hand','quantity_reserved','quantity_available']) total[key] += number(row[key]);
        total.cents += Math.round(number(row.capital) * 100);
        return total;
      }, { quantity_on_hand: 0, quantity_reserved: 0, quantity_available: 0, cents: 0 });
    },
    get scTop() { return (this.stockCosts.data?.catalog || []).filter(row => number(row.capital) > 0).slice(0, 5); },
    get scStep() {
      const rough = number(this.scTop[0]?.capital) / 6;
      if (!rough) return 1;
      const magnitude = 10 ** Math.floor(Math.log10(rough));
      return [1, 2, 5, 10].find(step => step * magnitude >= rough) * magnitude;
    },
    get scScale() { return Math.max(this.scStep, Math.ceil(number(this.scTop[0]?.capital) / this.scStep) * this.scStep); },
    get scTicks() { return Array.from({ length: Math.round(this.scScale / this.scStep) + 1 }, (_, index) => index * this.scStep); },
    scPercent(value, total) { return number(total) > 0 ? (number(value) / number(total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—'; },
    scQuantity(value) { return number(value).toLocaleString('pt-BR'); },
    scCondition(value) { return ({ meia_vida: 'Meia-vida', novo: 'Novo', remold: 'Remold' })[value] || value || '—'; },
    scMode(mode) { this.stockCosts.mode = mode; this.stockCosts.search = ''; this.stockCosts.detail = null; },
    async scLot(row) {
      this.tireLots.status = 'open'; this.tireLots.search = row?.lot_code || '';
      this.tireLots.page = 1; this.tireLots.selectedId = row?.id || null;
      await this.tireLotsOpen();
    },
    scDialog(type, row = null) {
      this._scFocusReturn = document.activeElement;
      this.stockCosts.detail = row; this.stockCosts.dialog = type;
      this.$nextTick(() => { window.lucide?.createIcons(); document.getElementById('sc-dialog-close')?.focus(); });
    },
    scClose() { this.stockCosts.dialog = ''; this.$nextTick(() => this._scFocusReturn?.focus()); },
    scDialogKeys(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.scClose(); }
      if (event.key !== 'Tab') return;
      const nodes = [...event.currentTarget.querySelectorAll('button, a[href], input, select, [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
    },
    scCsv() {
      const catalog = this.stockCosts.mode === 'catalog';
      const money = value => number(value).toFixed(2).replace('.', ',');
      const records = [
        ['Custos do estoque', new Date(this.stockCosts.data.as_of).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })],
        ['Recorte', catalog ? 'Pneus cadastrados' : 'Lotes', 'Condição', catalog ? this.scCondition(this.stockCosts.condition || 'Todas') : 'Não se aplica', 'Busca', this.stockCosts.search],
        [catalog ? 'Medida' : 'Lote', catalog ? 'Condição' : 'Descrição', 'Em estoque', 'Reservados', 'Disponíveis', 'Custo médio', 'Capital', 'Pneus com custo zero'],
        ...this.scRows.map(row => [catalog ? row.measure : row.lot_code, catalog ? this.scCondition(row.tire_condition) : row.description,
          row.quantity_on_hand, row.quantity_reserved, row.quantity_available, money(row.unit_cost), money(row.capital), row.zero_cost_quantity]),
        ['Total do filtro', '', this.scTotals.quantity_on_hand, this.scTotals.quantity_reserved, this.scTotals.quantity_available, '', money(this.scTotals.cents / 100)],
        ['Reservados continuam no capital até a saída. Compras a caminho ficam fora deste total.']
      ];
      // Spreadsheet formula injection protection applies to descriptions and search text too.
      return '\uFEFF' + records.map(row => row.map(value => {
        let cell = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/.test(cell)) cell = "'" + cell;
        return '"' + cell.replace(/"/g, '""') + '"';
      }).join(';')).join('\r\n');
    },
    scExport() {
      if (!this.stockCosts.data || this.stockCosts.loading) return;
      const url = URL.createObjectURL(new Blob([this.scCsv()], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url;
      link.download = 'custos-estoque-' + this.stockCosts.mode + '-' + this.stockCosts.data.as_of.slice(0, 10) + '.csv';
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };
};
