// Consulta paginada de entregas; ações de rota continuam na Operação.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.logisticaEntregas = function () {
  return {
    logEntFiltros: { from: '', to: '', q: '', courier: '', status: 'all', sort: 'scheduled_asc' },
    logEntDados: null,
    logEntResponsaveis: [],
    logEntPagina: 1,
    logEntSelecionadaId: null,
    logEntNovaData: '',
    logEntCarregando: false,
    logEntErro: '',
    logEntSequencia: 0,
    logEntAtualizado: null,
    logEntIniciar() {
      if (!this.logEntFiltros.from) {
        this.logEntFiltros.from = this.hojeISO();
        this.logEntFiltros.to = this.logisticaPeriodoFinalISO();
      }
      return this.logEntCarregar();
    },
    async logEntCarregar() {
      const seq = ++this.logEntSequencia;
      const f = this.logEntFiltros;
      if (!f.from || !f.to || f.from > f.to || (Date.parse(f.to) - Date.parse(f.from)) / 86400000 > 365) {
        this.logEntErro = 'Escolha um período válido de até 366 dias.';
        this.logEntCarregando = false;
        return;
      }
      this.logEntCarregando = true;
      this.logEntErro = '';
      try {
        const query = new URLSearchParams({ ...f, page: String(this.logEntPagina), page_size: '8' });
        const data = await this.apiGet('/admin/api/logistica/entregas?' + query);
        if (seq !== this.logEntSequencia) return;
        this.logEntDados = data;
        this.logEntResponsaveis = data.couriers;
        this.logEntPagina = data.page;
        const selected = data.rows.find(d => d.order_id === this.logEntSelecionadaId) || data.rows[0];
        this.logEntSelecionadaId = selected?.order_id || null;
        this.logEntNovaData = selected?.scheduled_date || '';
        this.logEntAtualizado = new Date().toISOString();
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      } catch (_) {
        if (seq === this.logEntSequencia) this.logEntErro = this.logEntDados
          ? 'Não foi possível atualizar. Os dados anteriores estão sendo exibidos.'
          : 'Não foi possível carregar as entregas. Tente novamente.';
      } finally {
        if (seq === this.logEntSequencia) this.logEntCarregando = false;
      }
    },
    logEntFiltrar() {
      this.logEntPagina = 1;
      this.logEntDados = null;
      this.logEntSelecionadaId = null;
      return this.logEntCarregar();
    },
    logEntLimpar() {
      this.logEntFiltros = { from: this.hojeISO(), to: this.logisticaPeriodoFinalISO(),
        q: '', courier: '', status: 'all', sort: 'scheduled_asc' };
      return this.logEntFiltrar();
    },
    logEntSituacao(status) {
      this.logEntFiltros.status = status;
      return this.logEntFiltrar();
    },
    logEntMudarPagina(delta) {
      if (this.logEntCarregando || !this.logEntDados) return;
      this.logEntPagina = Math.max(1, Math.min(this.logEntPaginas(), this.logEntPagina + delta));
      return this.logEntCarregar();
    },
    logEntPaginas() { return Math.max(1, Math.ceil((this.logEntDados?.total || 0) / 8)); },
    logEntSelecionada() {
      return (this.logEntDados?.rows || []).find(d => d.order_id === this.logEntSelecionadaId) || null;
    },
    logEntSelecionar(d) {
      this.logEntSelecionadaId = d.order_id;
      this.logEntNovaData = d.scheduled_date || '';
      this.$nextTick(() => {
        window.lucide && window.lucide.createIcons();
        if (window.innerWidth <= 1200) this.$refs.logEntDetalhe?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        this.$refs.logEntDetalhe?.focus({ preventScroll: true });
      });
    },
    logEntFechar() {
      const id = this.logEntSelecionadaId;
      this.logEntSelecionadaId = null;
      this.$nextTick(() => document.getElementById('log-ent-row-' + id)?.focus({ preventScroll: true }));
    },
    logEntStatus(d) { return d?.status === 'cancelled' ? 'failed' : d?.delivery_status || 'pending'; },
    logEntStatusLabel(d) {
      if (d?.status === 'cancelled') return 'Cancelada';
      return { pending: 'Aguardando', dispatched: 'Em entrega', delivered: 'Entregue', failed: 'Não entregue' }[d?.delivery_status] || 'Sem situação';
    },
    logEntData(d) {
      if (!d?.scheduled_date) return 'Sem agendamento';
      const date = new Date(d.scheduled_date + 'T12:00:00-03:00');
      const label = date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'America/Sao_Paulo' }).replace('.', '');
      return label + (d.scheduled_date === this.hojeISO() ? ' · Hoje' : d.scheduled_date === this.amanhaISO() ? ' · Amanhã' : '');
    },
    logEntPodeRemarcar(d) {
      return !!d && d.status !== 'cancelled' && ['pending', 'dispatched'].includes(d.delivery_status);
    },
    async logEntRemarcar() {
      const d = this.logEntSelecionada();
      if (!this.logEntPodeRemarcar(d) || this.logisticaSaving || this.logEntCarregando || this.logEntErro) return;
      const value = this.logEntNovaData;
      const date = new Date(value + 'T12:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return;
      await this.remarcarEntrega(d, value);
    },
    logEntVerOperacao(d) {
      if (!d || d.status === 'cancelled' || d.delivery_status === 'delivered') return;
      this.setLogisticaTab('visao');
      if (d.trip_id && (this.logistica?.rotas_abertas || []).some(t => t.id === d.trip_id)) {
        this.logOpEscolherRota(d.trip_id);
        this.$nextTick(() => document.getElementById('log-op-routes-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      } else if (d.delivery_status === 'failed') {
        this.logOpAbrirDialog('pedido', d.order_id);
      } else {
        this.logOpBusca = this.logisticaOrderLabel(d);
        this.logisticaPeriodo = d.scheduled_date === this.amanhaISO() ? 'amanha' : 'hoje';
        this.logOpDiaFoco = d.scheduled_date;
        this.$nextTick(() => document.getElementById('log-op-next')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      }
    },
  };
};
