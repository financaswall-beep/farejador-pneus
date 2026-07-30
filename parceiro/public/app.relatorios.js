/**
 * app.relatorios.js - fabrica `relatorios` do painel (0108). Aba SÓ DO DONO: o
 * backstop "puxar relatório". Mostra o histórico de VENDAS por período + status,
 * INCLUSIVE o que foi arquivado (com botão desarquivar = trazer de volta pra tela).
 * KPIs no topo (nº, total, ticket médio). Só na tela (sem export, v1). `this` =
 * objeto unico de app.js. REGRA: teto 300 (npm run checar-tamanho).
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.relatorios = () => ({
  // Período escolhido → { from, to } ISO (início inclusivo, fim EXCLUSIVO).
  relPeriodo() {
    const today = this.dateKeySaoPaulo(new Date());
    const addDays = (dateKey, days) => {
      const [year, month, day] = dateKey.split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
    };
    const monthStart = (dateKey, offset = 0) => {
      const [year, month] = dateKey.split('-').map(Number);
      return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10);
    };
    const saoPauloMidnight = (dateKey) => dateKey ? `${dateKey}T00:00:00-03:00` : '';
    let from = null, to = null;
    if (this.relRange === 'hoje') { from = today; to = addDays(today, 1); }
    else if (this.relRange === 'semana') {
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
      from = addDays(today, -dow);
      to = addDays(from, 7);
    }
    else if (this.relRange === 'mes') { from = monthStart(today); to = monthStart(today, 1); }
    else if (this.relRange === 'mes_passado') { from = monthStart(today, -1); to = monthStart(today); }
    else if (this.relRange === 'custom') {
      from = this.relFrom || null;
      to = this.relTo ? addDays(this.relTo, 1) : null;
    }
    return { from: saoPauloMidnight(from), to: saoPauloMidnight(to) };
  },

  async loadRelatorio() {
    if (!this.isOwner) return;
    this.relLoading = true;
    try {
      const { from, to } = this.relPeriodo();
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (this.relStatus !== 'todos') qs.set('status', this.relStatus);
      const data = await this.api(`relatorios/vendas?${qs.toString()}`);
      this.relRows = data.rows || [];
      this.$nextTick(() => lucide.createIcons());
    } catch (err) {
      this.flash(this.errMessage(err));
    } finally {
      this.relLoading = false;
    }
  },

  setRelRange(r) { this.relRange = r; if (r !== 'custom') this.loadRelAtual(); },

  // Sub-abas (Vendas | Pneu mais vendido | Caixa) compartilham o filtro de período.
  // Trocar de aba OU de período recarrega a view ATIVA (loadRelAtual dispatcha).
  setRelView(v) { this.relView = v; this.loadRelAtual(); },
  loadRelAtual() {
    if (this.relView === 'pneus') return this.loadRelatorioPneus();
    if (this.relView === 'caixa') return this.loadRelatorioCaixa();
    return this.loadRelatorio();
  },

  async loadRelatorioPneus() {
    if (!this.isOwner) return;
    this.relPneusLoading = true;
    try {
      const { from, to } = this.relPeriodo();
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const data = await this.api(`relatorios/pneus?${qs.toString()}`);
      this.relPneusRows = data.rows || [];
      this.$nextTick(() => lucide.createIcons());
    } catch (err) {
      this.flash(this.errMessage(err));
    } finally {
      this.relPneusLoading = false;
    }
  },

  async loadRelatorioCaixa() {
    if (!this.isOwner) return;
    this.relCaixaLoading = true;
    try {
      const { from, to } = this.relPeriodo();
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      this.relCaixa = await this.api(`relatorios/caixa?${qs.toString()}`);
      this.$nextTick(() => lucide.createIcons());
    } catch (err) {
      this.flash(this.errMessage(err));
    } finally {
      this.relCaixaLoading = false;
    }
  },

  get relPneusUnidades() { return this.relPneusRows.reduce((s, r) => s + this.num(r.qtd), 0); },
  get relPneusFaturamento() { return this.relPneusRows.reduce((s, r) => s + this.num(r.faturamento), 0); },

  get relTotal() { return this.relRows.reduce((s, r) => s + this.num(r.total_amount), 0); },
  get relCount() { return this.relRows.length; },
  get relTicket() { return this.relCount ? this.relTotal / this.relCount : 0; },
  get relArquivadosCount() { return this.relRows.filter((r) => r.arquivado).length; },

  relRangeLabel(r) {
    return { hoje: 'Hoje', semana: 'Esta semana', mes: 'Este mês', mes_passado: 'Mês passado', custom: 'Personalizado' }[r] || r;
  },
  relLinhaStatus(r) {
    if (r.status === 'cancelled') return 'Cancelado';
    if (r.fulfillment_mode === 'delivery') return this.deliveryStatusLabel(r.delivery_status);
    if (r.fulfillment_mode === 'pickup') return r.awaiting_pickup ? 'Aguardando retirada' : 'Retirado';
    return 'Concluído';
  },

  async desarquivarVenda(r) {
    if (!r || !r.order_id) return;
    try {
      await this.api(`itens/order/${encodeURIComponent(r.order_id)}/desarquivar`, { method: 'POST' });
      await this.loadRelatorio();
      this.flash('Pedido trazido de volta pra tela.', 'success');
    } catch (err) {
      this.flash(this.errMessage(err));
    }
  },
});
