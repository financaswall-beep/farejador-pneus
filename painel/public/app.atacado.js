// Obra 300 (2026-07-05): fatia do painel da MATRIZ — venda de atacado: form, status, submit, ranking de recompra.
// VERBATIM das linhas 915-1058 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_STOCK_PREVIEW = {
  enabled() {
    return /(?:^|[?&])mock=1(?:&|$)/.test(window.location?.search || '');
  },
  rows: [
    { measure: '215/75 R17.5', quantity_on_hand: 42, min_quantity: 18, unit_cost: 748.90, notes: 'Linha pesada · giro alto' },
    { measure: '90/90-18', quantity_on_hand: 27, min_quantity: 10, unit_cost: 184.60, notes: 'Linha 2W · reposição semanal' },
    { measure: '175/70 R14', quantity_on_hand: 18, min_quantity: 15, unit_cost: 312.40, notes: 'Giro estável no balcão' },
    { measure: '185/65 R15', quantity_on_hand: 8, min_quantity: 12, unit_cost: 346.80, notes: 'Repor no próximo pedido' },
    { measure: '205/55 R16', quantity_on_hand: 4, min_quantity: 8, unit_cost: 438.50, notes: 'Saldo abaixo do mínimo' },
    { measure: '195/60 R15', quantity_on_hand: 0, min_quantity: 6, unit_cost: 368.90, notes: 'Sem saldo · prioridade de compra' },
  ],
  movements: [
    { created_at: '2026-07-24T12:42:00-03:00', source: 'venda_atacado', measure: '195/60 R15', qty_delta: -3, qty_before: 3, qty_after: 0, cost_before: 368.90, cost_after: 368.90, reason: 'Borracharia Central', ref: 'ATC-2842' },
    { created_at: '2026-07-24T11:18:00-03:00', source: 'compra', measure: '215/75 R17.5', qty_delta: 18, qty_before: 24, qty_after: 42, cost_before: 732.40, cost_after: 748.90, reason: 'Fornecedor Estrada', ref: 'CMP-731' },
    { created_at: '2026-07-24T10:05:00-03:00', source: 'varejo', measure: '185/65 R15', qty_delta: -4, qty_before: 12, qty_after: 8, cost_before: 346.80, cost_after: 346.80, reason: 'Pedido #2841', ref: '2841' },
    { created_at: '2026-07-24T09:14:00-03:00', source: 'baixa_manual', measure: '205/55 R16', qty_delta: -1, qty_before: 5, qty_after: 4, cost_before: 438.50, cost_after: 438.50, reason: 'quebra: lateral danificada', ref: 'BXM-81' },
    { created_at: '2026-07-23T17:36:00-03:00', source: 'venda_atacado', measure: '205/55 R16', qty_delta: -5, qty_before: 10, qty_after: 5, cost_before: 438.50, cost_after: 438.50, reason: 'Pneus Sul', ref: 'ATC-2839' },
    { created_at: '2026-07-23T15:20:00-03:00', source: 'entrada', measure: '90/90-18', qty_delta: 12, qty_before: 15, qty_after: 27, cost_before: 181.20, cost_after: 184.60, reason: 'Wallace', ref: 'ENT-184' },
    { created_at: '2026-07-23T09:14:00-03:00', source: 'varejo', measure: '175/70 R14', qty_delta: -2, qty_before: 20, qty_after: 18, cost_before: 312.40, cost_after: 312.40, reason: 'Pedido #2830', ref: '2830' },
  ].concat(Array.from({ length: 22 }, (_, index) => ({
    created_at: `2026-07-22T${String(21 - index).padStart(2, '0')}:10:00-03:00`, source: index % 3 === 0 ? 'entrada' : 'varejo',
    measure: ['215/75 R17.5', '90/90-18', '175/70 R14', '185/65 R15'][index % 4], qty_delta: index % 3 === 0 ? 2 : -1,
    qty_before: 20 + index, qty_after: 20 + index + (index % 3 === 0 ? 2 : -1), cost_before: 320, cost_after: 320,
    reason: 'Histórico demonstrativo', ref: `MOV-${String(index + 1).padStart(3, '0')}`,
  }))),
  reconciliation: {
    summary: { total: 6, aligned: 5, divergent: 1, catalog_only: 0 },
    rows: [
      { key: '21575175', official_measures: ['215/75 R17.5'], catalog_measures: ['215/75 R17.5'], catalog_brands: ['2W Cargo', 'Roadmax'], official_quantity: 42, legacy_quantity: 42, official_unit_cost: 748.90, status: 'aligned' },
      { key: '909018', official_measures: ['90/90-18'], catalog_measures: ['90/90-18'], catalog_brands: ['2W Moto'], official_quantity: 27, legacy_quantity: 27, official_unit_cost: 184.60, status: 'aligned' },
      { key: '1757014', official_measures: ['175/70 R14'], catalog_measures: ['175/70 R14'], catalog_brands: ['2W Touring'], official_quantity: 18, legacy_quantity: 18, official_unit_cost: 312.40, status: 'aligned' },
      { key: '1856515', official_measures: ['185/65 R15'], catalog_measures: ['185/65 R15'], catalog_brands: ['2W Touring'], official_quantity: 8, legacy_quantity: 8, official_unit_cost: 346.80, status: 'aligned' },
      { key: '2055516', official_measures: ['205/55 R16'], catalog_measures: ['205/55 R16'], catalog_brands: ['2W Sport'], official_quantity: 4, legacy_quantity: 5, official_unit_cost: 438.50, status: 'quantity_divergent' },
      { key: '1956015', official_measures: ['195/60 R15'], catalog_measures: ['195/60 R15'], catalog_brands: ['2W Touring'], official_quantity: 0, legacy_quantity: 0, official_unit_cost: 368.90, status: 'aligned' },
    ],
  },
};
window.PAINEL_MODULES.atacado = function () {
  return {
    atacadoBuyerKey(b) {
      return b.customer_id ? `c:${b.customer_id}` : `p:${b.partner_id}`;
    },
    // Carregador enxuto da tela Vendas. Compras e fornecedores ficam fora para uma
    // falha neles não derrubar o caixa do atacado nem atrasar a visão comercial.
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
      ];
      try {
        const settled = await Promise.allSettled(jobs.map(([, request]) => request));
        settled.forEach((result, index) => {
          const key = jobs[index][0];
          if (result.status === 'rejected') {
            console.warn(`vendas atacado ${key} falhou:`, result.reason?.message || result.reason);
            return;
          }
          const value = result.value;
          if (key === 'buyers') this.atacadoBuyers = value.rows || [];
          if (key === 'ranking') this.atacadoRanking = value.rows || [];
          if (key === 'measures') this.atacadoMeasures = value.rows || [];
          if (key === 'stock') this.atacadoStock = value.rows || [];
          if (key === 'resumo') this.atacadoResumo = value || null;
          if (key === 'finance') this.atacadoFinance = value && value.enabled ? value : null;
          if (key === 'vendas') this.atacadoVendas = value.rows || [];
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
      this.atacadoForm.items.push({ measure: '', brand: '', quantity: 1, unit_price: '' });
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    atacadoRemoveItem(i) {
      if (this.atacadoForm.items.length > 1) this.atacadoForm.items.splice(i, 1);
    },
    atacadoFormTotal() {
      return this.atacadoForm.items.reduce(
        (s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0,
      );
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
      const quantidade = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      return `${quantidade} pneu(s) · ${items.map((item) => item.measure).filter(Boolean).join(', ') || 'sem medida'}`;
    },
    atacadoMedidasMaisVendidas() {
      const totais = new Map();
      this.atacadoVendasPeriodo().filter((v) => v.status === 'confirmed').forEach((v) => (v.items || []).forEach((item) => {
        totais.set(item.measure, (totais.get(item.measure) || 0) + Number(item.quantity || 0));
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
      const d = new Date(b.last_purchase_at);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
    },
    atacadoStatus(b) {
      if (!Number(b?.orders_count)) return { label: 'nunca comprou', cls: 'bg-amber-50 text-amber-700', dot: 'bg-amber-400' };
      if (b?.days_since_last != null && Number(b.days_since_last) > this.atacadoStaleDays)
        return { label: `sumiu (${b.days_since_last}d)`, cls: 'bg-rose-50 text-rose-600', dot: 'bg-rose-400' };
      return { label: 'ativo', cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' };
    },
    // RECIBO no WhatsApp (2026-07-06): "manda o papel" do borracheiro sem custo —
    // deep-link wa.me com o texto pronto (padrão da casa, fora da API Meta).
    // Sem telefone no cadastro → null e o botão some (a UI esconde).
    reciboWhatsLink(v) {
      if (!v) return null;
      const digits = String(v.buyer_phone || '').replace(/\D/g, '');
      if (!digits || v.status !== 'confirmed') return null;
      const tel = digits.startsWith('55') ? digits : '55' + digits;
      const data = new Date(v.sold_at);
      const linhas = (v.items || []).map((it) =>
        `• ${it.quantity}x ${it.measure} — ${this.formatCurrency(Number(it.unit_price))} cada`);
      const pagamento = v.payment_status === 'paid'
        ? 'Pago ✓'
        : 'Fiado' + (v.due_date ? ` — vence ${new Date(v.due_date + 'T12:00:00').toLocaleDateString('pt-BR')}` : '');
      const msg = [
        `🧾 Recibo — 2W Pneus (${isNaN(data.getTime()) ? '' : data.toLocaleDateString('pt-BR')})`,
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
    async atacadoSubmit() {
      const f = this.atacadoForm;
      const body = { items: [], notes: f.notes ? f.notes.trim() : null };
      if (f.buyerKey === 'new') {
        if (!f.newName.trim()) { this.atacadoMsg = { ok: false, text: 'Diga o nome do novo cliente.' }; return; }
        body.new_customer = { name: f.newName.trim(), phone: f.newPhone.trim() || null };
      } else if (f.buyerKey.startsWith('c:')) {
        body.customer_id = f.buyerKey.slice(2);
      } else if (f.buyerKey.startsWith('p:')) {
        body.partner_id = f.buyerKey.slice(2);
      } else {
        this.atacadoMsg = { ok: false, text: 'Escolha o borracheiro.' }; return;
      }
      const items = f.items
        .filter((it) => it.measure && it.measure.trim() && Number(it.quantity) > 0)
        .map((it) => ({
          measure: it.measure.trim(),
          brand: it.brand && it.brand.trim() ? it.brand.trim() : null,
          quantity: Number(it.quantity),
          unit_price: Number(it.unit_price) || 0,
        }));
      if (items.length === 0) { this.atacadoMsg = { ok: false, text: 'Adicione ao menos um pneu (medida e quantidade).' }; return; }
      body.items = items;
      // FINANCEIRO (0115): fiado só quando o financeiro está ligado (flag). Vencimento opcional.
      if (this.atacadoFinance && f.payment_status === 'pending') {
        body.payment_status = 'pending';
        if (f.due_date) body.due_date = f.due_date;
      }
      f.idempotency_key = f.idempotency_key || window.PAINEL_INTEGRITY.operation('wholesale-sale-create', 'form').key;
      body.idempotency_key = f.idempotency_key;

      this.atacadoSaving = true;
      this.atacadoMsg = null;
      try {
        const result = await this.apiPost('/admin/api/wholesale/sales', body);
        const fiadoTxt = body.payment_status === 'pending' ? ' (FIADO — foi pro a receber)' : '';
        this.atacadoMsg = { ok: true, text: `Venda registrada pra ${result.buyer_name} — ${this.formatCurrency(Number(result.total_amount))}${fiadoTxt}.` };
        window.PAINEL_INTEGRITY.complete('wholesale-sale-create', 'form');
        this.atacadoForm = { buyerKey: '', newName: '', newPhone: '', notes: '', payment_status: 'paid', due_date: '', idempotency_key: '', items: [{ measure: '', brand: '', quantity: 1, unit_price: '' }] };
        await this.loadAtacadoVendas();
      } catch (err) {
        this.atacadoMsg = { ok: false, text: this.atacadoErrText(err.message) };
      } finally {
        this.atacadoSaving = false;
      }
    },
    atacadoErrText(code) {
      const map = {
        buyer_required: 'Escolha ou cadastre o comprador.',
        items_required: 'Adicione ao menos um pneu.',
        partner_not_found: 'Parceiro não encontrado.',
        buyer_not_found: 'Cliente não encontrado.',
        oversell: 'Estoque insuficiente. A venda não foi registrada; confira o galpão.',
        idempotency_conflict: 'Os dados mudaram durante o envio. Recarregue e confira antes de tentar novamente.',
      };
      return map[code] || `Não consegui registrar (${code}).`;
    },

    // ── ATACADO — FORNECEDORES (0114): compra/entrada com origem ──
  };
};
