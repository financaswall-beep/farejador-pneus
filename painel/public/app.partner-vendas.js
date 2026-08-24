// Vendas da unidade no painel moderno. Este adaptador usa apenas o cliente
// autenticado do parceiro e o mesmo motor escopado usado pelo /operacao.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerVendas = function () {
  const cents = (value) => {
    let text = String(value ?? '').trim().replace(/R\$|\s/g, '');
    if (text.includes(',') && text.includes('.')) text = text.replace(/\./g, '');
    text = text.replace(',', '.');
    const number = Number(text);
    if (!Number.isFinite(number) || number < 0
      || Math.abs(number * 100 - Math.round(number * 100)) >= 1e-7) return null;
    return Math.round(number * 100);
  };
  const freshForm = () => ({
    open: false, customer_name: '', customer_phone: '', fulfillment_mode: 'pickup',
    delivery_address: '', payment_status: 'received', payment_method: 'Pix',
    receivable_due_date: '', discount_amount: 0, freight_amount: 0,
    received_amount: '', notes: '', source_tag: 'walkin_balcao', items: [],
    idempotency_key: null, saving: false, error: '',
  });
  const key = () => `panel-sale-${crypto.randomUUID()}`;
  return {
    partnerVendas: {
      rows: [], products: [], loading: false, error: '', notice: '', request: 0,
      busca: '', filtro: 'todos', page: 1, pageSize: 12, form: freshForm(),
    },

    async loadPartnerVendas() {
      if (!this.isPartnerPanel() || !this.hasPanelModule('vendas')) return;
      const request = ++this.partnerVendas.request;
      this.partnerVendas.loading = true;
      this.partnerVendas.error = '';
      try {
        const [sales, products] = await Promise.all([
          this.partnerApiGet('vendas'), this.partnerApiGet('produtos'),
        ]);
        if (request !== this.partnerVendas.request) return;
        this.partnerVendas.rows = Array.isArray(sales.rows) ? sales.rows : [];
        this.partnerVendas.products = Array.isArray(products.rows) ? products.rows : [];
        this.partnerVendas.page = 1;
      } catch (_) {
        if (request === this.partnerVendas.request) {
          this.partnerVendas.error = 'Não foi possível carregar as vendas desta unidade.';
        }
      } finally {
        if (request === this.partnerVendas.request) this.partnerVendas.loading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    partnerVendasFiltered() {
      const search = String(this.partnerVendas.busca || '').trim().toLocaleLowerCase('pt-BR');
      return this.partnerVendas.rows.filter((row) => {
        const filter = this.partnerVendas.filtro;
        const pending = row.awaiting_pickup
          || (row.fulfillment_mode === 'delivery' && row.delivery_status !== 'delivered');
        if (filter === 'confirmadas' && (row.status === 'cancelled' || pending)) return false;
        if (filter === 'pendentes' && !pending) return false;
        if (filter === 'canceladas' && row.status !== 'cancelled') return false;
        if (!search) return true;
        return [row.customer_name, row.customer_phone, row.order_id,
          ...(row.items || []).flatMap((item) => [item.item_name, item.tire_size, item.brand])]
          .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(search);
      });
    },

    partnerVendasPages() {
      return Math.max(1, Math.ceil(this.partnerVendasFiltered().length / this.partnerVendas.pageSize));
    },

    partnerVendasPaged() {
      const pages = this.partnerVendasPages();
      if (this.partnerVendas.page > pages) this.partnerVendas.page = pages;
      const start = (this.partnerVendas.page - 1) * this.partnerVendas.pageSize;
      return this.partnerVendasFiltered().slice(start, start + this.partnerVendas.pageSize);
    },

    partnerVendasSetPage(page) {
      this.partnerVendas.page = Math.min(this.partnerVendasPages(), Math.max(1, Number(page) || 1));
    },

    partnerVendasStatus(row) {
      if (row.status === 'cancelled') return 'Cancelada';
      if (row.awaiting_pickup) return 'Aguardando retirada';
      if (row.fulfillment_mode === 'delivery' && row.delivery_status !== 'delivered') return 'Em entrega';
      return 'Confirmada';
    },

    partnerVendasAvailable(product) {
      if (product.item_type === 'servico' || product.is_tracked === false) return 999999;
      return Math.max(0, Number(product.quantity_on_hand || 0)
        - Number(product.quantity_reserved || 0));
    },

    partnerVendasNew() {
      this.partnerVendas.form = { ...freshForm(), open: true };
    },

    partnerVendasClose() {
      if (!this.partnerVendas.form.saving) this.partnerVendas.form.open = false;
    },

    partnerVendasAdd(product) {
      const form = this.partnerVendas.form;
      const existing = form.items.find((item) => item.partner_stock_id === product.stock_id);
      const available = this.partnerVendasAvailable(product);
      if (existing) existing.quantity = Math.min(available, existing.quantity + 1);
      else if (available > 0 && cents(product.sale_price) > 0) form.items.push({
        partner_stock_id: product.stock_id, item_name: product.item_name,
        tire_size: product.tire_size, brand: product.brand, quantity: 1,
        available, unit_price: Number(product.sale_price),
        reference_unit_price: Number(product.sale_price), discount_amount: 0,
      });
      form.idempotency_key = null;
    },

    partnerVendasRemove(index) {
      this.partnerVendas.form.items.splice(index, 1);
      this.partnerVendas.form.idempotency_key = null;
    },

    partnerVendasTotalCents() {
      let total = 0;
      for (const item of this.partnerVendas.form.items) {
        const price = cents(item.unit_price);
        const discount = cents(item.discount_amount || 0);
        if (price === null || price <= 0 || discount === null
          || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0
          || discount > price * Number(item.quantity)) return null;
        total += price * Number(item.quantity) - discount;
      }
      const orderDiscount = cents(this.partnerVendas.form.discount_amount || 0);
      const freight = cents(this.partnerVendas.form.freight_amount || 0);
      if (orderDiscount === null || freight === null) return null;
      total = total - orderDiscount + freight;
      return Number.isSafeInteger(total) && total > 0 && total <= 9_999_999_999
        ? total : null;
    },

    partnerVendasSetFulfillment(mode) {
      const form = this.partnerVendas.form;
      form.fulfillment_mode = mode;
      if (mode === 'delivery') {
        form.payment_status = 'receivable'; form.payment_method = null;
        form.receivable_due_date = '';
      } else if (!form.payment_method) {
        form.payment_status = 'received'; form.payment_method = 'Pix';
      }
      form.idempotency_key = null;
    },

    partnerVendasValidation() {
      const form = this.partnerVendas.form;
      if (!form.items.length) return 'Adicione pelo menos um item.';
      for (const item of form.items) {
        if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0
          || Number(item.quantity) > Number(item.available)) return 'Revise a quantidade disponível.';
      }
      const total = this.partnerVendasTotalCents();
      if (total === null) return 'Revise preços, descontos e total da venda.';
      if (form.fulfillment_mode === 'delivery' && !String(form.delivery_address).trim()) {
        return 'Informe o endereço da entrega.';
      }
      if (form.payment_status === 'receivable' && form.fulfillment_mode !== 'delivery'
        && !form.receivable_due_date) return 'Informe o vencimento da venda fiada.';
      if (form.payment_status !== 'receivable' && !String(form.payment_method || '').trim()) {
        return 'Escolha a forma de pagamento.';
      }
      if (form.payment_status !== 'receivable' && form.received_amount !== ''
        && (cents(form.received_amount) ?? -1) < total) return 'O valor recebido é menor que o total.';
      return '';
    },

    async partnerVendasSubmit() {
      const form = this.partnerVendas.form;
      form.error = this.partnerVendasValidation();
      if (form.error || form.saving) return;
      form.saving = true;
      form.idempotency_key = form.idempotency_key || key();
      const total = this.partnerVendasTotalCents();
      try {
        await this.partnerApiWrite('vendas', 'POST', {
          customer_name: String(form.customer_name || '').trim() || null,
          customer_phone: String(form.customer_phone || '').trim() || null,
          items: form.items.map((item) => ({
            partner_stock_id: item.partner_stock_id, quantity: Number(item.quantity),
            unit_price: cents(item.unit_price) / 100,
            reference_unit_price: cents(item.reference_unit_price) / 100,
            discount_amount: cents(item.discount_amount || 0) / 100,
          })),
          payment_method: form.payment_status === 'receivable' ? null : form.payment_method,
          payment_status: form.payment_status, receivable_installments: 1,
          receivable_due_date: form.payment_status === 'receivable'
            && form.fulfillment_mode !== 'delivery' ? form.receivable_due_date : null,
          fulfillment_mode: form.fulfillment_mode,
          delivery_address: form.fulfillment_mode === 'delivery'
            ? String(form.delivery_address).trim() : null,
          notes: String(form.notes || '').trim() || null,
          received_amount: form.payment_status === 'receivable' ? null
            : (form.received_amount === '' ? total / 100 : cents(form.received_amount) / 100),
          discount_amount: cents(form.discount_amount || 0) / 100,
          freight_amount: cents(form.freight_amount || 0) / 100,
          source_tag: form.source_tag || 'walkin_balcao', idempotency_key: form.idempotency_key,
        });
        this.partnerVendas.notice = 'Venda registrada com estoque e financeiro conciliados.';
        this.partnerVendas.form = freshForm();
        await this.loadPartnerVendas();
      } catch (error) {
        form.error = ['partner_sale_price_changed', 'partner_sale_price_missing'].includes(error?.code)
          ? 'O preço oficial mudou. Atualize os produtos e revise a venda.'
          : 'Não foi possível registrar. Nenhuma confirmação foi assumida.';
      } finally {
        form.saving = false;
      }
    },

    async partnerVendasCancel(row, reason) {
      const text = String(reason || '').trim();
      await this.partnerApiWrite(`vendas/${encodeURIComponent(row.order_id)}`, 'DELETE', {
        reason: text || null,
      });
      this.partnerVendas.notice = 'Venda cancelada e efeitos causais revertidos.';
      await this.loadPartnerVendas();
    },
  };
};
