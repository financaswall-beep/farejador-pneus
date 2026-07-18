// Obra 300 (2026-07-05): fatia do painel da MATRIZ — venda de atacado: form, status, submit, ranking de recompra.
// VERBATIM das linhas 915-1058 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
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
      } finally {
        this.atacadoLoading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    async loadAtacado() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      this.atacadoLoading = true;
      try {
        const [buyers, ranking, measures, stock, resumo, suppliers, supRanking, purchases, breakdown, finance, vendas] = await Promise.all([
          this.apiGet('/admin/api/wholesale/buyers'),
          this.apiGet('/admin/api/wholesale/ranking'),
          this.apiGet('/admin/api/wholesale/measures'),
          this.apiGet('/admin/api/wholesale/stock'),
          this.apiGet('/admin/api/wholesale/resumo?period=' + this.atacadoPeriodo),
          this.apiGet('/admin/api/wholesale/suppliers'),
          this.apiGet('/admin/api/wholesale/suppliers/ranking'),
          this.apiGet('/admin/api/wholesale/purchases'),
          this.apiGet('/admin/api/wholesale/suppliers/breakdown'),
          this.apiGet('/admin/api/wholesale/finance'),
          this.apiGet('/admin/api/wholesale/sales'),
        ]);
        this.atacadoBuyers = buyers.rows || [];
        this.atacadoRanking = ranking.rows || [];
        this.atacadoMeasures = measures.rows || [];
        this.atacadoStock = stock.rows || [];
        this.atacadoResumo = resumo || null;
        this.fornecedores = suppliers.rows || [];
        this.fornecedorRanking = supRanking.rows || [];
        this.compras = purchases.rows || [];
        this.fornecedorBreakdown = breakdown.rows || [];
        // flag off → enabled:false → null (a UI do financeiro some inteira)
        this.atacadoFinance = finance && finance.enabled ? finance : null;
        this.atacadoVendas = vendas.rows || [];
      } catch (err) {
        this.atacadoBuyers = [];
        this.atacadoRanking = [];
        this.atacadoMeasures = [];
        this.atacadoStock = [];
        this.atacadoResumo = null;
        this.fornecedores = [];
        this.fornecedorRanking = [];
        this.compras = [];
        this.fornecedorBreakdown = [];
        this.atacadoFinance = null;
        this.atacadoVendas = [];
        console.warn('atacado load falhou:', err.message);
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
