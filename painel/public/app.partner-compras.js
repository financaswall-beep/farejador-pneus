// Compras da unidade no painel moderno. Leitura segue a permissão Financeiro;
// criar/cancelar continua sendo ação exclusiva do proprietário no servidor.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerCompras = function () {
  const cents = (value) => {
    let text = String(value ?? '').trim().replace(/R\$|\s/g, '');
    if (text.includes(',') && text.includes('.')) text = text.replace(/\./g, '');
    text = text.replace(',', '.');
    const number = Number(text);
    if (!Number.isFinite(number) || number < 0
      || Math.abs(number * 100 - Math.round(number * 100)) >= 1e-7) return null;
    return Math.round(number * 100);
  };
  const emptyItem = () => ({
    product_id: null, item_name: '', tire_size: '', brand: '', tire_condition: '',
    quantity: 1, unit_cost: '', sale_price: '',
  });
  const freshForm = () => ({
    open: false, supplier_name: '', purchased_at: '', payment_status: 'paid_now',
    payment_method: 'Pix', payable_due_date: '', notes: '', items: [emptyItem()],
    idempotency_key: null, saving: false, error: '',
  });
  return {
    partnerCompras: {
      rows: [], loading: false, error: '', notice: '', request: 0,
      busca: '', filtro: 'todas', page: 1, pageSize: 12, form: freshForm(),
    },

    partnerComprasOwner() {
      return this.panelWorkplace?.role === 'owner';
    },

    async loadPartnerCompras() {
      if (!this.isPartnerPanel() || !this.hasPanelModule('financeiro')) return;
      const request = ++this.partnerCompras.request;
      this.partnerCompras.loading = true;
      this.partnerCompras.error = '';
      try {
        const payload = await this.partnerApiGet('compras');
        if (request !== this.partnerCompras.request) return;
        this.partnerCompras.rows = Array.isArray(payload.rows) ? payload.rows : [];
        this.partnerCompras.page = 1;
      } catch (_) {
        if (request === this.partnerCompras.request) {
          this.partnerCompras.error = 'Não foi possível carregar as compras desta unidade.';
        }
      } finally {
        if (request === this.partnerCompras.request) this.partnerCompras.loading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    partnerComprasFiltered() {
      const search = String(this.partnerCompras.busca || '').trim().toLocaleLowerCase('pt-BR');
      return this.partnerCompras.rows.filter((row) => {
        const filter = this.partnerCompras.filtro;
        if (filter === 'aguardando' && row.receipt_status !== 'pending') return false;
        if (filter === 'recebidas' && row.receipt_status !== 'received') return false;
        if (filter === 'a_pagar' && row.payment_status !== 'payable') return false;
        if (!search) return true;
        return [row.id, row.supplier_name,
          ...(row.items || []).flatMap((item) => [item.item_name, item.tire_size, item.brand])]
          .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(search);
      });
    },

    partnerComprasPages() {
      return Math.max(1, Math.ceil(this.partnerComprasFiltered().length / this.partnerCompras.pageSize));
    },

    partnerComprasPaged() {
      const pages = this.partnerComprasPages();
      if (this.partnerCompras.page > pages) this.partnerCompras.page = pages;
      const start = (this.partnerCompras.page - 1) * this.partnerCompras.pageSize;
      return this.partnerComprasFiltered().slice(start, start + this.partnerCompras.pageSize);
    },

    partnerComprasSetPage(page) {
      this.partnerCompras.page = Math.min(this.partnerComprasPages(), Math.max(1, Number(page) || 1));
    },

    partnerComprasStatus(row) {
      if (row.receipt_status === 'received') return 'Recebida';
      if (row.source_wholesale_order_id && !row.matrix_arrival_settled) return 'Acerto na Matriz';
      return 'Aguardando conferência';
    },

    partnerComprasNew() {
      if (!this.partnerComprasOwner()) {
        this.partnerCompras.notice = 'Somente o proprietário pode registrar compras.';
        return;
      }
      this.partnerCompras.form = { ...freshForm(), open: true };
    },

    partnerComprasClose() {
      if (!this.partnerCompras.form.saving) this.partnerCompras.form.open = false;
    },

    partnerComprasAddItem() {
      this.partnerCompras.form.items.push(emptyItem());
      this.partnerCompras.form.idempotency_key = null;
    },

    partnerComprasRemoveItem(index) {
      if (this.partnerCompras.form.items.length > 1) {
        this.partnerCompras.form.items.splice(index, 1);
        this.partnerCompras.form.idempotency_key = null;
      }
    },

    partnerComprasTotalCents() {
      let total = 0;
      for (const item of this.partnerCompras.form.items) {
        if (String(item.unit_cost ?? '').trim() === '') return null;
        const cost = cents(item.unit_cost);
        const quantity = Number(item.quantity);
        if (cost === null || !Number.isInteger(quantity) || quantity <= 0) return null;
        total += cost * quantity;
      }
      return Number.isSafeInteger(total) && total >= 0 && total <= 9_999_999_999
        ? total : null;
    },

    partnerComprasValidation() {
      const form = this.partnerCompras.form;
      if (!this.partnerComprasOwner()) return 'Somente o proprietário pode registrar compras.';
      if (!form.items.length) return 'Adicione ao menos um item.';
      for (const item of form.items) {
        if (!String(item.item_name || '').trim()) return 'Informe o nome de todos os itens.';
        if (!['novo', 'meia_vida', 'remold'].includes(item.tire_condition)) {
          return 'Informe a condição de todos os pneus.';
        }
        if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0
          || String(item.unit_cost ?? '').trim() === ''
          || cents(item.unit_cost) === null) return 'Revise quantidades e custos.';
        if (item.sale_price !== '' && (cents(item.sale_price) ?? 0) <= 0) {
          return 'O preço de venda deve ser positivo ou ficar em branco.';
        }
      }
      if (this.partnerComprasTotalCents() === null) return 'O total da compra é inválido.';
      if (form.payment_status === 'paid_now' && !String(form.payment_method || '').trim()) {
        return 'Escolha a forma de pagamento da compra à vista.';
      }
      if (form.payment_status === 'payable' && !form.payable_due_date) {
        return 'Informe o vencimento da compra a prazo.';
      }
      return '';
    },

    async partnerComprasSubmit() {
      const form = this.partnerCompras.form;
      form.error = this.partnerComprasValidation();
      if (form.error || form.saving) return;
      form.saving = true;
      form.idempotency_key = form.idempotency_key || `panel-purchase-${crypto.randomUUID()}`;
      try {
        const purchasedAt = form.purchased_at
          ? this.businessFactInstant(form.purchased_at) : null;
        await this.partnerApiWrite('compras', 'POST', {
          supplier_name: String(form.supplier_name || '').trim() || null,
          purchased_at: purchasedAt,
          payment_status: form.payment_status,
          payment_method: form.payment_status === 'paid_now' ? form.payment_method : null,
          payable_due_date: form.payment_status === 'payable' ? form.payable_due_date : null,
          notes: String(form.notes || '').trim() || null,
          idempotency_key: form.idempotency_key,
          items: form.items.map((item) => ({
            product_id: item.product_id || null,
            item_name: String(item.item_name).trim(),
            tire_size: String(item.tire_size || '').trim() || null,
            brand: String(item.brand || '').trim() || null,
            tire_condition: item.tire_condition,
            quantity: Number(item.quantity), unit_cost: cents(item.unit_cost) / 100,
            sale_price: item.sale_price === '' ? null : cents(item.sale_price) / 100,
          })),
        });
        this.partnerCompras.notice = 'Compra registrada. O estoque mudará somente no recebimento.';
        this.partnerCompras.form = freshForm();
        await this.loadPartnerCompras();
      } catch (_) {
        form.error = 'Não foi possível registrar. Nenhuma entrada de estoque foi assumida.';
      } finally {
        form.saving = false;
      }
    },

    async partnerComprasCancel(row) {
      if (!this.partnerComprasOwner()) {
        this.partnerCompras.notice = 'Somente o proprietário pode cancelar compras.';
        return;
      }
      await this.partnerApiWrite(`compras/${encodeURIComponent(row.id)}`, 'DELETE', {});
      this.partnerCompras.notice = 'Compra cancelada e efeitos causais revertidos.';
      await this.loadPartnerCompras();
    },
  };
};
