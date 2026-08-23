window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogoBootstrap = function () {
  return {
    catalogoCreateOpen(row) {
      if (this.adminUser?.role !== 'owner' || !row || row.catalogued !== false) return;
      const brandCode = String(row.brand || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '')
        .slice(0, 3).toUpperCase() || 'PNE';
      const measureCode = String(row.tire_size || '').replace(/\D/g, '') || 'MEDIDA';
      const conditionCode = row.tire_condition === 'novo' ? 'NOV'
        : row.tire_condition === 'remold' ? 'REM' : 'MV';
      this.catalogoCadastro = {
        open: true,
        mode: 'stock',
        row,
        form: {
          measure: row.tire_size,
          brand: row.brand,
          tire_condition: row.tire_condition,
          product_code: `${brandCode}-${measureCode}-${conditionCode}`,
          product_name: `Pneu ${row.brand}`,
          price_amount: '',
        },
        saving: false,
        message: null,
      };
      this.$nextTick(() => {
        window.lucide && window.lucide.createIcons();
        document.getElementById('catalog-product-code')?.focus();
      });
    },

    catalogoCreateNew() {
      if (this.adminUser?.role !== 'owner') return;
      this.catalogoSelecionado = null;
      this.catalogoCadastro = {
        open: true,
        mode: 'manual',
        row: null,
        form: {
          measure: '', brand: '', tire_condition: 'meia_vida',
          product_code: '', product_name: '', price_amount: '',
        },
        saving: false,
        message: null,
      };
      this.$nextTick(() => {
        window.lucide && window.lucide.createIcons();
        document.getElementById('catalog-product-measure')?.focus();
      });
    },

    catalogoCreateSuggestCode() {
      if (this.catalogoCadastro.mode !== 'manual') return;
      const form = this.catalogoCadastro.form;
      const brandCode = String(form.brand || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '')
        .slice(0, 3).toUpperCase() || 'PNE';
      const measureCode = String(form.measure || '').replace(/\D/g, '') || 'MEDIDA';
      const conditionCode = form.tire_condition === 'novo' ? 'NOV'
        : form.tire_condition === 'remold' ? 'REM' : 'MV';
      form.product_code = `${brandCode}-${measureCode}-${conditionCode}`;
      if (!String(form.product_name || '').trim()) {
        form.product_name = `Pneu ${String(form.brand || '').trim()}`.trim();
      }
    },

    catalogoCreateClose() {
      if (this.catalogoCadastro.saving) return;
      this.catalogoCadastro.open = false;
      this.catalogoCadastro.message = null;
    },

    catalogoCreateCanSave() {
      const form = this.catalogoCadastro.form;
      const manualReady = this.catalogoCadastro.mode !== 'manual'
        || (/^(?:\d{2,3}\s*\/\s*\d{2,3}|\d(?:[.,]\d{1,2}))\s*(?:-|R)\s*\d{2}$/i
          .test(String(form.measure || '').trim())
          && String(form.brand || '').trim().length >= 2
          && ['meia_vida', 'novo', 'remold'].includes(form.tire_condition));
      const price = String(form.price_amount ?? '').trim().replace(',', '.');
      const priceReady = !price || (Number(price) > 0
        && Math.abs(Number(price) * 100 - Math.round(Number(price) * 100)) < 1e-7);
      return this.adminUser?.role === 'owner' && !this.catalogoCadastro.saving
        && manualReady && priceReady
        && /^[A-Z0-9][A-Z0-9._/-]{1,79}$/.test(String(form.product_code || '').trim().toUpperCase())
        && String(form.product_name || '').trim().length >= 2;
    },

    catalogoCreateViewStock() {
      const row = this.catalogoCadastro.row;
      this.catalogoCreateClose();
      this.stockBusca = row?.tire_size || '';
      this.stockTab = 'visao';
      this.currentPage = 'estoque';
    },

    async catalogoCreateSave(goToPurchases = false) {
      if (this.adminUser?.role !== 'owner'
        || !this.catalogoCreateCanSave()) return;
      const row = this.catalogoCadastro.row;
      const form = this.catalogoCadastro.form;
      this.catalogoCadastro.saving = true;
      this.catalogoCadastro.message = null;
      try {
        const payload = this.catalogoCadastro.mode === 'manual' ? {
          measure: String(form.measure).trim(),
          brand: String(form.brand).trim(),
          tire_condition: form.tire_condition,
          product_code: String(form.product_code).trim().toUpperCase(),
          product_name: String(form.product_name).trim(),
          creation_mode: 'manual',
          price_amount: String(form.price_amount ?? '').trim()
            ? Number(String(form.price_amount).replace(',', '.')) : null,
          price_reason: 'Preço inicial do cadastro',
        } : {
          measure: row.tire_size,
          brand: row.brand,
          tire_condition: row.tire_condition,
          product_code: String(form.product_code).trim().toUpperCase(),
          product_name: String(form.product_name).trim(),
        };
        const created = await this.apiPost('/admin/api/catalog/products', payload);
        await this.loadCatalogo();
        const product = this.catalogoRows.find((item) =>
          item.product_id === created.product_id);
        if (!product) throw new Error('catalog_product_reload_failed');
        this.catalogoCadastro.open = false;
        if (goToPurchases) {
          let item = this.compraForm?.items?.find((candidate) => !candidate.measure);
          if (!item && this.compraForm?.items) {
            this.compraAddItem();
            item = this.compraForm.items[this.compraForm.items.length - 1];
          }
          if (item) {
            item.measure = created.tire_size;
            item.brand = created.brand;
            item.tire_condition = created.tire_condition;
          }
          this.currentPage = 'compras';
          this.comprasOpenTab('nova');
          this.compraMsg = { ok: true, text: 'Produto criado. Informe fornecedor, quantidade e custo para registrar a compra.' };
          return;
        }
        await this.catalogoOpen(product);
        this.catalogoMessage = {
          ok: true,
          text: Number(created.price_amount) > 0
            ? 'Produto e preço cadastrados. A venda só será liberada após o recebimento físico no estoque.'
            : 'Produto cadastrado. Agora defina o preço oficial; sem preço e estoque ele não pode ser vendido.',
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        this.catalogoCadastro.message = {
          ok: false,
          text: code.includes('catalog_product_code_duplicate')
            ? 'Esse código já está em uso. Informe outro código.'
            : code.includes('catalog_variant_already_exists')
              ? 'Essa medida e marca já possuem um produto no Catálogo.'
              : code.includes('catalog_stock_variant_ambiguous')
                  ? 'Há mais de um estoque para essa medida e marca. Corrija a duplicidade antes de cadastrar.'
                : code.includes('catalog_stock_variant_not_found')
                  ? 'A variante não existe mais no Estoque. Recarregue o Catálogo.'
                  : code.includes('catalog_measure_invalid')
                    ? 'Medida inválida. Use, por exemplo, 90/90-18 ou 3.00-18.'
                    : code.includes('catalog_price_invalid')
                      ? 'Preço inválido. Use um valor positivo com no máximo dois centavos.'
                  : 'Não foi possível cadastrar o produto. Recarregue e tente novamente.',
        };
      } finally {
        this.catalogoCadastro.saving = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },

  };
};
