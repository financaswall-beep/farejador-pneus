/**
 * app.financeiro.receber.js - fabrica `financeiroReceber` do painel do parceiro (obra <=300, passo 9/11).
 * MORA AQUI: CONTA A RECEBER - criar/editar (saveReceivable), form (reset/edit), busca
 * de cliente cadastrado com debounce (vincular na conta), receber (settleReceivable:
 * received + received_at -> entra no caixa do dia 0077; settleInstallment = parcela
 * LEGADA, parcelamento desligado) e cancelar (cancelReceivable DELETE soft).
 * NAO MORA AQUI: conta a pagar (app.financeiro.contas.js); cliente do PDV (app.pdv.clientes.js).
 * VEIO DE: app.js commit ea22ea3 (ranges 1605-1658, 1686-1750, 1807-1862), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.financeiroReceber = () => ({
    async saveReceivable() {
      if (!this.receivableForm.description.trim()) { this.flash('Descreva a conta a receber.'); return; }
      if (this.num(this.receivableForm.amount) <= 0) { this.flash('Informe o valor da conta a receber.'); return; }
      if (this.receivableForm.status === 'open' && !this.receivableForm.due_date) { this.flash('Informe o vencimento da conta em aberto.'); return; }
      this.saving = true;
      this.savingAction = 'receivable';
      try {
        const payload = {
          customer_id: this.receivableForm.customer_id || null,
          customer_name: this.receivableForm.customer_name.trim() || null,
          description: this.receivableForm.description.trim(),
          source_tag: this.receivableForm.source_tag || 'porta',
          amount: this.num(this.receivableForm.amount),
          due_date: this.receivableForm.status === 'open' ? this.receivableForm.due_date || null : null,
          notes: this.receivableForm.notes ?? null,
        };

        if (this.editingReceivableId) {
          await this.api(`contas-a-receber/${this.editingReceivableId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
          this.resetReceivableForm();
          await this.loadData();
          this.flash('Conta a receber atualizada.');
          return;
        }

        const wasReceived = this.receivableForm.status === 'received';
        const receivedAt = this.receivableForm.status === 'received'
          ? (this.receivableForm.received_at ? new Date(`${this.receivableForm.received_at}T12:00:00`).toISOString() : new Date().toISOString())
          : null;
        await this.api('contas-a-receber', {
          method: 'POST',
          body: JSON.stringify({
            ...payload,
            status: this.receivableForm.status || 'open',
            received_at: receivedAt,
            payment_method: this.receivableForm.status === 'received' ? this.receivableForm.payment_method || 'Pix' : null,
            idempotency_key: this.uuid(),
          }),
        });
        this.resetReceivableForm();
        await this.loadData();
        this.flash(wasReceived
          ? 'Recebimento registrado.'
          : 'Conta a receber cadastrada em aberto.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    resetReceivableForm() {
      this.editingReceivableId = null;
      this.receivableForm = { customer_id: null, customer_name: '', description: '', source_tag: 'porta', amount: 0, due_date: '', status: 'open', received_at: '', payment_method: 'Pix', notes: null };
      this.receivableCustomerQuery = '';
      this.receivableCustomerResults = [];
    },

    editReceivable(receivable) {
      if (!receivable || receivable.status !== 'open') {
        this.flash('Apenas contas em aberto podem ser editadas.');
        return;
      }
      this.editingReceivableId = receivable.id;
      this.receivableForm = {
        customer_id: receivable.customer_id || null,
        customer_name: receivable.customer_name || '',
        description: receivable.description || '',
        source_tag: receivable.source_tag || 'porta',
        amount: this.num(receivable.amount),
        due_date: receivable.due_date ? String(receivable.due_date).slice(0, 10) : '',
        status: 'open',
        received_at: '',
        payment_method: receivable.payment_method || 'Pix',
        notes: receivable.notes ?? null,
      };
      this.receivableCustomerQuery = receivable.customer_name || '';
      this.receivableCustomerResults = [];
      document.querySelector('.pos-form-card.receivable')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.flash('Editando conta a receber em aberto.');
    },

    // Busca de cliente cadastrado para vincular na conta a receber.
    searchReceivableCustomers() {
      this.receivableForm.customer_id = null;
      this.receivableForm.customer_name = this.receivableCustomerQuery;
      clearTimeout(this.receivableCustomerSearchTimer);
      const q = this.receivableCustomerQuery.trim();
      if (q.length < 2) {
        this.receivableCustomerResults = [];
        return;
      }
      this.receivableCustomerSearchTimer = setTimeout(async () => {
        try {
          const result = await this.api(`clientes/buscar?q=${encodeURIComponent(q)}`, { method: 'GET' });
          this.receivableCustomerResults = result.rows || [];
        } catch {
          this.receivableCustomerResults = [];
        }
      }, 250);
    },

    selectReceivableCustomer(customer) {
      if (!customer) return;
      this.receivableForm.customer_id = customer.id;
      this.receivableForm.customer_name = customer.name || '';
      this.receivableCustomerQuery = customer.name || '';
      this.receivableCustomerResults = [];
    },

    clearReceivableCustomerLink() {
      this.receivableForm.customer_id = null;
      this.receivableForm.customer_name = '';
      this.receivableCustomerQuery = '';
      this.receivableCustomerResults = [];
    },

    async settleInstallment(receivableId, installmentId) {
      if (!confirm('Marcar esta parcela como recebida?')) return;
      this.saving = true;
      this.savingAction = `installment-receive-${installmentId}`;
      try {
        await this.api(`contas-a-receber/${receivableId}/parcelas/${installmentId}/receber`, {
          method: 'POST',
          body: JSON.stringify({ received_at: new Date().toISOString(), payment_method: 'Pix' }),
        });
        await this.loadData();
        this.flash('Parcela recebida.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async settleReceivable(receivableId) {
      if (!confirm('Marcar esta conta como recebida agora?')) return;
      this.saving = true;
      this.savingAction = `receivable-receive-${receivableId}`;
      try {
        await this.api(`contas-a-receber/${receivableId}/receber`, {
          method: 'POST',
          body: JSON.stringify({
            received_at: new Date().toISOString(),
            payment_method: 'Pix',
          }),
        });
        await this.loadData();
        this.flash('Conta marcada como recebida.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async cancelReceivable(receivableId) {
      if (!confirm('Cancelar esta conta a receber?')) return;
      this.saving = true;
      this.savingAction = `receivable-cancel-${receivableId}`;
      try {
        await this.api(`contas-a-receber/${receivableId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Conta a receber cancelada.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },
});
