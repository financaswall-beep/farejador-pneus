window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.logisticaConciliacao = function () {
  return {
    logCon: { trip: null, amount: '', reason: '', confirmed: false, editing: false,
      saving: false, error: '', attempt: null },
    abrirConciliacaoRota(trip) {
      if (!trip?.id || trip.status !== 'closed' || this.logHistCarregando || this.logHistErro) return;
      if (this.logCon.attempt && this.logCon.trip?.id !== trip.id) {
        this.logisticaMsg = { ok: false, text: 'Confira a correção pendente da outra rota antes de continuar.' };
        return;
      }
      if (!this.logCon.attempt) this.logCon = { trip, amount: String(trip.fuel_spent ?? 0),
        reason: '', confirmed: false, editing: false, saving: false, error: '', attempt: null };
      this.$refs.logConDialog.showModal();
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    fecharConciliacaoRota() {
      if (!this.logCon.saving && !this.uploadingReceipt && !this.logisticaSaving) this.$refs.logConDialog.close();
    },
    logConPodeCorrigir() {
      const c = this.logCon, value = Number(String(c.amount).trim().replace(',', '.'));
      return this.adminUser?.role === 'owner' && !!c.trip && !c.saving
        && (c.attempt || (c.confirmed && c.reason.trim().length >= 3 && Number.isFinite(value)
          && String(c.amount).trim() !== '' && value >= 0 && value <= 99999
          && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001));
    },
    async logConSalvar() {
      if (!this.logConPodeCorrigir()) return;
      const c = this.logCon;
      c.attempt ||= { trip_id: c.trip.id, amount: Number(String(c.amount).trim().replace(',', '.')),
        expected_amount: c.trip.fuel_spent == null ? null : Number(c.trip.fuel_spent),
        reason: c.reason.trim(), idempotency_key: 'trip-fuel-' + window.crypto.randomUUID() };
      c.saving = true; c.error = '';
      try {
        const result = await this.apiPost('/admin/api/logistica/rotas/corrigir-combustivel', c.attempt);
        c.attempt = null;
        this.logisticaMsg = { ok: true, text: result.financial_status === 'reconciled'
          ? 'Anotação corrigida e rota conciliada. Nenhuma despesa foi criada ou estornada.'
          : 'Anotação corrigida. A rota ainda tem pendências para conferir.' };
        this.$refs.logConDialog.close();
        await this.loadLogistica();
        void this.loadSino?.();
      } catch (error) {
        if (['trip_fuel_annotation_changed', 'trip_not_found', 'invalid_body'].includes(error.message)) {
          c.error = error.message === 'trip_fuel_annotation_changed'
            ? 'A anotação mudou enquanto você conferia. Feche, atualize a rota e confira o valor novamente.'
            : 'Não foi possível corrigir. Feche e atualize a rota antes de tentar novamente.';
          c.attempt = null; c.confirmed = false;
        } else c.error = 'Não foi possível confirmar a correção. Use Verificar correção para conferir a mesma tentativa.';
      } finally { c.saving = false; }
    },
    logConVerDespesas() {
      this.fecharConciliacaoRota();
      this.logHistVerDespesas();
    },
    logConRevisarComprovantes() {
      this.fecharConciliacaoRota();
      this.logHistRevisar();
    },
    async logConAnexar(event) {
      if (!event.target.files?.length || !this.logCon.trip || this.uploadingReceipt) return;
      await this.enviarComprovante(this.logCon.trip, event);
      if (this.logisticaMsg?.ok) {
        this.fecharConciliacaoRota();
        this.logHistRevisar();
      } else this.logCon.error = this.logisticaMsg?.text || 'Não foi possível enviar o comprovante.';
    },
    async logConConfirmarDivergencia() {
      if (this.adminUser?.role !== 'owner' || this.logisticaSaving) return;
      await this.confirmarDivergenciaRota(this.logCon.trip);
      if (this.logisticaMsg?.ok) this.fecharConciliacaoRota();
    },
  };
};
