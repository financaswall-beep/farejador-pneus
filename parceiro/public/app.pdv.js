/**
 * app.pdv.js - fabrica `pdv` do painel do parceiro (obra <=300, passo 8/11).
 * MORA AQUI: o FLUXO DE VENDER - carrinho (add/inc/dec/remove/clear; bloqueia pela
 * DISPONIBILIDADE stockAvailable = fisico - reservado, contrato 0076), checkout
 * (pagamento/entrega), posFinalizeSale e saveSale (POST /vendas com
 * receivable_installments SEMPRE 1 - parcelamento desligado; idempotency_key estavel
 * na re-tentativa) e cancelSale (DELETE /vendas/:id devolve estoque via SQL).
 * NAO MORA AQUI: getters de leitura (app.pdv.kpis.js); cliente (app.pdv.clientes.js).
 * VEIO DE: app.js commit d04768b (ranges 1518-1526, 1563-1642, 1854-2042), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.pdv = () => ({
    // â”€â”€â”€ FORMS: SALE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Auto-preenche o preÃ§o unitÃ¡rio com o sale_price do estoque local do parceiro.
    onSaleProductChange() {
      const item = this.produtos.find((p) => p.stock_id === this.saleForm.partner_stock_id);
      if (item && item.sale_price !== null && item.sale_price !== undefined) {
        this.saleForm.unit_price = Number(item.sale_price);
      }
    },

    posAddProduct(item) {
      if (!item || !item.stock_id) return;
      const current = this.posCart.find((cartItem) => cartItem.partner_stock_id === item.stock_id);
      const available = this.stockAvailable(item);
      const nextQty = current ? current.quantity + 1 : 1;
      if (nextQty > available) {
        this.flash('Quantidade maior que o estoque disponível.');
        return;
      }
      if (current) {
        current.quantity = nextQty;
        return;
      }
      this.posCart.push({
        partner_stock_id: item.stock_id,
        item_name: item.item_name || 'Produto',
        tire_size: item.tire_size || '',
        brand: item.brand || '',
        quantity: 1,
        unit_price: this.num(item.sale_price),
        available,
      });
    },

    posIncrementItem(cartItem) {
      if (!cartItem) return;
      if (cartItem.quantity + 1 > cartItem.available) {
        this.flash('Quantidade maior que o estoque disponível.');
        return;
      }
      cartItem.quantity += 1;
    },

    posDecrementItem(cartItem) {
      if (!cartItem) return;
      if (cartItem.quantity <= 1) {
        this.posRemoveItem(cartItem.partner_stock_id);
        return;
      }
      cartItem.quantity -= 1;
    },

    posRemoveItem(stockId) {
      this.posCart = this.posCart.filter((item) => item.partner_stock_id !== stockId);
    },

    posClearCart() {
      this.posCart = [];
      this.posDiscountAmount = 0;
      this.posFreightAmount = 0;
      this.posReceivedAmount = null;
      this.posNotes = '';
      this.posSaleIdempotencyKey = null;
      this.posMobileStep = 'select'; // carrinho vazio volta pra etapa de selecao no celular
    },

    // Avanca pra etapa de finalizar (so faz efeito no celular; no desktop tudo ja aparece junto).
    posGoCheckout() {
      if (!this.posCart.length) {
        this.flash('Adicione pelo menos um produto ao carrinho.');
        return;
      }
      this.posMobileStep = 'checkout';
      this.$nextTick(() => document.querySelector('.pos-main')?.scrollTo({ top: 0, behavior: 'smooth' }));
    },

    ensurePosSaleIdempotencyKey() {
      if (!this.posSaleIdempotencyKey) {
        this.posSaleIdempotencyKey = this.uuid();
      }
      return this.posSaleIdempotencyKey;
    },

    posSelectPayment(method, status = 'received') {
      this.saleForm.payment_method = method;
      this.saleForm.payment_status = status;
      if (status === 'receivable' && !this.saleForm.receivable_due_date) {
        this.saleForm.receivable_due_date = new Date().toISOString().slice(0, 10);
      }
    },

    onFulfillmentChange() {
      if (this.saleForm.fulfillment_mode !== 'delivery') {
        this.deliveryAddressMissing = false;
        return;
      }
      // Cliente com endereco cadastrado: ja preenche a entrega.
      if (!this.saleForm.delivery_address.trim() && this.posSelectedCustomerAddress) {
        this.saleForm.delivery_address = this.posSelectedCustomerAddress;
        this.deliveryAddressMissing = false;
        return;
      }
      this.$nextTick(() => this.$refs.deliveryAddress?.focus());
    },

    async posFinalizeSale() {
      if (!this.posCart.length) {
        this.flash('Adicione pelo menos um produto ao carrinho.');
        return;
      }
      if (this.saleForm.fulfillment_mode === 'delivery' && !this.saleForm.delivery_address.trim()) {
        this.deliveryAddressMissing = true;
        this.$nextTick(() => this.$refs.deliveryAddress?.focus());
        this.flash('Informe o endereço de entrega ou mude para retirada.');
        return;
      }
      this.deliveryAddressMissing = false;
      if (this.saleForm.payment_status === 'receivable' && !this.saleForm.receivable_due_date) {
        this.flash('Informe a data para receber esta venda.');
        return;
      }
      const receivedAmount = this.saleForm.payment_status === 'receivable'
        ? null
        : this.num(this.posReceivedAmount ?? this.posCartTotal);
      if (this.saleForm.payment_status !== 'receivable' && receivedAmount < this.posCartTotal) {
        this.flash('Valor recebido menor que o total da venda.');
        return;
      }
      this.saving = true;
      this.savingAction = 'sale';
      try {
        const stableIdempotencyKey = this.ensurePosSaleIdempotencyKey();
        const body = {
          customer_id: this.saleForm.customer_id || null,
          customer_name: this.saleForm.customer_name.trim() || null,
          customer_phone: this.toE164Phone(this.saleForm.customer_phone),
          items: this.posCart.map((item) => ({
            partner_stock_id: item.partner_stock_id,
            quantity: this.num(item.quantity) || 1,
            unit_price: this.num(item.unit_price) || 0,
          })),
          payment_method: this.saleForm.payment_status === 'receivable' ? 'A receber' : this.saleForm.payment_method,
          payment_status: this.saleForm.payment_status || 'received',
          receivable_due_date: this.saleForm.payment_status === 'receivable'
            ? this.saleForm.receivable_due_date || null
            : null,
          // Parcelamento desligado: o negocio nao vende parcelado. Sempre 1.
          receivable_installments: 1,
          fulfillment_mode: this.saleForm.fulfillment_mode,
          delivery_address: this.saleForm.fulfillment_mode === 'delivery'
            ? this.saleForm.delivery_address.trim()
            : null,
          notes: this.posNotes.trim() || null,
          received_amount: receivedAmount,
          discount_amount: this.num(this.posDiscountAmount) || 0,
          freight_amount: this.num(this.posFreightAmount) || 0,
          source_tag: this.saleForm.source_tag || 'porta',
          idempotency_key: stableIdempotencyKey,
        };
        await this.api('vendas', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const paymentMethod = this.saleForm.payment_method;
        const paymentStatus = this.saleForm.payment_status || 'received';
        const fulfillmentMode = this.saleForm.fulfillment_mode;
        const sourceTag = this.saleForm.source_tag || 'porta';
        this.posClearCart();
        this.saleForm = {
          customer_id: null,
          customer_name: '',
          customer_phone: '',
          partner_stock_id: '',
          source_tag: sourceTag,
          quantity: 1,
          unit_price: 0,
          payment_method: paymentMethod,
          payment_status: paymentStatus,
          receivable_due_date: '',
          receivable_installments: 1,
          fulfillment_mode: fulfillmentMode,
          delivery_address: '',
        };
        this.posCustomerQuery = '';
        this.posCustomerResults = [];
        this.posSelectedCustomerAddress = '';
        this.deliveryAddressMissing = false;
        this.posSaleIdempotencyKey = null;
        await this.loadData();
        this.flash('Venda finalizada - estoque e financeiro atualizados.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async saveSale() {
      if (!this.saleForm.partner_stock_id) {
        this.flash('Selecione um item do estoque.');
        return;
      }
      if (this.saleForm.fulfillment_mode === 'delivery' && !this.saleForm.delivery_address.trim()) {
        this.flash('Informe o endereço de entrega ou mude para retirada.');
        return;
      }
      if (this.saleForm.payment_status === 'receivable' && !this.saleForm.receivable_due_date) {
        this.flash('Informe a data para receber esta venda.');
        return;
      }
      this.saving = true;
      this.savingAction = 'sale';
      try {
        const body = {
          customer_id: this.saleForm.customer_id || null,
          customer_name: this.saleForm.customer_name.trim() || null,
          // Telefone vai pro banco em E.164 (+5521...). Estado local guarda sÃ³ dÃ­gitos.
          customer_phone: this.toE164Phone(this.saleForm.customer_phone),
          items: [{
            // Aponta direto pro estoque local do parceiro â€” sem catÃ¡logo da matriz.
            partner_stock_id: this.saleForm.partner_stock_id,
            quantity: this.num(this.saleForm.quantity) || 1,
            unit_price: this.num(this.saleForm.unit_price) || 0,
          }],
          payment_method: this.saleForm.payment_status === 'receivable' ? 'A receber' : this.saleForm.payment_method,
          payment_status: this.saleForm.payment_status || 'received',
          receivable_due_date: this.saleForm.payment_status === 'receivable'
            ? this.saleForm.receivable_due_date || null
            : null,
          // Parcelamento desligado: o negocio nao vende parcelado. Sempre 1.
          receivable_installments: 1,
          fulfillment_mode: this.saleForm.fulfillment_mode,
          delivery_address: this.saleForm.fulfillment_mode === 'delivery'
            ? this.saleForm.delivery_address.trim()
            : null,
          source_tag: this.saleForm.source_tag || 'porta',
          idempotency_key: this.uuid(),
        };
        await this.api('vendas', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        // Preserva preferÃªncias do operador (modalidade + pagamento) entre vendas
        this.saleForm = {
          customer_id: null, customer_name: '', customer_phone: '', partner_stock_id: '',
          source_tag: this.saleForm.source_tag || 'porta',
          quantity: 1, unit_price: 0,
          payment_method: this.saleForm.payment_method,
          payment_status: this.saleForm.payment_status || 'received',
          receivable_due_date: '',
          receivable_installments: 1,
          fulfillment_mode: this.saleForm.fulfillment_mode,
          delivery_address: '',
        };
        await this.loadData();
        this.flash('Venda registrada - estoque baixado automaticamente.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async cancelSale(orderId) {
      if (!confirm('Cancelar esta venda? Sai do resumo, fica no histórico.')) return;
      this.saving = true;
      this.savingAction = 'sale-delete';
      try {
        await this.api(`vendas/${orderId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Venda cancelada.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },
});
