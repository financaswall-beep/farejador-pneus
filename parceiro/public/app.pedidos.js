/**
 * app.pedidos.js - fabrica `pedidos` do painel do parceiro (obra <=300, passo 10/11).
 * MORA AQUI: a aba Pedidos (entrega/COD) - getters da lista/filtros/KPIs, form de
 * criacao (item/cliente/endereco), submitOrder (POST vendas idempotente 'order-',
 * payment_status receivable, source_tag 2w) e o status de entrega
 * (confirmDeliveryFailed + setDeliveryStatus: payment_method SO no delivered).
 * NAO MORA AQUI: tela Entrega/rota e Retiradas (app.entregas.js); checkout do
 * balcao (app.pdv.js).
 * VEIO DE: app.js commit 29e9817 (range 715-878), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.pedidos = () => ({
    // ─── Aba Pedidos (entrega/COD): lista, ficha e criação ───
    get deliveryOrders() {
      // Inclui cancelados — entrega falhada vira cancelada e precisa aparecer no filtro "Não entregues".
      return this.vendas.filter((o) => o.fulfillment_mode === 'delivery');
    },
    get ordersOpenList() {
      return this.deliveryOrders.filter((o) => o.status !== 'cancelled'
        && (o.delivery_status === 'pending' || o.delivery_status === 'dispatched'));
    },
    get filteredOrders() {
      if (this.orderFilter === 'open') return this.ordersOpenList;
      // Finalizados = entregue de verdade (cancelado nao conta como finalizado).
      if (this.orderFilter === 'delivered') return this.deliveryOrders.filter((o) => o.delivery_status === 'delivered' && o.status !== 'cancelled');
      // Nao entregues = falha de entrega OU pedido cancelado.
      if (this.orderFilter === 'failed') return this.deliveryOrders.filter((o) => o.delivery_status === 'failed' || o.status === 'cancelled');
      return this.deliveryOrders;
    },
    get ordersOpenCount() { return this.ordersOpenList.length; },
    get ordersOpenAmount() { return this.ordersOpenList.reduce((s, o) => s + this.num(o.total_amount), 0); },
    get ordersDeliveredCount() { return this.deliveryOrders.filter((o) => o.delivery_status === 'delivered' && o.status !== 'cancelled').length; },
    get ordersFailedCount() { return this.deliveryOrders.filter((o) => o.delivery_status === 'failed' || o.status === 'cancelled').length; },
    get orderCartTotal() { return this.orderCart.reduce((s, it) => s + this.num(it.unit_price) * this.num(it.quantity), 0); },

    onOrderItemChange() {
      const item = this.produtos.find((p) => p.stock_id === this.orderItemForm.partner_stock_id);
      if (item && item.sale_price !== null && item.sale_price !== undefined) {
        this.orderItemForm.unit_price = Number(item.sale_price);
      }
    },
    addOrderItem() {
      const id = this.orderItemForm.partner_stock_id;
      if (!id) { this.flash('Escolha um item do estoque.'); return; }
      const prod = this.produtos.find((p) => p.stock_id === id);
      if (!prod) { this.flash('Item não encontrado no estoque.'); return; }
      const qty = Math.max(1, this.num(this.orderItemForm.quantity) || 1);
      const available = this.stockAvailable(prod);
      const existing = this.orderCart.find((it) => it.partner_stock_id === id);
      if ((existing ? existing.quantity : 0) + qty > available) {
        this.flash('Quantidade maior que o estoque disponível.');
        return;
      }
      const price = this.num(this.orderItemForm.unit_price) || this.num(prod.sale_price) || 0;
      if (existing) { existing.quantity += qty; existing.unit_price = price; }
      else this.orderCart.push({ partner_stock_id: id, item_name: prod.item_name, tire_size: prod.tire_size, quantity: qty, unit_price: price });
      this.orderItemForm = { partner_stock_id: '', quantity: 1, unit_price: 0 };
    },
    removeOrderItem(idx) { this.orderCart.splice(idx, 1); },
    resetOrderForm() {
      this.orderForm = { customer_id: null, customer_name: '', customer_phone: '', delivery_address: '' };
      this.orderItemForm = { partner_stock_id: '', quantity: 1, unit_price: 0 };
      this.orderCart = [];
      this.orderAddressMissing = false;
      this.orderCustomerResults = [];
    },

    // Busca cliente cadastrado (nome ou telefone) enquanto digita no campo Cliente.
    // Mesmo endpoint do PDV. Digitar mexe no nome e zera o vinculo ate escolher.
    onOrderCustomerSearch() {
      this.orderForm.customer_id = null;
      clearTimeout(this.orderCustomerTimer);
      const q = String(this.orderForm.customer_name || '').trim();
      if (q.length < 2) { this.orderCustomerResults = []; return; }
      this.orderCustomerTimer = setTimeout(async () => {
        try {
          const result = await this.api(`clientes/buscar?q=${encodeURIComponent(q)}`, { method: 'GET' });
          this.orderCustomerResults = result.rows || [];
        } catch {
          this.orderCustomerResults = [];
        }
      }, 250);
    },
    // Escolhe um cliente da busca: preenche nome, telefone (so digitos) e, se tiver
    // endereco cadastrado e o campo estiver vazio, ja sugere o endereco de entrega.
    selectOrderCustomer(customer) {
      if (!customer) return;
      this.orderForm.customer_id = customer.id;
      this.orderForm.customer_name = customer.name || '';
      let ph = String(customer.phone || '').replace(/\D/g, '');
      if ((ph.length === 12 || ph.length === 13) && ph.startsWith('55')) ph = ph.slice(2);
      this.orderForm.customer_phone = ph;
      const addr = this.customerAddressLine(customer);
      if (addr && addr !== '-' && !this.orderForm.delivery_address.trim()) {
        this.orderForm.delivery_address = addr;
        this.orderAddressMissing = false;
      }
      this.orderCustomerResults = [];
    },
    async submitOrder() {
      if (!this.orderCart.length) { this.flash('Adicione pelo menos um item ao pedido.'); return; }
      if (!this.orderForm.delivery_address.trim()) {
        this.orderAddressMissing = true;
        this.flash('Informe o endereço de entrega.');
        return;
      }
      this.saving = true; this.savingAction = 'order';
      try {
        const body = {
          customer_id: this.orderForm.customer_id || null,
          customer_name: this.orderForm.customer_name.trim() || null,
          customer_phone: this.toE164Phone(this.orderForm.customer_phone),
          items: this.orderCart.map((it) => ({
            partner_stock_id: it.partner_stock_id,
            quantity: this.num(it.quantity) || 1,
            unit_price: this.num(it.unit_price) || 0,
          })),
          payment_method: 'A receber',
          payment_status: 'receivable',
          receivable_due_date: null,
          fulfillment_mode: 'delivery',
          delivery_address: this.orderForm.delivery_address.trim(),
          source_tag: '2w',
          idempotency_key: 'order-' + (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2))),
        };
        await this.api('vendas', { method: 'POST', body: JSON.stringify(body) });
        this.resetOrderForm();
        this.orderFilter = 'open';
        this.orderMobileStep = 'list'; // no celular, volta pra lista pra ver o pedido criado
        await this.loadData();
        this.flash('Pedido gerado — estoque reservado. Entra no caixa quando o entregador finalizar.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    confirmDeliveryFailed(sale) {
      if (!sale || !sale.order_id) return;
      const who = sale.customer_name || 'este pedido';
      const reason = prompt(`Marcar a entrega de ${who} como NÃO entregue?\n\nEscreva o motivo (o estoque volta e nada entra no caixa):`);
      if (reason === null) return; // cancelou o prompt
      if (this.isTwoW(sale) && !reason.trim()) { this.flash('Escreva o motivo (pedido da Rede 2W).'); return; }
      this.setDeliveryStatus(sale, 'failed', reason.trim());
    },

    async setDeliveryStatus(sale, status, reason) {
      if (!sale || !sale.order_id) return;
      const courier = (this.deliveryDrafts[sale.order_id] ?? sale.delivery_courier ?? '').trim();
      const action = `delivery-${sale.order_id}`;
      // So manda forma de pagamento ao finalizar — ai a conta a receber entra
      // no caixa registrada como Pix/Dinheiro/Cartao em vez de "A receber".
      const payment_method = status === 'delivered'
        ? (this.deliveryPayDrafts[sale.order_id] || 'Pix')
        : null;
      this.saving = true; this.savingAction = action;
      try {
        await this.api(`entregas/${sale.order_id}`, {
          method: 'POST',
          body: JSON.stringify({ delivery_status: status, delivery_courier: courier || null, payment_method, reason: reason ?? null }),
        });
        await this.loadData();
        const flashes = {
          delivered: 'Entrega finalizada — venda registrada e dinheiro no caixa.',
          dispatched: 'Saiu pra entrega.',
          failed: 'Marcado como não entregue — estoque devolvido, nada no caixa.',
          pending: 'Entrega reaberta.',
        };
        this.flash(flashes[status] || 'Entrega atualizada.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },
});
