window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasLotes = function () {
  return {
    compraReceiptItem(item) {
      return { item_id: item.id, item_kind: item.item_kind,
        measure: item.measure, brand: item.brand, tire_condition: item.tire_condition,
        ordered_quantity: Number(item.ordered_quantity ?? item.quantity ?? 0),
        accepted_quantity: Number(item.ordered_quantity ?? item.quantity ?? 0),
        unit_cost: Number(item.unit_cost || 0) };
    },
    lotPurchaseFreshForm() {
      const today = this.finHoje();
      return { supplierKey: '', newName: '', newPhone: '', newDocument: '',
        vehicle_type: '', description: '', quantity: '', total_cost: '', freight_amount: '', discount_amount: '',
        purchased_at: today, received_at: today, paid_at: today,
        supplier_reference: '', notes: '', receipt_status: 'received', payment_status: 'paid',
        payment_method: 'Pix', due_date: '', idempotency_key: '' };
    },
    lotPurchaseDraftKey() {
      return 'farejador:lot-purchase:' + this.serverEnvironment + ':' + (this.adminUser?.id || this.adminUser?.username || 'owner');
    },
    lotPurchaseOpen() {
      if (this.adminUser?.role !== 'owner') return;
      if (!this.lotPurchaseForm) {
        this.lotPurchaseForm = this.lotPurchaseFreshForm();
        try {
          const saved = JSON.parse(sessionStorage.getItem(this.lotPurchaseDraftKey()) || 'null');
          if (saved?.form) {
            this.lotPurchaseForm = { ...this.lotPurchaseForm, ...saved.form };
            this.lotPurchasePendingBody = saved.pending || null;
            this.lotPurchaseMsg = { ok: true, text: saved.pending
              ? 'Há um envio sem confirmação. Tente novamente para conferir a mesma compra.'
              : 'Rascunho recuperado desta sessão.' };
          }
        } catch (_) { /* A damaged browser draft must not block a new purchase. */ }
      }
      this.comprasTab = 'lote';
      this.$nextTick(() => {
        window.lucide?.createIcons();
        document.getElementById('farejador-main')?.scrollTo({ top: 0 });
        this.$refs.lotPurchaseHeading?.focus({ preventScroll: true });
      });
    },
    lotPurchaseTotals() {
      const f = this.lotPurchaseForm || {};
      const products = Math.round((Number(f.total_cost) || 0) * 100);
      const freight = Math.round((Number(f.freight_amount) || 0) * 100);
      const discount = Math.round((Number(f.discount_amount) || 0) * 100);
      const total = products + freight - discount;
      const quantity = Number(f.quantity) || 0;
      return { products: products / 100, freight: freight / 100, discount: discount / 100,
        total: total / 100, unit: quantity > 0 ? total / 100 / quantity : null, quantity };
    },
    lotPurchaseUnitText() {
      const value = this.lotPurchaseTotals().unit;
      return value === null || value < 0 ? '—' : new Intl.NumberFormat('pt-BR', {
        style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 6,
      }).format(value);
    },
    lotPurchaseStoreDraft() {
      try {
        sessionStorage.setItem(this.lotPurchaseDraftKey(), JSON.stringify({
          form: this.lotPurchaseForm, pending: this.lotPurchasePendingBody,
        }));
        return true;
      } catch (_) { return false; }
    },
    lotPurchaseSaveDraft() {
      this.lotPurchaseMsg = this.lotPurchaseStoreDraft()
        ? { ok: true, text: 'Rascunho salvo nesta sessão do navegador. Ainda não movimenta estoque ou financeiro.' }
        : { ok: false, text: 'O navegador não permitiu salvar o rascunho. Mantenha esta tela aberta.' };
    },
    lotPurchaseBuildBody() {
      const f = this.lotPurchaseForm;
      const fail = (text) => { this.lotPurchaseMsg = { ok: false, text }; return null; };
      if (!f.supplierKey) return fail('Escolha o fornecedor ou cadastre um novo.');
      if (f.supplierKey === 'new' && !f.newName.trim()) return fail('Informe o nome do fornecedor.');
      if (!f.description.trim()) return fail('Descreva o lote.');
      const quantity = Number(f.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) return fail('Informe de 1 a 100.000 pneus, sem frações.');
      for (const field of ['total_cost', 'freight_amount', 'discount_amount']) {
        const value = Number(f[field] || 0);
        if (!Number.isFinite(value) || value < 0 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
          return fail('Informe valores válidos, com até duas casas decimais.');
        }
      }
      const totals = this.lotPurchaseTotals();
      if (!(Number(f.total_cost) > 0) || Number(f.total_cost) > 9999999.99 || totals.total <= 0) return fail('Confira o valor total do lote e o desconto.');
      const today = this.finHoje();
      if (!f.purchased_at || f.purchased_at > today) return fail('Informe uma data de compra até hoje.');
      if (f.receipt_status === 'received' && (!f.received_at || f.received_at > today || f.received_at < f.purchased_at)) {
        return fail('O recebimento deve estar entre a data da compra e hoje.');
      }
      if (f.payment_status === 'paid' && (!f.paid_at || f.paid_at > today || !f.payment_method)) return fail('Confira a data e a forma de pagamento.');
      if (f.payment_status === 'pending') {
        if (!this.atacadoFinance) return fail('O financeiro de Compras precisa estar ativo para registrar a prazo.');
        if (!f.due_date || f.due_date < f.purchased_at) return fail('Informe um vencimento igual ou posterior à compra.');
      }
      f.idempotency_key ||= window.PAINEL_INTEGRITY.operation('lot-purchase-create', 'form').key;
      return {
        ...(f.supplierKey === 'new' ? { new_supplier: { name: f.newName.trim(),
          phone: f.newPhone.trim() || null, document: f.newDocument.trim() || null } } : { supplier_id: f.supplierKey }),
        lot: { vehicle_type: f.vehicle_type || null, description: f.description.trim(), quantity, total_cost: Number(f.total_cost) },
        purchased_at: this.businessFactInstant(f.purchased_at),
        ...(f.receipt_status === 'received' ? { received_at: this.businessFactInstant(f.received_at) } : {}),
        ...(f.payment_status === 'paid' ? { paid_at: this.businessFactInstant(f.paid_at), payment_method: f.payment_method }
          : { due_date: f.due_date }),
        receipt_status: f.receipt_status, payment_status: f.payment_status,
        freight_amount: totals.freight, discount_amount: totals.discount,
        supplier_reference: f.supplier_reference.trim() || null, notes: f.notes.trim() || null,
        idempotency_key: f.idempotency_key,
      };
    },
    async lotPurchaseSubmit() {
      if (this.adminUser?.role !== 'owner' || this.lotPurchaseSaving) return;
      const body = this.lotPurchasePendingBody || this.lotPurchaseBuildBody();
      if (!body) return;
      this.lotPurchasePendingBody = body;
      this.lotPurchaseStoreDraft();
      this.lotPurchaseSaving = true;
      this.lotPurchaseMsg = null;
      try {
        const result = await this.apiPost('/admin/api/wholesale/lot-purchases', body);
        window.PAINEL_INTEGRITY.complete('lot-purchase-create', 'form');
        try { sessionStorage.removeItem(this.lotPurchaseDraftKey()); } catch (_) { /* Optional browser storage. */ }
        this.lotPurchasePendingBody = null;
        this.lotPurchaseForm = this.lotPurchaseFreshForm();
        this.lotPurchaseResult = result;
        this.lotPurchaseMsg = { ok: true, text: `${result.lot_code} · ${result.order_code}: compra registrada. `
          + (result.stock_applied ? 'Lote recebido e saldo registrado. ' : 'Aguardando recebimento. ')
          + (body.payment_status === 'paid' ? 'Pagamento registrado.' : 'Conta a pagar registrada.') };
        await Promise.allSettled([this.loadCompras(), this.loadFinanceiro(), this.loadSino()]);
      } catch (err) {
        // A network timeout may follow a committed purchase: retry the identical payload/key.
        const correctable = ['supplier_not_found', 'supplier_required', 'supplier_duplicate',
          'lot_total_cost_invalid', 'lot_description_required', 'purchase_quantity_invalid',
          'purchased_at_future', 'paid_at_future', 'received_at_future', 'received_before_purchase',
          'due_date_before_purchase', 'discount_exceeds_purchase', 'wholesale_finance_disabled'];
        if (err.status === 400 || err.status === 422 || correctable.includes(err.message)) {
          this.lotPurchasePendingBody = null;
          this.lotPurchaseStoreDraft();
        }
        const messages = { lot_total_cost_invalid: 'Confira o custo total do lote.',
          received_before_purchase: 'O recebimento não pode ser anterior à compra.',
          wholesale_finance_disabled: 'Ative o financeiro de Compras para registrar a prazo.' };
        this.lotPurchaseMsg = { ok: false, text: messages[err.message] || this.compraErrText(err.message) };
        if (this.lotPurchasePendingBody) this.lotPurchaseMsg.text += ' Tente novamente: será conferida a mesma compra, sem duplicar.';
      } finally {
        this.lotPurchaseSaving = false;
        this.$nextTick(() => document.getElementById('farejador-main')?.scrollTo({ top: 0 }));
      }
    },
  };
};
