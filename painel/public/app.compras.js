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
    comprasResumo() { const ativas = this.compras.filter((c) => c.status === 'confirmed'); return { registradas: this.fornecedorRanking.reduce((n, f) => n + Number(f.purchases_count || 0), 0), pneus: this.fornecedorBreakdown.reduce((n, r) => n + Number(r.qty_total || 0), 0), total: this.fornecedorRanking.reduce((n, f) => n + Number(f.total_spent || 0), 0), prazo: this.atacadoFinance ? Number(this.atacadoFinance.a_pagar_total || 0) : ativas.filter((c) => c.payment_status === 'pending').reduce((n, c) => n + Number(c.total_amount || 0), 0), prazoCount: this.atacadoFinance ? Number(this.atacadoFinance.a_pagar_count || 0) : ativas.filter((c) => c.payment_status === 'pending').length }; },
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
        // Auditoria 07-06: nome repetido cria OUTRA ficha e polui o ranking — perguntar antes.
        const nomeNovo = f.newName.trim().toLowerCase();
        if (this.fornecedores.some((s) => s.name.trim().toLowerCase() === nomeNovo)
            && !window.confirm(`Já existe um fornecedor chamado "${f.newName.trim()}".\n\nCriar OUTRO com o mesmo nome? Se é o mesmo, cancela e escolhe ele na lista.`)) return;
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
      // Auditoria 07-06: linha PREENCHIDA mas inválida (sem medida / sem quantidade) era
      // descartada em silêncio — a tela mostrava um total e registrava outro. Linha 100%
      // vazia (sobrou do "+ Adicionar pneu") segue ignorada sem pergunta.
      const descartadas = f.items.filter((it) => {
        const valida = it.measure && it.measure.trim() && Number(it.quantity) > 0;
        if (valida) return false;
        return (it.measure && it.measure.trim()) || (it.brand && it.brand.trim())
          || (it.unit_cost !== '' && it.unit_cost != null && Number(it.unit_cost) > 0)
          || Number(it.quantity) !== 1;
      });
      if (descartadas.length > 0
          && !window.confirm(`${descartadas.length} linha(s) sem medida (ou sem quantidade) vão ficar DE FORA da compra.\n\nRegistrar mesmo assim?`)) return;
      // Auditoria 07-06: custo em branco virava R$ 0 calado e DERRUBAVA o custo médio.
      if (items.some((it) => it.unit_cost === 0)
          && !window.confirm('Tem pneu com custo R$ 0 — entra de graça e DERRUBA o custo médio do galpão.\n\nÉ isso mesmo?')) return;
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
        quantidade_inteira: 'Quantidade tem que ser número inteiro (sem vírgula).',
      };
      return map[code] || `Não consegui registrar (${code}).`;
    },

    // ── COMPRAS — ÚLTIMAS COMPRAS + CANCELAR (0127): registro errado sai sem apagar ──
    compraData(c) {
      if (!c.purchased_at) return '—';
      const d = new Date(c.purchased_at);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
    },
    async compraCancel(c) {
      const pago = c.payment_status === 'paid';
      const aviso = pago
        ? '\n\n⚠️ Essa compra consta como PAGA — se o dinheiro já saiu, o acerto com o fornecedor é por fora.'
        : '\n\nOs pneus saem do galpão e o custo médio recalcula; se estava a prazo, sai do a pagar.';
      if (!window.confirm(`Cancelar a compra de ${c.supplier_name} (${this.formatCurrency(Number(c.total_amount))})?${aviso}`)) return;
      const reason = window.prompt('Motivo (opcional):') || null;
      try {
        await this.apiPost('/admin/api/wholesale/purchases/cancel', { purchase_id: c.id, reason });
        await this.loadAtacado();
      } catch (err) {
        const msg = err.message === 'purchase_already_cancelled' ? 'Essa compra já estava cancelada.' : `Não consegui cancelar (${err.message}).`;
        window.alert(msg);
      }
    },
    // ── FORNECEDOR — ARQUIVAR (soft): some da lista/ranking; compras e dívidas ficam ──
    async fornecedorArchive(s) {
      if (!window.confirm(`Arquivar o fornecedor ${s.name}?\n\nEle some da lista e do ranking. As compras antigas continuam no histórico e dívida pendente continua no Financeiro.`)) return;
      try {
        await this.apiPost('/admin/api/wholesale/suppliers/archive', { supplier_id: s.supplier_id });
        await this.loadAtacado();
      } catch (err) {
        window.alert(`Não consegui arquivar (${err.message}).`);
      }
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
        if (this.currentPage === 'vendas') await this.loadAtacadoVendas();
        else await this.loadAtacado();
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
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
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
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      try {
        // 0130: a lista é o EXTRATO do período — 1º load cai no mês corrente (fuso SP).
        if (!this.despesaFiltro.mes) this.despesaFiltro.mes = this.despesaMesAtual();
        const qs = new URLSearchParams();
        if (this.despesaFiltro.mes) qs.set('mes', this.despesaFiltro.mes);
        if (this.despesaFiltro.categoria) qs.set('categoria', this.despesaFiltro.categoria);
        const despesas = await this.apiGet('/admin/api/matriz/despesas' + (qs.toString() ? '?' + qs.toString() : ''));
        // flag off → enabled:false → null (o bloco some; a tela mostra o aviso de dormente)
        this.matrizDespesas = despesas && despesas.enabled ? despesas : null;
        if (despesas && despesas.enabled && Array.isArray(despesas.categorias) && despesas.categorias.length) {
          this.despesaCategorias = despesas.categorias; // lista viva (0130): fábrica + as do dono
        }
      } catch (err) {
        // Erro de REDE não apaga o bloco (mantém o dado anterior); só a flag off zera.
        console.warn('despesas load falhou:', err.message);
      } finally {
        this.despesasLoaded = true;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    // ── Sub-aba CONTAS A PAGAR (07-13): DERIVADO de a_pagar.itens (fornecedor +
    // despesa a pagar). Zero API/contrato novo — só classifica/agrupa pra EXIBIR. ──
    pagarDias(due) {
      if (!due) return null; // sem vencimento → fora do calendário e dos baldes de data
      const hoje = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      return Math.round((new Date(String(due).slice(0, 10) + 'T00:00:00Z') - new Date(hoje + 'T00:00:00Z')) / 86400000);
    },
    pagarClasse(i) { // fonte única pro filtro da fila E pra cor do status
      if (i.overdue) return 'vencida';            // overdue é do servidor — manda
      const d = this.pagarDias(i.due_date);
      if (d === null) return 'semdata';
      if (d < 0) return 'vencida';
      if (d === 0) return 'hoje';
      return d <= 7 ? 'sete' : 'depois';
    },
    pagarStatus(i) {
      const c = this.pagarClasse(i);
      if (c === 'vencida') return { label: i.due_date ? 'Venceu ' + this.financeDate(i.due_date) : 'Vencida', cls: 'bg-rose-50 text-rose-600 font-semibold' };
      if (c === 'hoje') return { label: 'Vence hoje', cls: 'bg-amber-50 text-amber-700 font-medium' };
      if (c === 'semdata') return { label: 'Sem vencimento', cls: 'bg-gray-100 text-gray-500' };
      return { label: 'Vence ' + this.financeDate(i.due_date), cls: 'bg-emerald-50 text-emerald-700' };
    },
    pagarFila() { // '' = tudo; já vem vencido-primeiro do servidor
      const itens = (this.financeiroVisao && this.financeiroVisao.a_pagar.itens) || [];
      return this.pagarFiltro ? itens.filter((i) => this.pagarClasse(i) === this.pagarFiltro) : itens;
    },
    pagarPainel() { // cards do topo + calendário + quebra por categoria, num passo só
      const itens = (this.financeiroVisao && this.financeiroVisao.a_pagar.itens) || [];
      const base = new Date(new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date()) + 'T00:00:00Z').getTime();
      const cards = { vencidas: { total: 0, count: 0 }, hoje: { total: 0, count: 0 }, sete: { total: 0, count: 0 }, aberto: { total: 0, count: 0 } };
      const cal = [{ key: 'vencida', label: 'Vencidas', sub: '', tom: 'atraso', total: 0, count: 0 }];
      for (let o = 0; o <= 6; o++) {
        const dt = new Date(base + o * 86400000);
        const wd = o === 0 ? 'Hoje' : o === 1 ? 'Amanhã'
          : new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'short' }).format(dt).replace('.', '');
        cal.push({ key: 'd' + o, label: wd.charAt(0).toUpperCase() + wd.slice(1), tom: o === 0 ? 'hoje' : 'futuro', total: 0, count: 0,
          sub: new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }).format(dt) });
      }
      cal.push({ key: 'depois', label: 'Depois', sub: '+7 dias', tom: 'futuro', total: 0, count: 0 });
      const cats = new Map();
      for (const i of itens) {
        const v = Number(i.valor || 0);
        cards.aberto.total += v; cards.aberto.count++;
        const c = this.pagarClasse(i);
        if (c === 'vencida') { cards.vencidas.total += v; cards.vencidas.count++; cal[0].total += v; cal[0].count++; }
        else if (c === 'hoje') { cards.hoje.total += v; cards.hoje.count++; cal[1].total += v; cal[1].count++; }
        else if (c === 'sete') { cards.sete.total += v; cards.sete.count++; const d = this.pagarDias(i.due_date); const k = d <= 6 ? d + 1 : cal.length - 1; cal[k].total += v; cal[k].count++; }
        else if (c === 'depois') { cal[cal.length - 1].total += v; cal[cal.length - 1].count++; }
        const ck = i.tipo === 'fornecedor' ? 'Fornecedor de pneus' : this.despesaLabel(i.categoria || 'outros');
        cats.set(ck, (cats.get(ck) || 0) + v);
      }
      const grand = cards.aberto.total;
      const categorias = [...cats.entries()].map(([label, total]) => ({ label, total,
        pct: grand > 0 ? Math.round((total / grand) * 1000) / 10 : 0 })).sort((a, b) => b.total - a.total);
      return { cards, calendario: cal, categorias };
    },
    // ── LOGÍSTICA da matriz (0121): entregas + rota do dia ──
  };
};
