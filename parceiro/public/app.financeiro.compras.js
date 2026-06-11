/**
 * app.financeiro.compras.js - fabrica `financeiroCompras` do painel do parceiro (obra <=300, passo 9/11).
 * MORA AQUI: COMPRA de pneu (savePurchase POST /compras: paid_now ou a prazo -> gera
 * conta a pagar; deletePurchase com tratamento de 409; saveMaterialPayable com dedupe
 * 409 duplicate_expense -> confirma e re-tenta com force) e DESPESA direta (saveExpense
 * POST /despesas, deleteExpense). Compra NUNCA vira despesa de competencia (0078);
 * so afeta lucro via CMV quando vende.
 * NAO MORA AQUI: contas a pagar/receber (app.financeiro.contas.js / .receber.js).
 * VEIO DE: app.js commit ea22ea3 (range 1376-1549), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.financeiroCompras = () => ({
    // â”€â”€â”€ FORMS: PURCHASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async savePurchase() {
      if (!this.purchaseForm.item_name.trim()) { this.flash('Informe o pneu comprado.'); return; }
      const tireParts = [this.purchaseForm.tire_width, this.purchaseForm.tire_aspect, this.purchaseForm.tire_rim];
      const filledCount = tireParts.filter((v) => v !== null && v !== '' && Number(v) > 0).length;
      if (filledCount > 0 && filledCount < 3) {
        this.flash('Preencha largura, perfil e aro completos, ou deixe os tres vazios.');
        return;
      }
      const tireSize = filledCount === 3 ? this.composeTireSize(this.purchaseForm.tire_width, this.purchaseForm.tire_aspect, this.purchaseForm.tire_rim) : null;
      if (this.purchaseForm.payment_status === 'payable' && !this.purchaseForm.payable_due_date) {
        this.flash('Informe a data de vencimento da compra a prazo.');
        return;
      }
      this.saving = true;
      this.savingAction = 'purchase';
      try {
        await this.api('compras', {
          method: 'POST',
          body: JSON.stringify({
            supplier_name: this.purchaseForm.supplier_name.trim() || null,
            payment_status: this.purchaseForm.payment_status || 'paid_now',
            payable_due_date: this.purchaseForm.payment_status === 'payable' ? (this.purchaseForm.payable_due_date || null) : null,
            idempotency_key: this.uuid(),
            items: [{
              item_name: this.purchaseForm.item_name.trim(),
              tire_size: tireSize,
              tire_width_mm: tireSize ? this.num(this.purchaseForm.tire_width) : null,
              tire_aspect_ratio: tireSize ? this.num(this.purchaseForm.tire_aspect) : null,
              tire_rim_diameter: tireSize ? this.num(this.purchaseForm.tire_rim) : null,
              brand: this.purchaseForm.brand.trim() || null,
              quantity: this.num(this.purchaseForm.quantity) || 1,
              unit_cost: this.num(this.purchaseForm.unit_cost) || 0,
              sale_price: this.purchaseForm.sale_price !== null && this.purchaseForm.sale_price !== '' ? this.num(this.purchaseForm.sale_price) : null,
            }],
          }),
        });
        const wasPayable = this.purchaseForm.payment_status === 'payable';
        this.purchaseForm = { supplier_name: '', item_name: '', tire_width: null, tire_aspect: null, tire_rim: null, brand: '', quantity: 1, unit_cost: 0, sale_price: null, payment_status: 'paid_now', payable_due_date: '' };
        await this.loadData();
        this.flash(wasPayable
          ? 'Compra registrada (a prazo) — conta a pagar criada.'
          : 'Compra registrada e estoque atualizado.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async deletePurchase(purchaseId) {
      if (!confirm('Cancelar esta compra? Sai do custo do mês, fica registrada.')) return;
      this.saving = true;
      this.savingAction = 'purchase-delete';
      try {
        await this.api(`compras/${purchaseId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Compra cancelada.');
      } catch (err) {
        // Fix pos-Codex: tratamentos especificos para 409
        if (err.status === 409 && err.payload) {
          if (err.payload.error === 'cannot_delete_paid_purchase') {
            this.flash(err.payload.message || 'Esta compra ja foi paga e nao pode ser apagada.');
            return;
          }
          if (err.payload.error === 'stock_reversal_incomplete') {
            const items = (err.payload.failed_items || [])
              .map((it) => `- ${it.item_name} (qtd ${it.quantity})`)
              .join('\n');
            this.flash(`${err.payload.message}\n\nItens sem estorno:\n${items}`);
            return;
          }
        }
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async saveMaterialPayable() {
      if (!this.expenseForm.description.trim()) { this.flash('Descreva o material comprado.'); return; }
      if (this.num(this.expenseForm.amount) <= 0) { this.flash('Informe o valor do material.'); return; }
      this.saving = true;
      this.savingAction = 'payable';
      const idem = this.uuid();
      const payload = {
        counterparty_name: 'Compra de material',
        description: this.expenseForm.description.trim(),
        category: 'maintenance',
        amount: this.num(this.expenseForm.amount),
        due_date: null,
        status: 'paid',
        paid_at: new Date().toISOString(),
        payment_method: 'Pix',
        idempotency_key: idem,
      };
      const attempt = async (force) => this.api('contas-a-pagar', {
        method: 'POST',
        body: JSON.stringify({ ...payload, force_duplicate: force }),
      });
      try {
        try {
          await attempt(false);
        } catch (err) {
          // Fix pos-Codex: status='paid' agora roda dedupe via helper interno.
          // 409 duplicate_expense → pergunta e retenta com force.
          if (err.status === 409 && err.payload && err.payload.error === 'duplicate_expense') {
            const dups = (err.payload.duplicates || [])
              .map((d) => `- ${d.expense_date}: ${d.description} (R$ ${d.amount})`)
              .join('\n');
            const ok = confirm(`Ja existem despesas parecidas nos ultimos 7 dias:\n\n${dups}\n\nLancar mesmo assim?`);
            if (!ok) {
              this.flash('Cancelado. Confira despesas antes de lancar.');
              return;
            }
            await attempt(true);
          } else {
            throw err;
          }
        }
        this.expenseForm = { category: 'maintenance', description: '', amount: 0 };
        await this.loadData();
        this.flash('Material lançado em contas a pagar.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    // â”€â”€â”€ FORMS: EXPENSE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async saveExpense() {
      if (!this.expenseForm.description.trim()) { this.flash('Descreva a despesa.'); return; }
      this.saving = true;
      this.savingAction = 'expense';
      try {
        await this.api('despesas', {
          method: 'POST',
          body: JSON.stringify({
            category: this.expenseForm.category,
            description: this.expenseForm.description.trim(),
            amount: this.num(this.expenseForm.amount),
            idempotency_key: this.uuid(),
          }),
        });
        this.expenseForm = { category: this.expenseForm.category, description: '', amount: 0 };
        await this.loadData();
        this.flash('Despesa registrada.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async deleteExpense(expenseId) {
      if (!confirm('Excluir esta despesa do resumo?')) return;
      this.saving = true;
      this.savingAction = 'expense-delete';
      try {
        await this.api(`despesas/${expenseId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Despesa excluída.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },
});
