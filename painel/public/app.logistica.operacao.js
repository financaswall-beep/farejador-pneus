// Visão operacional: seleção de saída e atalhos para os fluxos auditáveis existentes.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.logisticaOperacao = function () {
  return {
    logOpBusca: '',
    logOpDiaFoco: '',
    logOpAtualizado: null,
    logOpErro: false,
    logOpAtualizando: false,
    logOpExpandida: false,
    logOpDialog: { kind: '', id: '' },
    logOpUploadTripId: null,
    logOpDisponiveis() {
      return this.entregasSemRota().filter((d) => d.status !== 'cancelled'
        && ['pending', 'dispatched'].includes(d.delivery_status));
    },
    logOpFila() {
      const query = this.logOpBusca.trim().toLocaleLowerCase('pt-BR');
      return this.logOpDisponiveis().filter((d) => this.logisticaDentroPeriodo(d))
        .filter((d) => !query || [this.logisticaOrderLabel(d), d.customer_name,
          d.delivery_address, this.logisticaItens(d)].join(' ').toLocaleLowerCase('pt-BR').includes(query));
    },
    logOpSelecionados() {
      return this.logOpDisponiveis().filter((d) => this.logisticaDentroPeriodo(d)
        && this.rotaForm.selecionadas[d.order_id]);
    },
    logOpTotal() {
      return this.logOpSelecionados().reduce((sum, d) => sum + Number(d.total_amount || 0), 0);
    },
    logOpSincronizar() {
      const eligible = new Set(this.logOpDisponiveis().map((d) => d.order_id));
      for (const id of Object.keys(this.rotaForm.selecionadas)) {
        if (!eligible.has(id)) delete this.rotaForm.selecionadas[id];
      }
      if (!this.logisticaCouriersDisponiveis().some((c) => c.id === this.rotaForm.courier_collaborator_id)) {
        this.rotaForm.courier_collaborator_id = '';
      }
    },
    logOpPeriodo(periodo) {
      this.logOpDiaFoco = "";
      this.rotaForm.selecionadas = {};
      this.setLogisticaPeriodo(periodo);
    },
    async logOpAtualizar() {
      if (this.logOpAtualizando || this.logisticaSaving) return;
      this.logOpAtualizando = true;
      try { await this.loadLogistica({ propagate: true }); }
      catch (_) { /* O carregador preserva a última leitura e sinaliza o erro. */ }
      finally { this.logOpAtualizando = false; }
    },
    logOpHorario(value) {
      if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
      return new Date(value).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    },
    logOpRotaLabel(trip) {
      const number = String(trip?.trip_number || '').replace(/^Rota\s*/i, '');
      return number ? `Rota ${number.startsWith('#') ? number : '#' + number}` : 'Rota';
    },
    logOpIniciais(name) {
      return String(name || 'Entregador').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    },
    logOpEscolherRota(id) {
      this.logOpExpandida = false;
      this.selecionarLogisticaRotaAberta(id);
    },
    logOpPedidosRota() {
      const rows = this.logisticaEntregasDaRota(this.logisticaRotaAtual());
      return this.logOpExpandida ? rows : rows.slice(0, 4);
    },
    logOpContagens() {
      const trip = this.logisticaRotaAtual();
      const progress = this.logisticaRotaProgresso(trip);
      const failed = this.logisticaEntregasDaRota(trip).filter((d) => d.delivery_status === 'failed').length;
      return [
        { key: 'delivered', label: progress.entregues === 1 ? 'entregue' : 'entregues', icon: 'check', count: progress.entregues },
        { key: 'dispatched', label: 'em andamento', icon: 'truck', count: this.logisticaRotaRestantes(trip) },
        { key: 'failed', label: failed === 1 ? 'ocorrência' : 'ocorrências', icon: 'triangle-alert', count: failed },
      ];
    },
    logOpOcorrencias() {
      return (this.logistica?.reportadas || []).filter((d) => d.status !== 'cancelled');
    },
    logOpUltimaRota() {
      return [...(this.logistica?.rotas_recentes || [])].filter((t) => t.status === 'closed')
        .sort((a, b) => new Date(b.ended_at || 0) - new Date(a.ended_at || 0))[0] || null;
    },
    logOpComprovantes() {
      return this.adminUser?.role === 'owner' && this.logistica?.receipt_approval ? this.receiptReviewQueue() : [];
    },
    async logOpAbrirRota() {
      if (this.logisticaSaving) return;
      const selected = this.logOpSelecionados();
      const courier = this.logisticaCouriersDisponiveis().find((c) => c.id === this.rotaForm.courier_collaborator_id);
      if (!selected.length || !courier) {
        this.logisticaMsg = { ok: false, text: 'Selecione pedidos disponíveis e um entregador livre.' }; return;
      }
      this.rotaForm.selecionadas = Object.fromEntries(selected.map((d) => [d.order_id, true]));
      await this.abrirRota();
      if (this.logisticaMsg?.ok) {
        const created = (this.logistica?.rotas_abertas || []).find((t) => t.courier_collaborator_id === courier.id);
        if (created) this.logOpEscolherRota(created.id);
      }
    },
    logOpAbrirDialog(kind, id) {
      this.logOpDialog = { kind, id };
      this.logisticaMsg = null;
      if (kind === 'fechar') this.fecharForm = { km_end: '', notes: '' };
      this.$nextTick(() => {
        this.$refs.logOpDialogEl.showModal();
        window.lucide && window.lucide.createIcons();
      });
    },
    logOpFecharDialog(dialog = this.$refs.logOpDialogEl) {
      if (this.logisticaSaving) return;
      dialog?.close();
      this.logOpDialog = { kind: '', id: '' };
    },
    logOpDialogPedido() {
      return this.logisticaTodasEntregas().find((d) => d.order_id === this.logOpDialog.id) || null;
    },
    logOpDialogRota() {
      return (this.logistica?.rotas_abertas || []).find((t) => t.id === this.logOpDialog.id) || null;
    },
    async logOpAdicionar(d) {
      if (this.logisticaSaving || !this.logOpDialogRota()
        || !this.logOpDisponiveis().some((row) => row.order_id === d.order_id)) return;
      // A atualização remove a linha clicada. Preserve o diálogo antes do await:
      // o $refs do escopo x-for deixa de existir quando a linha sai do DOM.
      const dialog = this.$refs.logOpDialogEl;
      this.selecionarLogisticaRotaAberta(this.logOpDialog.id);
      await this.pendurarNaRota(d);
      if (this.logisticaMsg?.ok) this.logOpFecharDialog(dialog);
    },
    async logOpFecharRota() {
      const trip = this.logOpDialogRota();
      if (this.logisticaSaving || !trip || this.logisticaRotaRestantes(trip)) return;
      const km = this.fecharForm.km_end;
      if (km !== '' && (!Number.isFinite(Number(km)) || Number(km) < Number(trip.km_start || 0))) {
        this.logisticaMsg = { ok: false, text: 'O KM final deve ser maior ou igual ao KM inicial.' }; return;
      }
      await this.fecharRota(trip);
      if (this.logisticaMsg?.ok) this.logOpFecharDialog();
    },
    async logOpRecolocar() {
      const d = this.logOpDialogPedido();
      if (this.logisticaSaving || !d || d.status === 'cancelled' || d.delivery_status !== 'failed') return;
      const dialog = this.$refs.logOpDialogEl;
      await this.logisticaRecolocar(d);
      if (this.logisticaMsg?.ok) this.logOpFecharDialog(dialog);
    },
    logOpConfirmarFalha() {
      const d = this.logOpDialogPedido();
      if (!d || this.logisticaSaving || d.status === 'cancelled' || d.delivery_status !== 'failed') return;
      this.logOpFecharDialog();
      this.logisticaConfirmarFalha(d);
    },
    logOpEscolherComprovante() {
      this.logOpUploadTripId = this.logisticaRotaAtual()?.id || null;
      if (this.logOpUploadTripId && !this.uploadingReceipt) this.$refs.logOpUpload.click();
    },
    async logOpEnviarComprovante(event) {
      const trip = (this.logistica?.rotas_abertas || []).find((t) => t.id === this.logOpUploadTripId);
      if (!trip) { event.target.value = ''; this.logisticaMsg = { ok: false, text: 'A rota foi encerrada. Atualize a tela antes de anexar.' }; return; }
      await this.enviarComprovante(trip, event);
    },
  };
};
