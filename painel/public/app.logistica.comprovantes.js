// Etapa 7: comprovante e IA ficam no lado da sugestão; dinheiro só após decisão humana.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.logisticaComprovantes = function () {
  return {
    receiptReviewDrafts: {},
    receiptReviewBusy: {},
    receiptReviewMessages: {},

    receiptActionKey(receiptId, action) {
      return window.PAINEL_INTEGRITY
        .operation(`receipt-${action}`, receiptId).key;
    },
    receiptCompleteAction(receiptId, action) {
      window.PAINEL_INTEGRITY.complete(`receipt-${action}`, receiptId);
    },
    receiptToday() {
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
    },
    receiptReviewDraft(receipt) {
      if (!receipt?.id) return {};
      if (this.receiptReviewDrafts[receipt.id]) return this.receiptReviewDrafts[receipt.id];
      const suggestion = receipt.latest_attempt || {};
      const date = suggestion.document_date || this.receiptToday();
      this.receiptReviewDrafts[receipt.id] = {
        amount: suggestion.amount == null ? '' : Number(suggestion.amount).toFixed(2),
        suggested_amount: suggestion.amount == null ? null : Number(suggestion.amount),
        category: suggestion.category || 'combustivel',
        merchant: suggestion.merchant || '',
        document_date: date,
        competence_month: `${String(date).slice(0, 7)}-01`,
        payment_status: 'paid', payment_date: this.receiptToday(), due_date: '', note: '',
        confirmed: false, reject_reason: '', reject_confirmed: false,
        competence_confirmed: false, retroactive_confirmed: false,
        possible_duplicate_confirmed: false, possible_duplicate_required: false,
        legacy_expense_confirmed: false, legacy_expense_required: false,
      };
      return this.receiptReviewDrafts[receipt.id];
    },
    receiptCategoryOptions() {
      const rows = this.logistica?.expense_categories || [];
      return rows.length ? rows : this.despesaCategorias || [];
    },
    receiptNeedsReview(receipt) {
      return receipt?.workflow_status === 'review_required';
    },
    receiptReviewQueue() {
      const trips = [...(this.logistica?.rotas_abertas || []),
        ...(this.logistica?.rotas_recentes || [])];
      return trips.flatMap((trip) => (trip.receipts || [])
        .filter((receipt) => this.receiptNeedsReview(receipt))
        .map((receipt) => ({ trip, receipt })));
    },
    receiptReviewEnabled() {
      return !!(this.logistica?.receipt_approval && this.logistica?.receipt_approval_finance);
    },
    receiptAmountAttention(receipt) {
      const draft = this.receiptReviewDraft(receipt);
      const suggested = Number(draft.suggested_amount || 0);
      const approved = Number(draft.amount || 0);
      return suggested > 0 && approved > 0 && Math.abs(approved - suggested) / suggested > 0.2;
    },
    receiptApprovalDisabled(receipt) {
      const draft = this.receiptReviewDraft(receipt);
      const amount = Number(draft.amount);
      const max = Number(this.logistica?.receipt_approval_max_amount || 10000);
      const paymentDateOk = draft.payment_status === 'paid'
        ? !!draft.payment_date : !!draft.due_date;
      return !this.receiptReviewEnabled() || !!this.receiptReviewBusy[receipt.id]
        || !draft.confirmed || !Number.isFinite(amount) || amount <= 0 || amount > max
        || !draft.category || !draft.document_date || !draft.competence_month || !paymentDateOk
        || (draft.possible_duplicate_required && !draft.possible_duplicate_confirmed)
        || (draft.legacy_expense_required && !draft.legacy_expense_confirmed);
    },
    receiptRejectDisabled(receipt) {
      const draft = this.receiptReviewDraft(receipt);
      return !this.logistica?.receipt_approval || !!this.receiptReviewBusy[receipt.id]
        || !draft.reject_confirmed || String(draft.reject_reason || '').trim().length < 2;
    },
    receiptUploadErrorMessage(payload) {
      if (payload?.error === 'receipt_exact_duplicate' && payload.duplicate_trip_number) {
        return `Este comprovante já está na ${payload.duplicate_trip_number}.`;
      }
      if (payload?.error === 'receipt_exact_duplicate') {
        return 'Este arquivo já foi usado em outro comprovante.';
      }
      return `Não consegui subir o comprovante (${payload?.error || 'erro desconhecido'}).`;
    },
    receiptWorkflowLabel(receipt) {
      const labels = {
        uploaded: 'Aguardando leitura', processing: 'IA lendo',
        review_required: 'Aguardando sua revisão', linked: 'Aprovado e vinculado',
        rejected: 'Rejeitado', legacy_linked: 'Legado — sem aprovação humana registrada',
      };
      return labels[receipt?.workflow_status] || 'Aguardando revisão';
    },
    async approveReceipt(receipt) {
      if (this.receiptApprovalDisabled(receipt)) return;
      const draft = this.receiptReviewDraft(receipt);
      this.receiptReviewBusy[receipt.id] = true;
      this.receiptReviewMessages[receipt.id] = null;
      try {
        const result = await this.apiPost('/admin/api/logistica/comprovantes/aprovar', {
          receipt_id: receipt.id, ai_attempt_id: receipt.latest_attempt?.id || null,
          amount: Number(draft.amount), suggested_amount: draft.suggested_amount,
          category: draft.category, merchant: draft.merchant.trim() || null,
          document_date: draft.document_date, competence_month: draft.competence_month,
          payment_status: draft.payment_status,
          payment_date: draft.payment_status === 'paid' ? draft.payment_date : null,
          due_date: draft.payment_status === 'pending' ? draft.due_date : null,
          note: draft.note.trim() || null,
          competence_confirmed: !!draft.competence_confirmed,
          retroactive_confirmed: !!draft.retroactive_confirmed,
          possible_duplicate_confirmed: !!draft.possible_duplicate_confirmed,
          legacy_expense_confirmed: !!draft.legacy_expense_confirmed,
          idempotency_key: this.receiptActionKey(receipt.id, 'approve'),
        });
        this.receiptCompleteAction(receipt.id, 'approve');
        delete this.receiptReviewDrafts[receipt.id];
        this.logisticaMsg = { ok: true, text: result.linked_existing
          ? 'Comprovante aprovado e ligado à despesa legada, sem duplicar dinheiro.'
          : 'Comprovante aprovado. A despesa entrou uma vez no Financeiro.' };
        await this.loadLogistica();
      } catch (error) {
        if (error.message === 'receipt_possible_duplicate_confirmation_required') {
          draft.possible_duplicate_required = true;
          this.receiptReviewMessages[receipt.id] = 'Possível duplicidade: confira e marque a confirmação extra.';
        } else if (error.message === 'receipt_legacy_expense_confirmation_required') {
          draft.legacy_expense_required = true;
          this.receiptReviewMessages[receipt.id] = 'A rota já tem despesa legada igual. Confirme o vínculo sem criar outra.';
        } else if (error.message === 'receipt_legacy_expense_conflict') {
          this.receiptReviewMessages[receipt.id] = 'A despesa legada diverge destes dados; nada foi alterado.';
        } else if (error.message === 'receipt_retroactive_confirmation_required') {
          this.receiptReviewMessages[receipt.id] = 'Este documento é retroativo há mais de 3 meses. Marque a confirmação extra.';
        } else if (error.message === 'receipt_competence_confirmation_required') {
          this.receiptReviewMessages[receipt.id] = 'A competência difere da data do documento. Marque a confirmação extra.';
        } else {
          this.receiptReviewMessages[receipt.id] = `A aprovação não foi gravada (${error.message}).`;
        }
      } finally {
        this.receiptReviewBusy[receipt.id] = false;
      }
    },
    async rejectReceipt(receipt) {
      if (this.receiptRejectDisabled(receipt)) return;
      const draft = this.receiptReviewDraft(receipt);
      this.receiptReviewBusy[receipt.id] = true;
      try {
        await this.apiPost('/admin/api/logistica/comprovantes/rejeitar', {
          receipt_id: receipt.id, ai_attempt_id: receipt.latest_attempt?.id || null,
          reason: draft.reject_reason.trim(),
          idempotency_key: this.receiptActionKey(receipt.id, 'reject'),
        });
        this.receiptCompleteAction(receipt.id, 'reject');
        delete this.receiptReviewDrafts[receipt.id];
        this.logisticaMsg = { ok: true, text: 'Comprovante rejeitado. Nenhum dinheiro foi lançado.' };
        await this.loadLogistica();
      } catch (error) {
        this.receiptReviewMessages[receipt.id] = `A rejeição não foi gravada (${error.message}).`;
      } finally {
        this.receiptReviewBusy[receipt.id] = false;
      }
    },
  };
};
