// Obra 300 (2026-07-05): fatia do painel da MATRIZ — compras/fornecedores + fiado (0115) + loads financeiro/despesas.
// VERBATIM das linhas 1059-1232 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.compras = function () {
  return {
    compraAddItem() {
      this.compraForm.items.push({ measure: '', brand: '', quantity: 1, unit_cost: '' });
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    compraRemoveItem(i) {
      if (this.compraForm.items.length > 1) this.compraForm.items.splice(i, 1);
    },
    compraFormTotal() {
      return this.compraForm.items.reduce(
        (s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_cost) || 0), 0,
      );
    },
    fornecedorLastPurchase(s) {
      if (!s.last_purchase_at) return '—';
      const d = new Date(s.last_purchase_at);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
    },
    fornecedorStatus(s) {
      if (!Number(s.purchases_count)) return { label: 'sem compra', cls: 'bg-amber-50 text-amber-700' };
      if (s.days_since_last != null && Number(s.days_since_last) > this.atacadoStaleDays)
        return { label: `parado (${s.days_since_last}d)`, cls: 'bg-rose-50 text-rose-600' };
      return { label: 'ativo', cls: 'bg-emerald-50 text-emerald-700' };
    },
    // ── INSIGHTS de fornecedor (0114) — lê só das compras já registradas ──
    // #4 Dependência: % das compras (R$) que vem do MAIOR fornecedor. >60% acende alerta.
    fornecedorDependencia() {
      const tot = this.fornecedorRanking.reduce((s, f) => s + Number(f.total_spent || 0), 0);
      if (tot <= 0) return null;
      let topRow = null;
      for (const f of this.fornecedorRanking) {
        if (!topRow || Number(f.total_spent || 0) > Number(topRow.total_spent || 0)) topRow = f;
      }
      return { pct: Math.round((Number(topRow.total_spent || 0) / tot) * 100), name: topRow.name };
    },
    // #1 + #2: agrupa o breakdown por MEDIDA; dentro de cada uma já vem do mais barato
    // pro mais caro (o banco ordena), então o 1º fornecedor é o "mais barato".
    breakdownByMeasure() {
      const groups = [];
      const byKey = {};
      for (const row of this.fornecedorBreakdown) {
        let g = byKey[row.measure];
        if (!g) { g = { measure: row.measure, suppliers: [], qty: 0 }; byKey[row.measure] = g; groups.push(g); }
        g.suppliers.push({ ...row, cheapest: g.suppliers.length === 0 });
        g.qty += Number(row.qty_total || 0);
      }
      return groups.sort((a, b) => b.qty - a.qty); // a medida que mais compro primeiro
    },
    fornecedorBreakdownDate(row) {
      if (!row.last_purchased_at) return '—';
      const d = new Date(row.last_purchased_at);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
    },
    async compraSubmit() {
      const f = this.compraForm;
      const body = { items: [], notes: f.notes ? f.notes.trim() : null };
      if (f.supplierKey === 'new') {
        if (!f.newName.trim()) { this.compraMsg = { ok: false, text: 'Diga o nome do novo fornecedor.' }; return; }
        body.new_supplier = { name: f.newName.trim(), phone: f.newPhone.trim() || null };
      } else if (f.supplierKey) {
        body.supplier_id = f.supplierKey;
      } else {
        this.compraMsg = { ok: false, text: 'Escolha o fornecedor.' }; return;
      }
      const items = f.items
        .filter((it) => it.measure && it.measure.trim() && Number(it.quantity) > 0)
        .map((it) => ({
          measure: it.measure.trim(),
          brand: it.brand && it.brand.trim() ? it.brand.trim() : null,
          quantity: Number(it.quantity),
          unit_cost: Number(it.unit_cost) || 0,
        }));
      if (items.length === 0) { this.compraMsg = { ok: false, text: 'Adicione ao menos um pneu (medida e quantidade).' }; return; }
      body.items = items;
      // FINANCEIRO (0115): compra fiada só com o financeiro ligado (flag).
      if (this.atacadoFinance && f.payment_status === 'pending') {
        body.payment_status = 'pending';
        if (f.due_date) body.due_date = f.due_date;
      }

      this.compraSaving = true;
      this.compraMsg = null;
      try {
        const result = await this.apiPost('/admin/api/wholesale/purchases', body);
        const fiadoTxt = body.payment_status === 'pending' ? ' (A PRAZO — foi pro a pagar)' : '';
        this.compraMsg = { ok: true, text: `Compra registrada de ${result.supplier_name} — ${this.formatCurrency(Number(result.total_amount))}${fiadoTxt}. O galpão já recebeu.` };
        this.compraForm = { supplierKey: '', newName: '', newPhone: '', notes: '', payment_status: 'paid', due_date: '', items: [{ measure: '', brand: '', quantity: 1, unit_cost: '' }] };
        await this.loadAtacado();
      } catch (err) {
        this.compraMsg = { ok: false, text: this.compraErrText(err.message) };
      } finally {
        this.compraSaving = false;
      }
    },
    compraErrText(code) {
      const map = {
        supplier_required: 'Escolha ou cadastre o fornecedor.',
        supplier_not_found: 'Fornecedor não encontrado.',
        items_required: 'Adicione ao menos um pneu.',
        measure_not_in_catalog: 'Essa medida não está no catálogo — confira o número.',
      };
      return map[code] || `Não consegui registrar (${code}).`;
    },

    // ── ATACADO — CANCELAR VENDA (0116): registro errado sai sem apagar ──
    vendaData(v) {
      if (!v.sold_at) return '—';
      const d = new Date(v.sold_at);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
    },
    async atacadoCancelSale(v) {
      const pago = v.payment_status === 'paid';
      const aviso = pago
        ? '\n\n⚠️ Essa venda consta como PAGA — se o dinheiro já entrou, o acerto com o borracheiro é por fora.'
        : '\n\nEla sai do ranking, do resumo e do a receber; o estoque volta pro galpão.';
      if (!window.confirm(`Cancelar a venda de ${v.buyer_name} (${this.formatCurrency(Number(v.total_amount))})?${aviso}`)) return;
      const reason = window.prompt('Motivo (opcional):') || null;
      try {
        await this.apiPost('/admin/api/wholesale/sales/cancel', { order_id: v.id, reason });
        await this.loadAtacado();
      } catch (err) {
        const msg = err.message === 'sale_already_cancelled' ? 'Essa venda já estava cancelada.' : `Não consegui cancelar (${err.message}).`;
        window.alert(msg);
      }
    },

    // ── ATACADO — FINANCEIRO (0115): fiado a receber/a pagar + quitar ──
    financeDate(d) {
      if (!d) return 'sem data';
      const dt = new Date(d + (String(d).length === 10 ? 'T12:00:00' : ''));
      return isNaN(dt.getTime()) ? 'sem data' : dt.toLocaleDateString('pt-BR');
    },
    async financeSettle(kind, row) {
      const rotulo = kind === 'sale' ? `receber de ${row.counterparty}` : `pagar pra ${row.counterparty}`;
      if (!window.confirm(`Quitar ${this.formatCurrency(Number(row.total_amount))} (${rotulo})?`)) return;
      try {
        await this.apiPost('/admin/api/wholesale/finance/settle', { kind, id: row.id });
        await this.loadAtacado();
      } catch (err) {
        window.alert(`Não consegui quitar (${err.message}). Recarrega a página e tenta de novo.`);
      }
    },

    // ── MATRIZ — DESPESAS GERAIS (0120): lançar / quitar / remover ──
    // ── FINANCEIRO da matriz — tela própria: visão consolidada (Onda 1) + despesas (0120) ──
    async loadFinanceiro() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;
      const [visao] = await Promise.all([
        this.apiGet('/admin/api/matriz/financeiro').catch((err) => {
          console.warn('financeiro visão falhou:', err.message);
          return null;
        }),
        this.loadDespesas(),
      ]);
      // Rede piscou → mantém a visão anterior (dado de 15s atrás > tela apagada).
      this.financeiroVisao = visao ?? this.financeiroVisao;
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    async loadDespesas() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;
      try {
        const despesas = await this.apiGet('/admin/api/matriz/despesas');
        // flag off → enabled:false → null (o bloco some; a tela mostra o aviso de dormente)
        this.matrizDespesas = despesas && despesas.enabled ? despesas : null;
      } catch (err) {
        // Erro de REDE não apaga o bloco (mantém o dado anterior); só a flag off zera.
        console.warn('despesas load falhou:', err.message);
      } finally {
        this.despesasLoaded = true;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    // ── LOGÍSTICA da matriz (0121): entregas + rota do dia ──
  };
};
