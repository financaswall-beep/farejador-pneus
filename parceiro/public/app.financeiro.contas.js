/**
 * app.financeiro.contas.js - fabrica `financeiroContas` do painel do parceiro (obra <=300, passo 9/11).
 * MORA AQUI: CONTA A PAGAR - criar/editar (savePayable PUT/POST), form (reset/edit),
 * quitar (settlePayable: marca paid + paid_at; gera despesa por dedupe no servidor) e
 * cancelar (cancelPayable DELETE soft). Conta de despesa ABERTA ja pesa no lucro por
 * competencia (0078); o caixa so muda quando paga.
 * NAO MORA AQUI: conta a receber (app.financeiro.receber.js); compra/despesa direta
 * (app.financeiro.compras.js).
 * VEIO DE: app.js commit ea22ea3 (ranges 1551-1603, 1660-1684, 1752-1805), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.financeiroContas = () => ({
    async savePayable() {
      if (!this.payableForm.description.trim()) { this.flash('Descreva a conta a pagar.'); return; }
      if (this.num(this.payableForm.amount) <= 0) { this.flash('Informe o valor da conta a pagar.'); return; }
      if (this.payableForm.status === 'open' && !this.payableForm.due_date) { this.flash('Informe o vencimento da conta em aberto.'); return; }
      this.saving = true;
      this.savingAction = 'payable';
      try {
        const payload = {
          counterparty_name: this.payableForm.counterparty_name.trim() || null,
          description: this.payableForm.description.trim(),
          category: this.payableForm.category || 'other',
          amount: this.num(this.payableForm.amount),
          due_date: this.payableForm.status === 'open' ? this.payableForm.due_date || null : null,
          notes: this.payableForm.notes ?? null,
        };

        if (this.editingPayableId) {
          await this.api(`contas-a-pagar/${this.editingPayableId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
          this.resetPayableForm();
          await this.loadData();
          this.flash('Conta a pagar atualizada.');
          return;
        }

        const wasPaid = this.payableForm.status === 'paid';
        const paidAt = this.payableForm.status === 'paid'
          ? (this.payableForm.paid_at ? new Date(`${this.payableForm.paid_at}T12:00:00`).toISOString() : new Date().toISOString())
          : null;
        await this.api('contas-a-pagar', {
          method: 'POST',
          body: JSON.stringify({
            ...payload,
            status: this.payableForm.status || 'open',
            paid_at: paidAt,
            payment_method: this.payableForm.status === 'paid' ? this.payableForm.payment_method || 'Pix' : null,
            idempotency_key: this.uuid(),
          }),
        });
        this.resetPayableForm();
        await this.loadData();
        this.flash(wasPaid
          ? 'Pagamento registrado no custo do mês.'
          : 'Conta a pagar cadastrada em aberto.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    resetPayableForm() {
      this.editingPayableId = null;
      this.payableForm = { counterparty_name: '', description: '', category: 'supplier', amount: 0, due_date: '', status: 'open', paid_at: '', payment_method: 'Pix', notes: null };
    },

    editPayable(payable) {
      if (!payable || payable.status !== 'open') {
        this.flash('Apenas contas em aberto podem ser editadas.');
        return;
      }
      this.editingPayableId = payable.id;
      this.payableForm = {
        counterparty_name: payable.counterparty_name || '',
        description: payable.description || '',
        category: payable.category || 'other',
        amount: this.num(payable.amount),
        due_date: payable.due_date ? String(payable.due_date).slice(0, 10) : '',
        status: 'open',
        paid_at: '',
        payment_method: payable.payment_method || 'Pix',
        notes: payable.notes ?? null,
      };
      document.querySelector('.pos-form-card.payable')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.flash('Editando conta a pagar em aberto.');
    },

    async settlePayable(payableId) {
      if (!confirm('Marcar esta conta como paga agora?')) return;
      this.saving = true;
      this.savingAction = `payable-pay-${payableId}`;
      const paidAt = new Date().toISOString();
      const attempt = async (force) => this.api(`contas-a-pagar/${payableId}/pagar`, {
        method: 'POST',
        body: JSON.stringify({ paid_at: paidAt, payment_method: 'Pix', force_duplicate: force }),
      });
      try {
        try {
          await attempt(false);
        } catch (err) {
          if (err.status === 409 && err.payload && err.payload.error === 'duplicate_expense') {
            const dups = (err.payload.duplicates || [])
              .map((d) => `- ${d.expense_date}: ${d.description} (R$ ${d.amount})`)
              .join('\n');
            const ok = confirm(
              `Ja existem despesas parecidas nos ultimos 7 dias:\n\n${dups}\n\nPagar mesmo assim? (vai criar uma despesa nova alem das ja existentes)`,
            );
            if (!ok) {
              this.flash('Pagamento cancelado. Confira despesas antes de marcar como paga.');
              return;
            }
            await attempt(true);
          } else {
            throw err;
          }
        }
        await this.loadData();
        this.flash('Conta marcada como paga.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async cancelPayable(payableId) {
      if (!confirm('Cancelar esta conta a pagar?')) return;
      this.saving = true;
      this.savingAction = `payable-cancel-${payableId}`;
      try {
        await this.api(`contas-a-pagar/${payableId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Conta a pagar cancelada.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },
});
