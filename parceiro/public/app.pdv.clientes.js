/**
 * app.pdv.clientes.js - fabrica `pdvClientes` do painel do parceiro (obra <=300, passo 8/11).
 * MORA AQUI: o CLIENTE no contexto de venda - busca com debounce (clientes/buscar),
 * selecao (autofill de endereco na entrega), cadastro inline do PDV, CRUD da tela
 * Clientes (criar/editar/atualizar/excluir), e os getters de cliente: customerSales
 * (SO venda realizada - isPhysicalExitSale, contrato 0077: delivery aberto NAO conta),
 * total gasto, endereco, ultima venda e VIP (>= vipMinPurchases compras realizadas).
 * NAO MORA AQUI: o fluxo de vender (app.pdv.js); leitura do carrinho (app.pdv.kpis.js).
 * VEIO DE: app.js commit d04768b (ranges 1644-1852, 2532-2568), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.pdvClientes = () => ({
    onCustomerSearchInput() {
      this.saleForm.customer_name = this.posCustomerQuery.trim();
      this.saleForm.customer_id = null;
      this.posSelectedCustomerAddress = '';
      clearTimeout(this.posCustomerSearchTimer);
      const q = this.posCustomerQuery.trim();
      if (q.length < 2) {
        this.posCustomerResults = [];
        return;
      }
      this.posCustomerSearchTimer = setTimeout(async () => {
        try {
          const result = await this.api(`clientes/buscar?q=${encodeURIComponent(q)}`, { method: 'GET' });
          this.posCustomerResults = result.rows || [];
        } catch {
          this.posCustomerResults = [];
        }
      }, 250);
    },

    selectPartnerCustomer(customer) {
      if (!customer) return;
      this.saleForm.customer_id = customer.id;
      this.saleForm.customer_name = customer.name || '';
      this.saleForm.customer_phone = customer.phone || '';
      const addressLine = this.customerAddressLine(customer);
      this.posSelectedCustomerAddress = addressLine !== '-' ? addressLine : '';
      // Entrega para cliente com endereco cadastrado: preenche sozinho.
      if (this.saleForm.fulfillment_mode === 'delivery' && !this.saleForm.delivery_address.trim() && this.posSelectedCustomerAddress) {
        this.saleForm.delivery_address = this.posSelectedCustomerAddress;
        this.deliveryAddressMissing = false;
      }
      this.posCustomerQuery = customer.name || '';
      this.posCustomerResults = [];
      this.posCustomerFormOpen = false;
    },

    // Abre o cadastro inline no PDV ja pre-preenchido com o texto buscado.
    openPosCustomerForm() {
      const q = this.posCustomerQuery.trim();
      const looksLikePhone = /\d{3,}/.test(q.replace(/\D/g, ''));
      this.clearCustomerForm();
      if (looksLikePhone) {
        this.customerForm.phone = q;
      } else {
        this.customerForm.name = q;
      }
      this.posCustomerResults = [];
      this.posCustomerFormOpen = true;
    },

    closePosCustomerForm() {
      this.posCustomerFormOpen = false;
      this.clearCustomerForm();
    },

    async createPosCustomer() {
      if (!this.customerForm.name.trim()) {
        this.flash('Informe o nome do cliente.');
        return;
      }
      this.saving = true;
      this.savingAction = 'customer';
      try {
        const streetWithNumber = [this.customerForm.address_street, this.customerForm.address_number]
          .map((item) => String(item || '').trim()).filter(Boolean).join(', ');
        const addressParts = [
          streetWithNumber,
          this.customerForm.address_neighborhood,
          this.customerForm.address_city,
        ].map((item) => String(item || '').trim()).filter(Boolean);
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
        const result = await this.api('clientes', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const customer = {
          id: result.customer_id,
          name: payload.name,
          phone: payload.phone,
          address: payload.address,
          address_street: payload.address_street,
          address_number: payload.address_number,
          address_neighborhood: payload.address_neighborhood,
          address_city: payload.address_city,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };
        if (this.currentSection === 'clientes') {
          this.clientes = [customer, ...this.clientes.filter((item) => item.id !== customer.id)];
        } else {
          this.selectPartnerCustomer(customer);
        }
        this.clearCustomerForm();
        this.flash('Cliente cadastrado.');
        if (this.currentSection === 'clientes') {
          await this.loadData();
        }
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    clearCustomerForm() {
      this.customerForm = { name: '', phone: '', address_street: '', address_number: '', address_neighborhood: '', address_city: '' };
      this.editingCustomerId = null;
    },

    // Clique na linha da tabela: carrega o cliente no formulário para edição.
    editCustomer(customer) {
      if (!customer?.id) return;
      this.editingCustomerId = customer.id;
      this.customerForm = {
        name: customer.name || '',
        phone: customer.phone || '',
        address_street: customer.address_street || '',
        address_number: customer.address_number || '',
        address_neighborhood: customer.address_neighborhood || '',
        address_city: customer.address_city || '',
      };
      this.$nextTick(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    },

    // Botão do formulário de clientes: decide entre criar e atualizar.
    saveCustomer() {
      return this.editingCustomerId ? this.updateCustomer() : this.createPosCustomer();
    },

    customerPayloadFromForm() {
      const streetWithNumber = [this.customerForm.address_street, this.customerForm.address_number]
        .map((item) => String(item || '').trim()).filter(Boolean).join(', ');
      const addressParts = [
        streetWithNumber,
        this.customerForm.address_neighborhood,
        this.customerForm.address_city,
      ].map((item) => String(item || '').trim()).filter(Boolean);
      return {
        name: this.customerForm.name.trim(),
        phone: this.toE164Phone(this.customerForm.phone),
        address: addressParts.join(' - ') || null,
        address_street: this.customerForm.address_street?.trim() || null,
        address_number: this.customerForm.address_number?.trim() || null,
        address_neighborhood: this.customerForm.address_neighborhood?.trim() || null,
        address_city: this.customerForm.address_city?.trim() || null,
      };
    },

    async updateCustomer() {
      if (!this.editingCustomerId) return;
      if (!this.customerForm.name.trim()) {
        this.flash('Informe o nome do cliente.');
        return;
      }
      this.saving = true;
      this.savingAction = 'customer';
      try {
        const payload = this.customerPayloadFromForm();
        await this.api('clientes/' + this.editingCustomerId, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        this.clearCustomerForm();
        this.flash('Cliente atualizado.');
        await this.loadData();
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async deleteCustomer() {
      if (!this.editingCustomerId) return;
      const name = this.customerForm.name.trim() || 'este cliente';
      if (!window.confirm('Excluir ' + name + '? As vendas já registradas serão mantidas.')) return;
      const id = this.editingCustomerId;
      this.saving = true;
      this.savingAction = 'customer';
      try {
        await this.api('clientes/' + id, { method: 'DELETE' });
        this.clientes = this.clientes.filter((item) => item.id !== id);
        this.clearCustomerForm();
        this.flash('Cliente excluído.');
        await this.loadData();
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    // VIP automático: cliente é VIP quando atinge vipMinPurchases compras.
    customerIsVip(customer) {
      return this.customerSales(customer).length >= this.vipMinPurchases;
    },

    customerSales(customer) {
      if (!customer) return [];
      const cpf = this.cpfDigits(customer.cpf || '');
      const phone = String(customer.phone || '').replace(/\D/g, '');
      return (this.vendas || []).filter((sale) => {
        if (!this.isPhysicalExitSale(sale)) return false;
        const saleCpf = this.cpfDigits(sale.customer_cpf || '');
        const salePhone = String(sale.customer_phone || '').replace(/\D/g, '');
        return (customer.id && sale.customer_id === customer.id)
          || (!!cpf && saleCpf === cpf)
          || (!!phone && salePhone === phone);
      });
    },

    customerTotalSpent(customer) {
      return this.customerSales(customer).reduce((sum, sale) => sum + this.num(sale.total_amount), 0);
    },

    customerAddressLine(customer) {
      const streetWithNumber = [customer?.address_street, customer?.address_number]
        .map((item) => String(item || '').trim()).filter(Boolean).join(', ');
      const parts = [
        streetWithNumber,
        customer?.address_neighborhood,
        customer?.address_city,
      ].map((item) => String(item || '').trim()).filter(Boolean);
      return parts.join(' - ') || customer?.address || '-';
    },

    customerLastSaleLabel(customer) {
      const sales = this.customerSales(customer);
      if (!sales.length) return 'sem venda vinculada';
      const latest = sales
        .slice()
        .sort((a, b) => new Date(this.saleRealizedAt(b) || 0).getTime() - new Date(this.saleRealizedAt(a) || 0).getTime())[0];
      return this.formatDate(this.saleRealizedAt(latest));
    },
});
