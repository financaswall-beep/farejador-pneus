window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_STOCK_PREVIEW = {
  enabled() {
    const local = ['localhost', '127.0.0.1', '::1'].includes(window.location?.hostname || '');
    return local && /(?:^|[?&])mock=1(?:&|$)/.test(window.location?.search || '');
  },
  rows: [
    { measure: '215/75 R17.5', brand: 'Roadmax', quantity_on_hand: 42, min_quantity: 18, unit_cost: 748.90, notes: 'Linha pesada · giro alto' },
    { measure: '90/90-18', brand: 'Pirelli', quantity_on_hand: 15, min_quantity: 10, unit_cost: 184.60, notes: 'Linha 2W · reposição semanal' },
    { measure: '90/90-18', brand: 'Metzeler', quantity_on_hand: 12, min_quantity: 10, unit_cost: 169.90, notes: 'Mesma medida · marca independente' },
    { measure: '175/70 R14', brand: 'Pirelli', quantity_on_hand: 18, min_quantity: 15, unit_cost: 312.40, notes: 'Giro estável no balcão' },
    { measure: '185/65 R15', brand: 'Michelin', quantity_on_hand: 8, min_quantity: 12, unit_cost: 346.80, notes: 'Repor no próximo pedido' },
    { measure: '205/55 R16', brand: 'Dunlop', quantity_on_hand: 4, min_quantity: 8, unit_cost: 438.50, notes: 'Saldo abaixo do mínimo' },
    { measure: '195/60 R15', brand: 'Rinaldi', quantity_on_hand: 0, min_quantity: 6, unit_cost: 368.90, notes: 'Sem saldo · prioridade de compra' },
  ],
  movements: [
    { created_at: '2026-07-24T12:42:00-03:00', source: 'venda_atacado', measure: '195/60 R15', brand: 'Rinaldi', qty_delta: -3, qty_before: 3, qty_after: 0, cost_before: 368.90, cost_after: 368.90, reason: 'Borracharia Central', ref: 'ATC-2842' },
    { created_at: '2026-07-24T11:18:00-03:00', source: 'compra', measure: '215/75 R17.5', brand: 'Roadmax', qty_delta: 18, qty_before: 24, qty_after: 42, cost_before: 732.40, cost_after: 748.90, reason: 'Fornecedor Estrada', ref: 'CMP-731' },
    { created_at: '2026-07-24T10:05:00-03:00', source: 'varejo', measure: '185/65 R15', brand: 'Michelin', qty_delta: -4, qty_before: 12, qty_after: 8, cost_before: 346.80, cost_after: 346.80, reason: 'Pedido #2841', ref: '2841' },
    { created_at: '2026-07-24T09:14:00-03:00', source: 'baixa_manual', measure: '205/55 R16', brand: 'Dunlop', qty_delta: -1, qty_before: 5, qty_after: 4, cost_before: 438.50, cost_after: 438.50, reason: 'quebra: lateral danificada', ref: 'BXM-81' },
    { created_at: '2026-07-23T17:36:00-03:00', source: 'venda_atacado', measure: '205/55 R16', brand: 'Dunlop', qty_delta: -5, qty_before: 10, qty_after: 5, cost_before: 438.50, cost_after: 438.50, reason: 'Pneus Sul', ref: 'ATC-2839' },
    { created_at: '2026-07-23T15:20:00-03:00', source: 'entrada', measure: '90/90-18', brand: 'Metzeler', qty_delta: 12, qty_before: 0, qty_after: 12, cost_before: null, cost_after: 169.90, reason: 'Wallace', ref: 'ENT-184' },
    { created_at: '2026-07-23T09:14:00-03:00', source: 'varejo', measure: '175/70 R14', brand: 'Pirelli', qty_delta: -2, qty_before: 20, qty_after: 18, cost_before: 312.40, cost_after: 312.40, reason: 'Pedido #2830', ref: '2830' },
  ].concat(Array.from({ length: 22 }, (_, index) => ({
    created_at: `2026-07-22T${String(21 - index).padStart(2, '0')}:10:00-03:00`, source: index % 3 === 0 ? 'entrada' : 'varejo',
    measure: ['215/75 R17.5', '90/90-18', '175/70 R14', '185/65 R15'][index % 4],
    brand: ['Roadmax', 'Pirelli', 'Pirelli', 'Michelin'][index % 4], qty_delta: index % 3 === 0 ? 2 : -1,
    qty_before: 20 + index, qty_after: 20 + index + (index % 3 === 0 ? 2 : -1), cost_before: 320, cost_after: 320,
    reason: 'Histórico demonstrativo', ref: `MOV-${String(index + 1).padStart(3, '0')}`,
  }))),
  reconciliation: {
    summary: { total: 7, aligned: 6, divergent: 1, catalog_only: 0 },
    rows: [
      { key: '21575175:roadmax', official_measures: ['215/75 R17.5'], official_brand: 'Roadmax', catalog_measures: ['215/75 R17.5'], catalog_brands: ['Roadmax'], official_quantity: 42, legacy_quantity: 42, official_unit_cost: 748.90, status: 'aligned' },
      { key: '909018:pirelli', official_measures: ['90/90-18'], official_brand: 'Pirelli', catalog_measures: ['90/90-18'], catalog_brands: ['Pirelli'], official_quantity: 15, legacy_quantity: 15, official_unit_cost: 184.60, status: 'aligned' },
      { key: '909018:metzeler', official_measures: ['90/90-18'], official_brand: 'Metzeler', catalog_measures: ['90/90-18'], catalog_brands: ['Metzeler'], official_quantity: 12, legacy_quantity: 12, official_unit_cost: 169.90, status: 'aligned' },
      { key: '1757014:pirelli', official_measures: ['175/70 R14'], official_brand: 'Pirelli', catalog_measures: ['175/70 R14'], catalog_brands: ['Pirelli'], official_quantity: 18, legacy_quantity: 18, official_unit_cost: 312.40, status: 'aligned' },
      { key: '1856515:michelin', official_measures: ['185/65 R15'], official_brand: 'Michelin', catalog_measures: ['185/65 R15'], catalog_brands: ['Michelin'], official_quantity: 8, legacy_quantity: 8, official_unit_cost: 346.80, status: 'aligned' },
      { key: '2055516:dunlop', official_measures: ['205/55 R16'], official_brand: 'Dunlop', catalog_measures: ['205/55 R16'], catalog_brands: ['Dunlop'], official_quantity: 4, legacy_quantity: 5, official_unit_cost: 438.50, status: 'quantity_divergent' },
      { key: '1956015:rinaldi', official_measures: ['195/60 R15'], official_brand: 'Rinaldi', catalog_measures: ['195/60 R15'], catalog_brands: ['Rinaldi'], official_quantity: 0, legacy_quantity: 0, official_unit_cost: 368.90, status: 'aligned' },
    ],
  },
};
window.PAINEL_MODULES.atacado = function () { return {
    atacadoBuyerKey(b) {
      return b.customer_id ? `c:${b.customer_id}` : `p:${b.partner_id}`;
    },
    async loadAtacadoVendas() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      this.atacadoLoading = true;
      const jobs = [
        ['buyers', this.apiGet('/admin/api/wholesale/buyers')],
        ['ranking', this.apiGet('/admin/api/wholesale/ranking')],
        ['measures', this.apiGet('/admin/api/wholesale/measures')],
        ['stock', this.apiGet('/admin/api/wholesale/stock')],
        ['resumo', this.apiGet('/admin/api/wholesale/resumo?period=' + this.vendasPeriodo)],
        ['finance', this.apiGet('/admin/api/wholesale/finance')],
        ['vendas', this.apiGet('/admin/api/wholesale/sales')],
        ['cargo', this.apiGet('/admin/api/wholesale/cargo')],
      ];
      try {
        const values = await Promise.all(jobs.map(([, request]) => request));
        values.forEach((value, index) => {
          const key = jobs[index][0];
          if (key === 'buyers') this.atacadoBuyers = value.rows || [];
          if (key === 'ranking') this.atacadoRanking = value.rows || [];
          if (key === 'measures') this.atacadoMeasures = value.rows || [];
          if (key === 'stock') this.atacadoStock = value.rows || [];
          if (key === 'resumo') this.atacadoResumo = value || null;
          if (key === 'finance') this.atacadoFinance = value && value.enabled ? value : null;
          if (key === 'vendas') this.atacadoVendas = value.rows || [];
          if (key === 'cargo') this.atacadoCargo = (value.data || []).map((row) => ({ ...row, return_reason: '' }));
        });
        if (window.PAINEL_STOCK_PREVIEW?.enabled()) {
          this.atacadoStock = window.PAINEL_STOCK_PREVIEW.rows.map((row) => ({ ...row }));
          this.atacadoMeasures = window.PAINEL_STOCK_PREVIEW.rows.map((row) => ({ ...row }));
        }
      } catch (error) {
        this.vendasDataError = 'Não foi possível atualizar o atacado. Os dados anteriores foram preservados.';
        throw error;
      } finally {
        this.atacadoLoading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    async loadAtacado() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      this.atacadoLoading = true;
      const jobs = [
        ['buyers', this.apiGet('/admin/api/wholesale/buyers')],
        ['ranking', this.apiGet('/admin/api/wholesale/ranking')],
        ['measures', this.apiGet('/admin/api/wholesale/measures')],
        ['stock', this.apiGet('/admin/api/wholesale/stock')],
        ['resumo', this.apiGet('/admin/api/wholesale/resumo?period=' + this.atacadoPeriodo)],
        ['suppliers', this.apiGet('/admin/api/wholesale/suppliers')],
        ['supplierRanking', this.apiGet('/admin/api/wholesale/suppliers/ranking')],
        ['purchases', this.apiGet('/admin/api/wholesale/purchases')],
        ['breakdown', this.apiGet('/admin/api/wholesale/suppliers/breakdown')],
        ['finance', this.apiGet('/admin/api/wholesale/finance')],
        ['sales', this.apiGet('/admin/api/wholesale/sales')],
        ['cargo', this.apiGet('/admin/api/wholesale/cargo')],
      ];
      try {
        const settled = await Promise.allSettled(jobs.map(([, request]) => request));
        settled.forEach((result, index) => {
          const key = jobs[index][0];
          if (result.status === 'rejected') {
            console.warn(`atacado ${key} falhou:`, result.reason?.message || result.reason);
            return;
          }
          const value = result.value;
          if (key === 'buyers') this.atacadoBuyers = value.rows || [];
          if (key === 'ranking') this.atacadoRanking = value.rows || [];
          if (key === 'measures') this.atacadoMeasures = value.rows || [];
          if (key === 'stock') this.atacadoStock = value.rows || [];
          if (key === 'resumo') this.atacadoResumo = value || null;
          if (key === 'suppliers') this.fornecedores = value.rows || [];
          if (key === 'supplierRanking') this.fornecedorRanking = value.rows || [];
          if (key === 'purchases') this.compras = value.rows || [];
          if (key === 'breakdown') this.fornecedorBreakdown = value.rows || [];
          if (key === 'finance') this.atacadoFinance = value && value.enabled ? value : null;
          if (key === 'sales') this.atacadoVendas = value.rows || [];
          if (key === 'cargo') this.atacadoCargo = (value.data || []).map((row) => ({ ...row, return_reason: '' }));
        });
        if (window.PAINEL_STOCK_PREVIEW?.enabled()) {
          this.atacadoStock = window.PAINEL_STOCK_PREVIEW.rows.map((row) => ({ ...row }));
          this.atacadoMeasures = window.PAINEL_STOCK_PREVIEW.rows.map((row) => ({ ...row }));
        }
      } finally {
        this.atacadoLoading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    atacadoAddItem() {
      this.atacadoForm.items.push({
        measure: '', brand: '', tire_condition: '', quantity: 1, unit_price: '',
      });
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    atacadoRemoveItem(i) {
      if (this.atacadoForm.items.length > 1) this.atacadoForm.items.splice(i, 1);
    },
    atacadoFormTotal() {
      const cents = this.atacadoForm.items.reduce((sum, item) => {
        const quantity = Number(item.quantity) || 0;
        const unitCents = Math.round((Number(item.unit_price) || 0) * 100);
        return sum + quantity * unitCents;
      }, 0);
      return cents / 100;
    },
    atacadoResumoKpis() {
      const vendas = Number(this.atacadoResumo?.vendas_count || 0);
      const total = Number(this.atacadoResumo?.faturamento || 0);
      const canceladas = Number(this.atacadoResumo?.cancelled_count || 0);
      return { vendas, total, canceladas, ticket: vendas ? total / vendas : 0, cancelPct: vendas + canceladas ? (canceladas / (vendas + canceladas)) * 100 : 0 };
    },
    atacadoBuyerSelecionado() {
      const key = this.atacadoForm.buyerKey;
      if (!key || key === 'new') return null;
      const buyer = this.atacadoBuyers.find((b) => this.atacadoBuyerKey(b) === key);
      const id = key.slice(2);
      const ranking = this.atacadoRanking.find((b) => key.startsWith('c:') ? b.buyer_id === id : b.partner_id === id);
      return buyer ? { ...buyer, ...(ranking || {}) } : (ranking || null);
    },
    atacadoBuyerInitials(b) {
      return String(b?.name || 'AT').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
    },
    atacadoVendasPeriodo() {
      return this.atacadoVendas.filter((v) => this.vendaNoPeriodo(v.sold_at));
    },
    atacadoVendaItens(v) {
      const items = v?.items || [];
      const quantidade = items.reduce((sum, item) => sum
        + Number(item.accepted_quantity ?? item.quantity ?? 0), 0);
      return `${quantidade} pneu(s) · ${items.map((item) => item.measure).filter(Boolean).join(', ') || 'sem medida'}`;
    },
    atacadoMedidasMaisVendidas() {
      const totais = new Map();
      this.atacadoVendasPeriodo().filter((v) => v.status === 'confirmed').forEach((v) => (v.items || []).forEach((item) => {
        if (v.partner_transfer_status === 'in_transit') return;
        totais.set(item.measure, (totais.get(item.measure) || 0)
          + Number(item.accepted_quantity ?? item.quantity ?? 0));
      }));
      const rows = [...totais].map(([medida, quantidade]) => ({ medida, quantidade })).sort((a, b) => b.quantidade - a.quantidade).slice(0, 5);
      const max = rows[0]?.quantidade || 1;
      return rows.map((row) => ({ ...row, pct: (row.quantidade / max) * 100 }));
    },
    abrirHistoricoAtacado(b) {
      this.vendasHistoricoCanal = 'atacado';
      this.vendasBusca = b?.name || '';
      this.vendasTab = 'historico';
    },
    atacadoLastPurchase(b) {
      if (!b?.last_purchase_at) return '—';
      return window.FarejadorTime.formatDate(b.last_purchase_at);
    },
    atacadoStatus(b) {
      if (!Number(b?.orders_count)) return { label: 'nunca comprou', cls: 'bg-amber-50 text-amber-700', dot: 'bg-amber-400' };
      if (b?.days_since_last != null && Number(b.days_since_last) > this.atacadoStaleDays)
        return { label: `sumiu (${b.days_since_last}d)`, cls: 'bg-rose-50 text-rose-600', dot: 'bg-rose-400' };
      return { label: 'ativo', cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' };
    },
    reciboWhatsLink(v) {
      if (!v) return null;
      if (v.partner_transfer_status === 'in_transit') return null;
      const digits = String(v.buyer_phone || '').replace(/\D/g, '');
      if (!digits || v.status !== 'confirmed') return null;
      const tel = digits.startsWith('55') ? digits : '55' + digits;
      const data = new Date(v.sold_at);
      const linhas = (v.items || []).map((it) =>
        `• ${it.accepted_quantity ?? it.quantity}x ${it.measure} — ${this.formatCurrency(Number(it.unit_price))} cada`);
      const pagamento = v.payment_status === 'paid'
        ? 'Pago ✓'
        : 'Fiado' + (v.due_date ? ` — vence ${this.atacadoDateOnly(v.due_date)}` : '');
      const msg = [
        `🧾 Recibo — 2W Pneus (${isNaN(data.getTime()) ? '' : window.FarejadorTime.formatDate(data)})`,
        `Cliente: ${v.buyer_name}`,
        '',
        ...linhas,
        '',
        `Total: ${this.formatCurrency(Number(v.total_amount))}`,
        `Pagamento: ${pagamento}`,
        '',
        'Qualquer coisa é só chamar. Obrigado pela parceria! 🤝',
      ].join('\n');
      return 'https://wa.me/' + tel + '?text=' + encodeURIComponent(msg);
    },
  };
};
