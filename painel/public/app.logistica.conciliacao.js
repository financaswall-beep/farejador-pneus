window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.logisticaConciliacao = function () {
  return {
    logCon: { trip: null, amount: '', reason: '', confirmed: false, editing: false, lost: false,
      saving: false, error: '', attempt: null },
    abrirConciliacaoRota(trip) {
      if (!trip?.id || trip.status !== 'closed' || this.logHistCarregando || this.logHistErro) return;
      if (this.logCon.attempt && this.logCon.trip?.id !== trip.id) {
        this.logisticaMsg = { ok: false, text: 'Confira a correção pendente da outra rota antes de continuar.' };
        return;
      }
      if (!this.logCon.attempt) this.logCon = { trip, amount: String(trip.fuel_spent ?? 0),
        reason: '', confirmed: false, editing: false, lost: false, saving: false, error: '', attempt: null };
      this.$refs.logConDialog.showModal();
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    fecharConciliacaoRota() {
      if (!this.logCon.saving && !this.uploadingReceipt && !this.logisticaSaving) this.$refs.logConDialog.close();
    },
    logConPodeCorrigir() {
      const c = this.logCon, value = Number(String(c.amount).trim().replace(',', '.'));
      return this.adminUser?.role === 'owner' && !!c.trip && !c.lost && !c.saving
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
    logConSemComprovanteBloqueio() {
      if (this.adminUser?.role !== 'owner') return 'Somente o proprietário pode aprovar uma despesa sem comprovante.';
      if (!this.logistica) return 'Atualize os dados da Logística antes de continuar.';
      if (!this.logistica.receipt_approval || !this.logistica.receipt_approval_finance) {
        return 'A aprovação de despesas está desativada no servidor.';
      }
      return '';
    },
    logConAbrirSemComprovante(trip) {
      if (this.logConSemComprovanteBloqueio() || this.logCon.saving || this.logCon.attempt
        || this.uploadingReceipt || this.logisticaSaving) return;
      if (trip) {
        if (!trip.id || trip.status !== 'closed' || this.logHistCarregando || this.logHistErro) return;
        this.abrirConciliacaoRota(trip);
      }
      if (!this.logCon.trip) return;
      Object.assign(this.logCon, { lost: true, editing: false, reason: '', confirmed: false,
        expense_date: '', payment_status: '', payment_date: '', due_date: '', retroactive_confirmed: false, error: '' });
    },
    logConPodeSemComprovante() {
      const c = this.logCon, value = Number(String(c.amount).trim().replace(',', '.'));
      return this.adminUser?.role === 'owner' && !!c.trip && c.lost && !c.saving
        && this.logistica?.receipt_approval && this.logistica?.receipt_approval_finance
        && (c.attempt || (c.confirmed && c.reason.trim().length >= 3 && c.reason.trim().length <= 500
          && value > 0 && value <= Number(this.logistica?.receipt_approval_max_amount || 10000)
          && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001 && !!c.expense_date
          && ((c.payment_status === 'paid' && !!c.payment_date) || (c.payment_status === 'pending' && !!c.due_date))));
    },
    async logConSalvarSemComprovante() {
      if (!this.logConPodeSemComprovante()) return;
      const c = this.logCon;
      c.attempt ||= { trip_id: c.trip.id, amount: Number(String(c.amount).trim().replace(',', '.')),
        expected_amount: c.trip.fuel_spent == null ? null : Number(c.trip.fuel_spent), expense_date: c.expense_date,
        payment_status: c.payment_status, payment_date: c.payment_status === 'paid' ? c.payment_date : null,
        due_date: c.payment_status === 'pending' ? c.due_date : null,
        reason: c.reason.trim(), confirmed: true, retroactive_confirmed: !!c.retroactive_confirmed,
        idempotency_key: 'trip-lost-receipt-' + window.crypto.randomUUID() };
      c.saving = true; c.error = '';
      try {
        const result = await this.apiPost('/admin/api/logistica/rotas/comprovante-perdido', c.attempt);
        c.attempt = null;
        this.logisticaMsg = { ok: true, text: result.financial_status === 'reconciled'
          ? 'Despesa sem comprovante aprovada e rota conciliada. A autorização ficou registrada.'
          : 'Despesa sem comprovante aprovada. Confira as outras pendências ou a diferença de valor da rota.' };
        this.$refs.logConDialog.close(); await this.loadLogistica(); void this.loadSino?.();
      } catch (error) {
        const messages = {
          trip_fuel_already_approved: 'A rota já tem combustível registrado. Confira as despesas antes de continuar.',
          trip_receipt_review_required: 'Há comprovantes aguardando revisão. Revise ou rejeite o arquivo antes de aprovar sem nota.',
          trip_fuel_annotation_changed: 'A anotação mudou. Atualize a rota e confira o valor novamente.',
          trip_not_found: 'A rota não está disponível. Feche e atualize a lista.',
          receipt_amount_above_limit: 'O valor ultrapassa o limite de aprovação de despesas.',
          receipt_amount_invalid: 'Informe um valor válido, com até duas casas decimais.',
          receipt_document_date_future: 'Informe a data real da despesa, sem data futura.',
          receipt_payment_date_future: 'A data do pagamento não pode ser futura.',
          receipt_payment_date_required: 'Informe a data do pagamento.',
          receipt_due_date_required: 'Informe o vencimento da despesa.',
          receipt_retroactive_confirmation_required: 'A despesa tem mais de 3 meses. Confira e confirme o lançamento retroativo.',
          invalid_body: 'Confira os campos da aprovação.',
          receipt_approval_expenses_disabled: 'A aprovação de despesas precisa estar habilitada.',
        };
        if (messages[error.message]) { c.error = messages[error.message]; c.attempt = null; c.confirmed = false; }
        else c.error = 'A resposta não foi confirmada. Use Verificar aprovação para conferir a mesma tentativa.';
      } finally { c.saving = false; }
    },
  };
};
