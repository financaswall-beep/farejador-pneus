window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.compras = function () {
  return {
    compraAddItem() {
      if (this.adminUser?.role !== 'owner') return;
      this.compraForm.items.push({
        measure: '', brand: '', tire_condition: '', quantity: 1, unit_cost: '',
      });
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    compraRemoveItem(i) {
      if (this.adminUser?.role !== 'owner') return;
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
    fornecedorDependencia() {
      const tot = this.fornecedorRanking.reduce((s, f) => s + Number(f.total_spent || 0), 0);
      if (tot <= 0) return null;
      let topRow = null;
      for (const f of this.fornecedorRanking) {
        if (!topRow || Number(f.total_spent || 0) > Number(topRow.total_spent || 0)) topRow = f;
      }
      return { pct: Math.round((Number(topRow.total_spent || 0) / tot) * 100), name: topRow.name };
    },
    breakdownByMeasure() {
      const groups = [];
      const byKey = {};
      for (const row of this.fornecedorBreakdown) {
        const key = this.stockVariantKey(row);
        let g = byKey[key];
        if (!g) { g = { variant_key: key, measure: row.measure, brand: row.brand,
          tire_condition: row.tire_condition, suppliers: [], qty: 0 }; byKey[key] = g; groups.push(g); }
        g.suppliers.push({ ...row, cheapest: g.suppliers.length === 0 });
        g.qty += Number(row.qty_total || 0);
      }
      return groups.sort((a, b) => b.qty - a.qty);
    },
    fornecedorBreakdownDate(row) {
      if (!row.last_purchased_at) return '—';
      const d = new Date(row.last_purchased_at);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
    },
    compraBuildSubmission() {
      if (this.adminUser?.role !== 'owner') {
        this.compraMsg = { ok: false, text: 'Somente o proprietário pode registrar compras.' };
        return null;
      }
      const f = this.compraForm;
      const body = { items: [], notes: f.notes ? f.notes.trim() : null };
      const purchasedDate = f.purchased_at || this.finHoje();
      body.purchased_at = this.businessFactInstant(purchasedDate);
      if (f.supplierKey === 'new') {
        if (!f.newName.trim()) {
          this.compraMsg = { ok: false, text: 'Diga o nome do novo fornecedor.' };
          return null;
        }
        body.new_supplier = { name: f.newName.trim(), phone: f.newPhone.trim() || null,
          document: f.newDocument.trim() || null };
      } else if (f.supplierKey) {
        body.supplier_id = f.supplierKey;
      } else {
        this.compraMsg = { ok: false, text: 'Escolha o fornecedor.' };
        return null;
      }
      const items = f.items
        .filter((it) => it.measure && it.measure.trim() && Number(it.quantity) > 0)
        .map((it) => ({
          measure: it.measure.trim(),
          brand: it.brand && it.brand.trim() ? it.brand.trim() : null,
          tire_condition: it.tire_condition || null,
          quantity: Number(it.quantity),
          unit_cost: Number(it.unit_cost) || 0,
        }));
      if (items.length === 0) {
        this.compraMsg = { ok: false, text: 'Adicione ao menos um pneu (medida e quantidade).' };
        return null;
      }
      if (items.some((item) => !item.brand)) {
        this.compraMsg = { ok: false, text: 'Informe a marca de cada pneu.' };
        return null;
      }
      if (items.some((item) => !item.tire_condition)) {
        this.compraMsg = { ok: false, text: 'Selecione a condição de cada pneu.' };
        return null;
      }
      const descartadas = f.items.filter((it) => {
        const valida = it.measure && it.measure.trim() && Number(it.quantity) > 0;
        if (valida) return false;
        return (it.measure && it.measure.trim()) || (it.brand && it.brand.trim())
          || it.tire_condition
          || (it.unit_cost !== '' && it.unit_cost != null && Number(it.unit_cost) > 0)
          || Number(it.quantity) !== 1;
      });
      body.items = items;
      if (this.atacadoFinance && f.payment_status === 'pending') {
        if (!f.due_date) {
          this.compraMsg = { ok: false, text: 'Informe o vencimento da compra a prazo.' };
          return null;
        }
        body.payment_status = 'pending';
        body.due_date = f.due_date;
      } else {
        body.payment_status = 'paid';
        const paidDate = f.payment_date || purchasedDate;
        body.paid_at = this.businessFactInstant(paidDate);
      }
      body.receipt_status = f.receipt_status;
      f.idempotency_key = f.idempotency_key || window.PAINEL_INTEGRITY.operation('wholesale-purchase-create', 'form').key;
      body.idempotency_key = f.idempotency_key;
      return {
        body,
        warnings: {
          discarded: descartadas.length,
          zeroCost: items.some((it) => it.unit_cost === 0),
        },
      };
    },
    async compraSubmit() {
      const submission = this.compraBuildSubmission();
      if (!submission) return;
      if (submission.warnings.discarded || submission.warnings.zeroCost) {
        this.compraPendingSubmission = submission.body;
        this.compraDialog = {
          open: true, kind: 'review-create', purchase: null, supplier: null,
          reason: '', error: '', warnings: submission.warnings,
        };
        return;
      }
      await this.compraPersist(submission.body);
    },
    async compraPersist(body) {
      this.compraSaving = true;
      this.compraMsg = null;
      try {
        const result = await this.apiPost('/admin/api/wholesale/purchases', body);
        const fiadoTxt = body.payment_status === 'pending' ? ' (A PRAZO)' : '';
        const estoqueTxt = result.stock_applied ? ' O galpão já recebeu.' : ' Aguardando recebimento; o galpão não mudou.';
        const catalogoTxt = result.catalog_blockers?.length
          ? ` Atenção: ${result.catalog_blockers.length} variante(s) precisam de produto ou preço no Catálogo antes da venda.` : '';
        this.compraMsg = { ok: true, text: `Compra registrada de ${result.supplier_name} — ${this.formatCurrency(Number(result.total_amount))}${fiadoTxt}.${estoqueTxt}${catalogoTxt}` };
        window.PAINEL_INTEGRITY.complete('wholesale-purchase-create', 'form');
        this.compraForm = {
          supplierKey: '', newName: '', newPhone: '', newDocument: '', notes: '',
          purchased_at: '', payment_status: 'paid', payment_date: '', due_date: '',
          receipt_status: 'received', idempotency_key: '',
          items: [{ measure: '', brand: '', tire_condition: '', quantity: 1, unit_cost: '' }],
        };
        this.compraPendingSubmission = null;
        this.comprasTab = 'visao';
        await Promise.allSettled([this.loadCompras(), this.loadFinanceiro(), this.loadSino()]);
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
        tire_condition_required: 'Selecione a condição de cada pneu.',
        supplier_duplicate: 'Esse fornecedor já está cadastrado (nome, documento ou telefone equivalente). Escolha a ficha existente.',
        idempotency_conflict: 'Os dados mudaram durante o envio. Recarregue e confira antes de tentar novamente.',
        unit_cost_cent_precision: 'Informe o custo com no máximo duas casas decimais.',
        purchase_line_total_too_large: 'O total de um item ultrapassa o limite aceito.',
        purchase_total_too_large: 'O total da compra ultrapassa o limite aceito.',
        purchased_at_future: 'A data da compra não pode estar no futuro.',
        paid_at_future: 'A data do pagamento não pode estar no futuro.',
        due_date_before_purchase: 'O vencimento não pode ser anterior à data da compra.',
      };
      return map[code] || `Não consegui registrar (${code}).`;
    },
    async loadFinanceiro() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      this.financeiroLoadError = null;
      const [visao] = await Promise.all([
        this.apiGet('/admin/api/matriz/financeiro').catch((err) => {
          console.warn('financeiro visão falhou:', err.message);
          this.financeiroLoadError = err.message === 'api_503'
            ? 'O livro financeiro central está indisponível. O cálculo antigo não será usado.'
            : 'Não foi possível atualizar o Financeiro. Tente novamente.';
          return null;
        }),
        this.loadDespesas(),
      ]);
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
    pagarOrigem(i) {
      const nomes = {
        fornecedor: 'Fornecedor de pneus',
        folha: 'Folha salarial',
        estorno_comissao: 'Devolução de comissão',
        marketing: 'Marketing',
        devolucao_cliente: 'Devolução ao cliente',
      };
      return nomes[i.tipo] || this.despesaLabel(i.categoria || 'outros');
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
        const ck = this.pagarOrigem(i);
        cats.set(ck, (cats.get(ck) || 0) + v);
      }
      const grand = cards.aberto.total;
      const categorias = [...cats.entries()].map(([label, total]) => ({ label, total,
        pct: grand > 0 ? Math.round((total / grand) * 1000) / 10 : 0 })).sort((a, b) => b.total - a.total);
      return { cards, calendario: cal, categorias };
    },
  };
};
