// Histórico de rotas: consulta independente, resultados da mesma memória de cálculo da operação.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.logisticaHistorico = function () {
  return {
    logHistFiltros: { from: '', to: '', q: '', courier: '', financial: 'all' },
    logHistDados: null, logHistResponsaveis: [], logHistPagina: 1,
    logHistCarregando: false, logHistErro: '', logHistSequencia: 0, logHistAtualizado: null,
    logHistDetalhe: false, logHistRevisaoId: null,
    logHistEntregasId: null, logHistEntregas: [], logHistEntregasErro: '', logHistEntregasCarregando: false,
    logHistIniciar() {
      if (!this.logHistFiltros.from) {
        this.logHistFiltros.from = this.logisticaPeriodoInicioISO(30);
        this.logHistFiltros.to = this.hojeISO();
      }
      return this.logHistCarregar();
    },
    async logHistCarregar(preferredId = this.logisticaRotaSelecionadaId) {
      const seq = ++this.logHistSequencia;
      const f = this.logHistFiltros;
      if (!f.from || !f.to || f.from > f.to || (Date.parse(f.to) - Date.parse(f.from)) / 86400000 > 365) {
        this.logHistErro = 'Escolha um período válido de até 366 dias.';
        this.logHistCarregando = false; return;
      }
      this.logHistCarregando = true; this.logHistErro = '';
      try {
        const data = await this.apiGet('/admin/api/logistica/historico?' + new URLSearchParams({ ...f, page: String(this.logHistPagina) }));
        if (seq !== this.logHistSequencia) return;
        this.logHistDados = data; this.logHistResponsaveis = data.couriers; this.logHistPagina = data.page;
        const chosen = data.rows.find(t => t.id === preferredId) || data.rows[0];
        this.logisticaRotaSelecionadaId = chosen?.id || null;
        if (chosen?.id !== preferredId) { this.logHistDetalhe = false; this.logHistRevisaoId = null; }
        this.logHistAtualizado = data.as_of || new Date().toISOString();
        void this.loadReceiptThumbs();
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      } catch (_) {
        if (seq === this.logHistSequencia) this.logHistErro = this.logHistDados
          ? 'Não foi possível atualizar. Os dados anteriores estão sendo exibidos.'
          : 'Não foi possível carregar o histórico. Tente novamente.';
      } finally { if (seq === this.logHistSequencia) this.logHistCarregando = false; }
    },
    logHistFiltrar() {
      this.logHistPagina = 1; this.logHistDados = null; this.logisticaRotaSelecionadaId = null;
      this.logHistDetalhe = false; this.logHistRevisaoId = null;
      return this.logHistCarregar();
    },
    logHistLimpar() {
      this.logHistFiltros = { from: this.logisticaPeriodoInicioISO(30), to: this.hojeISO(), q: '', courier: '', financial: 'all' };
      return this.logHistFiltrar();
    },
    logHistPaginas() { return Math.max(1, Math.ceil((this.logHistDados?.summary?.closed || 0) / 6)); },
    logHistMudarPagina(delta) {
      if (this.logHistCarregando || !this.logHistDados) return;
      this.logHistPagina = Math.max(1, Math.min(this.logHistPaginas(), this.logHistPagina + delta));
      this.logHistDetalhe = false; this.logHistRevisaoId = null;
      return this.logHistCarregar();
    },
    logHistSelecionar(t) {
      if (!t?.id) return;
      this.logisticaRotaSelecionadaId = t.id; this.logHistDetalhe = false; this.logHistRevisaoId = null;
      this.$nextTick(() => {
        window.lucide && window.lucide.createIcons();
        if (window.innerWidth <= 1200) this.$refs.logHistPainel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        this.$refs.logHistPainel?.focus({ preventScroll: true });
      });
    },
    logHistFechar() {
      const id = this.logisticaRotaSelecionadaId;
      this.logisticaRotaSelecionadaId = null; this.logHistDetalhe = false; this.logHistRevisaoId = null;
      this.$nextTick(() => document.getElementById('log-hist-row-' + id)?.focus());
    },
    logHistAbrirRota(t) {
      if (!t?.id || t.status !== 'closed') return;
      this.logisticaTab = 'historico'; this.logHistPagina = 1;
      const date = this.logisticaDateISO(t.ended_at || t.started_at);
      this.logHistFiltros = { from: date, to: date, q: t.trip_number || '', courier: '', financial: 'all' };
      this.logHistDetalhe = false; this.logHistRevisaoId = null;
      return this.logHistCarregar(t.id);
    },
    logHistMargemNaoApurada() {
      const r = this.rotaResultado(this.logisticaRotaSelecionada());
      return r?.semCusto ? Math.max(0, Math.round((r.faturamento - r.custoPneus - r.despesas - r.resultado) * 100) / 100) : 0;
    },
    logHistStatus(t) { return t?.financial_status || 'pending'; },
    logHistStatusLabel(t) { return { reconciled: 'Conciliada', pending: 'Pendente', divergent: 'Divergência' }[this.logHistStatus(t)]; },
    logHistData(t) {
      const value = t?.ended_at || t?.started_at;
      return value ? new Date(value).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Sem data';
    },
    logHistVerDespesas() {
      this.logHistDetalhe = true;
      this.$nextTick(() => {
        window.lucide && window.lucide.createIcons();
        this.$refs.logisticaDespesas?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    logHistRevisar() {
      const t = this.logisticaRotaSelecionada();
      if (!t || this.logHistCarregando || this.logHistErro) return;
      if (this.adminUser?.role !== 'owner' || !this.logistica?.receipt_approval
        || !(t.receipts || []).some(r => this.receiptNeedsReview(r))) { this.logHistVerDespesas(); return; }
      this.logHistRevisaoId = t.id;
      this.$nextTick(() => {
        this.$refs.receiptReviewDetails.open = true;
        this.$refs.receiptReviewDetails.scrollIntoView({ behavior: 'smooth', block: 'start' });
        window.lucide && window.lucide.createIcons();
      });
    },
    async logHistVerEntregas() {
      const trip = this.logisticaRotaSelecionada();
      if (!trip || this.logHistCarregando || this.logHistErro) return;
      this.logHistEntregasId = trip.id; this.logHistEntregas = []; this.logHistEntregasErro = ''; this.logHistEntregasCarregando = true;
      this.$refs.logHistEntregasDialog.showModal();
      try {
        const data = await this.apiGet('/admin/api/logistica/historico/' + encodeURIComponent(trip.id) + '/entregas');
        if (this.logHistEntregasId === trip.id) this.logHistEntregas = data.rows;
      } catch (_) { if (this.logHistEntregasId === trip.id) this.logHistEntregasErro = 'Não foi possível consultar as entregas da rota.'; }
      finally { if (this.logHistEntregasId === trip.id) this.logHistEntregasCarregando = false; }
    },
    logHistEntregaLabel(d) {
      return d.historical ? 'Tentativa não entregue' : ({ pending: 'Aguardando', dispatched: 'Em entrega', delivered: 'Entregue', failed: 'Não entregue', cancelled: 'Cancelada' }[d.status] || 'Sem situação');
    },
  };
};
