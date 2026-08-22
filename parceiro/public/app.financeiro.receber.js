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
          ? (this.receivableForm.received_at ? this.businessFactInstant(this.receivableForm.received_at) : new Date().toISOString())
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
      const receivable = this.receivables.find((item) => item.id === receivableId);
      const balance = this.num(receivable?.open_amount ?? receivable?.amount);
      const rawAmount = prompt(
        `Quanto foi recebido? Saldo atual: ${this.money(balance)}`,
        balance.toFixed(2).replace('.', ','),
      );
      if (rawAmount === null) return;
      const amount = Number(String(rawAmount).trim().replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0 || amount > balance + 0.001) {
        this.flash('Informe um valor válido, sem ultrapassar o saldo.');
        return;
      }
      this.saving = true;
      this.savingAction = `receivable-receive-${receivableId}`;
      try {
        await this.api(`contas-a-receber/${receivableId}/receber`, {
          method: 'POST',
          body: JSON.stringify({
            received_at: new Date().toISOString(),
            payment_method: 'Pix',
            amount,
            idempotency_key: this.uuid(),
          }),
        });
        await this.loadData();
        this.flash(amount + 0.001 < balance
          ? 'Recebimento parcial registrado. O restante continua em aberto.'
          : 'Conta recebida e caixa atualizado.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async renegotiateReceivable(receivableId) {
      const dueDate = prompt('Novo vencimento (AAAA-MM-DD):', window.FarejadorTime.businessDate());
      if (!dueDate) return;
      const reason = prompt('Motivo da renegociação:');
      if (!reason || reason.trim().length < 3) return;
      this.saving = true;
      this.savingAction = `receivable-renegotiate-${receivableId}`;
      try {
        await this.api(`contas-a-receber/${receivableId}/renegociar`, {
          method: 'PATCH', body: JSON.stringify({ due_date: dueDate, reason: reason.trim() }),
        });
        await this.loadData();
        this.flash('Novo vencimento registrado no histórico.');
      } catch (err) { this.flash(this.errMessage(err)); }
      finally { this.saving = false; this.savingAction = ''; }
    },

    async writeOffReceivable(receivableId) {
      const receivable = this.receivables.find((item) => item.id === receivableId);
      const balance = this.num(receivable?.open_amount ?? receivable?.amount);
      const rawAmount = prompt(
        `Valor que não será recebido (saldo: ${this.money(balance)}):`,
        balance.toFixed(2).replace('.', ','),
      );
      if (rawAmount === null) return;
      const amount = Number(String(rawAmount).trim().replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0 || amount > balance + 0.001) {
        this.flash('Informe um valor válido, sem ultrapassar o saldo.'); return;
      }
      const reason = prompt('Motivo da perda (ex.: cliente inadimplente):');
      if (!reason || reason.trim().length < 3) return;
      if (!confirm('Confirmar perda? Isso reduz o resultado por competência, sem mexer no caixa.')) return;
      this.saving = true;
      this.savingAction = `receivable-writeoff-${receivableId}`;
      try {
        await this.api(`contas-a-receber/${receivableId}/perda`, {
          method: 'POST', body: JSON.stringify({ amount, reason: reason.trim(),
            occurred_at: new Date().toISOString(), idempotency_key: this.uuid() }),
        });
        await this.loadData();
        this.flash('Perda registrada. A venda foi preservada para auditoria.');
      } catch (err) { this.flash(this.errMessage(err)); }
      finally { this.saving = false; this.savingAction = ''; }
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
