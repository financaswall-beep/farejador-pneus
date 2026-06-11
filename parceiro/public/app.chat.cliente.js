/**
 * app.chat.cliente.js - fabrica `chatCliente` do painel do parceiro (obra <=300, passo 5/11).
 * MORA AQUI: o lado CLIENTE da conversa (Fase 2a) - cliente vinculado + metricas,
 * link do Maps, cadastro inline, busca/vinculo de cliente existente - e o carrinho
 * proprio do chat (Fase 2b): itens, orcamento no rascunho e converter em pedido
 * (POST /vendas com idempotency_key).
 * NAO MORA AQUI: o nucleo do Bate-papo (app.chat.js) nem o ESTADO chat* (raiz).
 * VEIO DE: app.js commit 29b2ec6, linhas 1989-2221 VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.chatCliente = () => ({
    chatMapUrl() {
      const cust = this.chatCustomer && this.chatCustomer.linked ? this.chatCustomer.customer : null;
      const parts = cust
        ? [cust.address_street, cust.address_number, cust.address_neighborhood, cust.address_city]
        : [this.chatActive?.name, this.chatActive?.city];
      const q = encodeURIComponent(parts.filter(Boolean).join(' '));
      return q ? `https://www.google.com/maps/search/?api=1&query=${q}` : '#';
    },
    // Fase 2a: puxa o cliente vinculado + métricas ao abrir a conversa.
    async loadChatCustomer(id) {
      this.chatCustomer = null;
      try {
        const data = await this.api(`chat/conversations/${id}/customer`);
        if (this.chatActiveId === id) {
          this.chatCustomer = data;
          // Prefilla o endereço do pedido com o do cliente vinculado (Fase 2b).
          const a = this.chatCustomerAddr();
          if (a && !this.chatOrderAddress.trim()) {
            this.chatOrderAddress = [a.street, a.neighborhood, a.city].filter(Boolean).join(', ');
          }
        }
      } catch (err) {
        console.warn('chat_customer_failed', err);
      }
      this.$nextTick(() => lucide.createIcons());
    },
    chatDateLabel(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR');
    },
    chatLastItemLabel(order) {
      const it = (order && Array.isArray(order.items) && order.items[0]) || null;
      if (!it) return 'Pedido';
      const top = [it.brand, it.tire_size].filter(Boolean).join(' ');
      return top || it.item_name || 'Pedido';
    },
    chatCustomerAddr() {
      const c = this.chatCustomer && this.chatCustomer.linked ? this.chatCustomer.customer : null;
      if (!c) return null;
      const street = [c.address_street, c.address_number].filter(Boolean).join(', ');
      const hasParts = street || c.address_neighborhood || c.address_city;
      if (hasParts) return { street, neighborhood: c.address_neighborhood || '—', city: c.address_city || '—' };
      if (c.address) return { street: c.address, neighborhood: '', city: '' };
      return null;
    },
    // CTA "Cadastrar cliente": abre o mini-form INLINE na própria tela do chat
    // (não vai mais pra aba Clientes), pré-preenchido com nome/telefone do contato.
    openChatCustomerForm() {
      const s = (this.chatCustomer && this.chatCustomer.suggestion) || {};
      this.clearCustomerForm();
      this.customerForm.name = s.name || this.chatActive?.name || '';
      // telefone em dígitos nacionais (sem +55) pra máscara exibir certo;
      // toE164Phone recoloca o +55 no submit e casa com normalizeBrazilianPhone do backend.
      let phoneDigits = String(s.phone || this.chatActive?.phone || '').replace(/\D/g, '');
      if (phoneDigits.startsWith('55') && phoneDigits.length >= 12) phoneDigits = phoneDigits.slice(2);
      this.customerForm.phone = phoneDigits;
      this.chatCustomerFormOpen = true;
      this.$nextTick(() => lucide.createIcons());
    },
    closeChatCustomerForm() {
      this.chatCustomerFormOpen = false;
      this.clearCustomerForm();
      this.$nextTick(() => lucide.createIcons());
    },
    // Busca cliente JÁ cadastrado (mesma busca do PDV) pra vincular à conversa.
    onChatCustomerSearch() {
      clearTimeout(this.chatCustomerSearchTimer);
      const q = this.chatCustomerSearch.trim();
      if (q.length < 2) { this.chatCustomerSearchResults = []; return; }
      this.chatCustomerSearchTimer = setTimeout(async () => {
        try {
          const result = await this.api(`clientes/buscar?q=${encodeURIComponent(q)}`, { method: 'GET' });
          this.chatCustomerSearchResults = result.rows || [];
        } catch { this.chatCustomerSearchResults = []; }
        this.$nextTick(() => lucide.createIcons());
      }, 250);
    },
    // Vincula um cliente existente à conversa (grava customer_id) e recarrega
    // o painel com as métricas reais. Funciona em qualquer canal.
    async linkExistingChatCustomer(customer) {
      if (!customer || !this.chatActiveId) return;
      if (this.saving) return;
      this.saving = true; this.savingAction = 'chatlink';
      try {
        await this.api(`chat/conversations/${this.chatActiveId}/link-customer`, {
          method: 'POST', body: JSON.stringify({ customer_id: customer.id }),
        });
        this.chatCustomerSearch = ''; this.chatCustomerSearchResults = [];
        await this.loadChatCustomer(this.chatActiveId); // traz métricas reais (já respeita cancelados)
        this.flash('Cliente vinculado à conversa.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
        this.$nextTick(() => lucide.createIcons());
      }
    },
    // Cria o cliente e JÁ VINCULA à conversa usando o cliente recém-criado
    // (não reconsulta por telefone — assim funciona pra IG/FB, cuja conversa
    // não tem telefone no identificador). Vira "Cadastrado" sem sair do chat.
    async createChatCustomer() {
      if (!this.customerForm.name.trim()) { this.flash('Informe o nome do cliente.'); return; }
      if (this.saving) return;
      this.saving = true; this.savingAction = 'chatcustomer';
      try {
        const streetWithNumber = [this.customerForm.address_street, this.customerForm.address_number]
          .map((item) => String(item || '').trim()).filter(Boolean).join(', ');
        const addressParts = [streetWithNumber, this.customerForm.address_neighborhood, this.customerForm.address_city]
          .map((item) => String(item || '').trim()).filter(Boolean);
        const payload = {
          name: this.customerForm.name.trim(),
          phone: this.toE164Phone(this.customerForm.phone),
          address: addressParts.join(' - ') || null,
          address_street: this.customerForm.address_street?.trim() || null,
          address_number: this.customerForm.address_number?.trim() || null,
          address_neighborhood: this.customerForm.address_neighborhood?.trim() || null,
          address_city: this.customerForm.address_city?.trim() || null,
          idempotency_key: this.uuid(),
        };
        const result = await this.api('clientes', { method: 'POST', body: JSON.stringify(payload) });
        this.chatCustomerFormOpen = false;
        // Grava o vínculo DURÁVEL na conversa (sobrevive reload/troca, qualquer canal).
        if (this.chatActiveId) {
          try {
            await this.api(`chat/conversations/${this.chatActiveId}/link-customer`, {
              method: 'POST', body: JSON.stringify({ customer_id: result.customer_id }),
            });
          } catch (e) { console.warn('link_customer_failed', e); }
        }
        // Vincula DIRETO com o cliente recém-criado (id veio na resposta) —
        // não depende de telefone na conversa, então casa em qualquer canal.
        const customer = {
          id: result.customer_id,
          name: payload.name,
          phone: payload.phone,
          address: payload.address,
          address_street: payload.address_street,
          address_number: payload.address_number,
          address_neighborhood: payload.address_neighborhood,
          address_city: payload.address_city,
        };
        this.chatCustomer = {
          linked: true,
          customer,
          metrics: { purchase_count: 0, total_spent: 0, avg_ticket: 0 },
          last_orders: [],
        };
        // Prefilla o endereço do pedido em aberto, se ainda vazio.
        const a = this.chatCustomerAddr();
        if (a && !this.chatOrderAddress.trim()) {
          this.chatOrderAddress = [a.street, a.neighborhood, a.city].filter(Boolean).join(', ');
        }
        this.clearCustomerForm();
        this.flash('Cliente cadastrado e vinculado à conversa.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
        this.$nextTick(() => lucide.createIcons());
      }
    },

    // ─── Fase 2b: Criar pedido pelo chat (carrinho próprio + endpoint /vendas) ───
    get chatOrderTotal() {
      return this.chatOrderCart.reduce((s, it) => s + this.num(it.quantity) * this.num(it.unit_price), 0);
    },
    chatOrderOnProduct() {
      const p = this.produtos.find((x) => x.stock_id === this.chatOrderProduct);
      if (p && p.sale_price !== null && p.sale_price !== undefined) this.chatOrderPrice = Number(p.sale_price);
    },
    chatOrderAdd() {
      const p = this.produtos.find((x) => x.stock_id === this.chatOrderProduct);
      if (!p) { this.flash('Escolha um pneu do estoque.'); return; }
      const qty = this.num(this.chatOrderQty) || 1;
      const price = this.num(this.chatOrderPrice) || 0;
      const ex = this.chatOrderCart.find((it) => it.partner_stock_id === p.stock_id);
      if (ex) ex.quantity = this.num(ex.quantity) + qty;
      else this.chatOrderCart.push({ partner_stock_id: p.stock_id, item_name: p.item_name, tire_size: p.tire_size, brand: p.brand, quantity: qty, unit_price: price });
      this.chatOrderProduct = ''; this.chatOrderQty = 1; this.chatOrderPrice = 0;
      this.$nextTick(() => lucide.createIcons());
    },
    chatOrderRemove(id) {
      this.chatOrderCart = this.chatOrderCart.filter((it) => it.partner_stock_id !== id);
      this.$nextTick(() => lucide.createIcons());
    },
    chatResetOrder() {
      this.chatOrderCart = []; this.chatOrderProduct = ''; this.chatOrderQty = 1; this.chatOrderPrice = 0; this.chatOrderAddress = '';
    },
    // "Gerar orçamento": monta o texto no campo de mensagem (operador revisa e envia).
    chatGerarOrcamento() {
      if (!this.chatOrderCart.length) { this.flash('Adicione itens ao pedido primeiro.'); return; }
      const lines = this.chatOrderCart.map((it) =>
        `• ${this.num(it.quantity)}x ${[it.brand, it.tire_size, it.item_name].filter(Boolean).join(' ')} — ${this.money(this.num(it.quantity) * this.num(it.unit_price))}`);
      this.chatDraft = `Orçamento:\n${lines.join('\n')}\n\nTotal: ${this.money(this.chatOrderTotal)}`;
      this.flash('Orçamento montado no campo de mensagem — revise e envie.');
    },
    // "Converter em pedido": cria pedido em aberto p/ entrega (a receber), igual ao fluxo de Entrega.
    async chatConverterPedido() {
      if (!this.chatOrderCart.length) { this.flash('Adicione itens ao pedido primeiro.'); return; }
      if (!this.chatOrderAddress.trim()) { this.flash('Informe o endereço de entrega.'); return; }
      if (this.saving) return;
      this.saving = true; this.savingAction = 'chatorder';
      try {
        const c = this.chatActive;
        const linked = (this.chatCustomer && this.chatCustomer.linked) ? this.chatCustomer.customer : null;
        const body = {
          customer_id: linked ? linked.id : null,
          customer_name: (c && c.name) || null,
          customer_phone: this.toE164Phone((linked && linked.phone) || (c && c.phone) || ''),
          items: this.chatOrderCart.map((it) => ({
            partner_stock_id: it.partner_stock_id,
            quantity: this.num(it.quantity) || 1,
            unit_price: this.num(it.unit_price) || 0,
          })),
          payment_method: 'A receber',
          payment_status: 'receivable',
          receivable_due_date: null,
          fulfillment_mode: 'delivery',
          delivery_address: this.chatOrderAddress.trim(),
          source_tag: 'outro',
          idempotency_key: 'chat-' + (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2))),
        };
        await this.api('vendas', { method: 'POST', body: JSON.stringify(body) });
        this.chatResetOrder();
        await this.loadData();
        this.flash('Pedido gerado — estoque reservado. Entra no caixa quando o entregador finalizar.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },
});
