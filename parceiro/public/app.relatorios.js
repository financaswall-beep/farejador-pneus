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
    const now = new Date();
    const dia = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    let from = null, to = null;
    if (this.relRange === 'hoje') { from = dia(now); to = new Date(from.getTime() + 864e5); }
    else if (this.relRange === 'semana') { const dow = (now.getDay() + 6) % 7; from = dia(new Date(now.getTime() - dow * 864e5)); to = new Date(from.getTime() + 7 * 864e5); }
    else if (this.relRange === 'mes') { from = new Date(now.getFullYear(), now.getMonth(), 1); to = new Date(now.getFullYear(), now.getMonth() + 1, 1); }
    else if (this.relRange === 'mes_passado') { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 1); }
    else if (this.relRange === 'custom') {
      from = this.relFrom ? new Date(this.relFrom + 'T00:00:00') : null;
      to = this.relTo ? new Date(new Date(this.relTo + 'T00:00:00').getTime() + 864e5) : null;
    }
    return { from: from ? from.toISOString() : '', to: to ? to.toISOString() : '' };
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

  setRelRange(r) { this.relRange = r; if (r !== 'custom') this.loadRelatorio(); },

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
