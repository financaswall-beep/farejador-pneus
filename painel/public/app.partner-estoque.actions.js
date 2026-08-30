// Ações simples do estoque do parceiro. O dono informa o estado real da loja;
// o servidor preserva reservas, isolamento por unidade e histórico automático.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerEstoqueActions = function () {
  const emptyNew = () => ({
    open: false, tire_size: '', brand: '', tire_condition: 'novo',
    quantity_on_hand: 0, minimum_quantity: '', sale_price: '', saving: false, error: '',
  });
  const emptyBalance = () => ({ open: false, row: null, quantity_on_hand: 0, saving: false, error: '' });
  const emptyPrice = () => ({ open: false, row: null, sale_price: '', saving: false, error: '' });
  return {
    partnerEstoqueNew: emptyNew(),
    partnerEstoqueBalance: emptyBalance(),
    partnerEstoquePrice: emptyPrice(),

    partnerEstoqueCanManage() {
      return this.isPartnerPanel?.() === true && this.hasPanelModule?.('estoque') === true;
    },

    // Compatibilidade com o HTML já publicado: a ação depende da permissão do
    // módulo, não do nome técnico do papel recebido no login.
    partnerEstoqueOwner() {
      return this.partnerEstoqueCanManage();
    },

    partnerEstoquePriceLabel(row) {
      const value = row?.sale_price;
      return value == null ? 'Definir preço' : this.formatCurrency(Number(value));
    },

    partnerEstoqueActionRows() {
      return this.partnerEstoque.rows.filter((row) => row.item_type !== 'servico');
    },

    partnerEstoqueOpenNew() {
      if (!this.partnerEstoqueCanManage()) return;
      this.partnerEstoqueNew = { ...emptyNew(), open: true };
      this.$nextTick(() => lucide.createIcons());
    },

    partnerEstoqueCloseNew() {
      if (!this.partnerEstoqueNew.saving) this.partnerEstoqueNew.open = false;
    },

    async partnerEstoqueSubmitNew() {
      const form = this.partnerEstoqueNew;
      form.error = '';
      const minimum = form.minimum_quantity === '' ? null : Number(form.minimum_quantity);
      if (!form.tire_size || !form.brand || Number(form.sale_price) <= 0
        || Number(form.quantity_on_hand) < 0 || (minimum !== null && minimum < 0)) {
        form.error = 'Preencha medida, marca, quantidade e preço.';
        return;
      }
      form.saving = true;
      try {
        await this.partnerApiWrite('operacao/estoque/itens', 'POST', {
          tire_size: String(form.tire_size).trim(),
          brand: String(form.brand).trim(),
          tire_condition: form.tire_condition,
          quantity_on_hand: Number(form.quantity_on_hand),
          minimum_quantity: minimum,
          sale_price: Number(form.sale_price),
        });
        form.open = false;
        this.partnerEstoque.notice = 'Pneu cadastrado no estoque.';
        await this.loadPartnerEstoque();
      } catch (error) {
        form.error = error?.code === 'stock_item_already_exists'
          ? 'Este pneu já está cadastrado. Abra-o e corrija o saldo.'
          : error?.code === 'invalid_tire_size'
            ? 'Use a medida no formato 110/70-17.'
            : 'Não foi possível cadastrar o pneu.';
      } finally {
        form.saving = false;
      }
    },

    partnerEstoqueOpenBalance(row = null) {
      if (!this.partnerEstoqueCanManage()) return;
      const selected = row || this.partnerEstoque.selected || this.partnerEstoqueActionRows()[0];
      if (!selected) {
        this.partnerEstoque.notice = 'Cadastre um pneu antes de corrigir o saldo.';
        return;
      }
      this.partnerEstoqueBalance = {
        ...emptyBalance(), open: true, row: selected,
        quantity_on_hand: Number(selected.quantity_on_hand || 0),
      };
      this.$nextTick(() => lucide.createIcons());
    },

    partnerEstoqueCloseBalance() {
      if (!this.partnerEstoqueBalance.saving) this.partnerEstoqueBalance.open = false;
    },

    async partnerEstoqueSubmitBalance() {
      const form = this.partnerEstoqueBalance;
      const quantity = Number(form.quantity_on_hand);
      form.error = '';
      if (!form.row || !Number.isInteger(quantity) || quantity < 0) {
        form.error = 'Informe uma quantidade inteira igual ou maior que zero.';
        return;
      }
      form.saving = true;
      try {
        await this.partnerApiWrite(
          `operacao/estoque/${encodeURIComponent(form.row.stock_id)}/saldo`,
          'POST', { quantity_on_hand: quantity },
        );
        form.open = false;
        this.partnerEstoqueClose();
        this.partnerEstoque.notice = 'Saldo corrigido com sucesso.';
        await this.loadPartnerEstoque();
      } catch (error) {
        form.error = error?.code === 'stock_balance_below_reserved'
          ? `O saldo não pode ser menor que ${Number(form.row.quantity_reserved || 0)} reservado(s).`
          : 'Não foi possível corrigir o saldo.';
      } finally {
        form.saving = false;
      }
    },

    partnerEstoqueOpenPrice(row = null) {
      if (!this.partnerEstoqueCanManage()) return;
      const selected = row || this.partnerEstoque.selected || this.partnerEstoqueActionRows()[0];
      if (!selected) {
        this.partnerEstoque.notice = 'Cadastre um pneu antes de alterar o preço.';
        return;
      }
      this.partnerEstoquePrice = {
        ...emptyPrice(), open: true, row: selected,
        sale_price: selected.sale_price == null ? '' : Number(selected.sale_price),
      };
      this.$nextTick(() => lucide.createIcons());
    },

    partnerEstoqueClosePrice() {
      if (!this.partnerEstoquePrice.saving) this.partnerEstoquePrice.open = false;
    },

    async partnerEstoqueSubmitPrice() {
      const form = this.partnerEstoquePrice;
      const price = Number(form.sale_price);
      form.error = '';
      if (!form.row || !Number.isFinite(price) || price <= 0) {
        form.error = 'Informe um preço maior que zero.';
        return;
      }
      form.saving = true;
      try {
        await this.partnerApiWrite(
          `operacao/estoque/${encodeURIComponent(form.row.stock_id)}/preco`,
          'POST', { sale_price: price, reason: 'Alterado na tela simples de estoque' },
        );
        form.open = false;
        this.partnerEstoqueClose();
        this.partnerEstoque.notice = 'Preço alterado com sucesso.';
        await this.loadPartnerEstoque();
      } catch (_) {
        form.error = 'Não foi possível alterar o preço.';
      } finally {
        form.saving = false;
      }
    },
  };
};
