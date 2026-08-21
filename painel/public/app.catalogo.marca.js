// Correção auditada da identidade medida + marca + condição no estoque da Matriz.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogoMarca = function () {
  const brandKey = (value) => String(value || '').trim().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const measureKey = (value) => String(value || '').replace(/\D/g, '');

  return {
    catalogoIsUnknownBrand(brand) {
      const key = brandKey(brand);
      return !key || key === 'semmarca';
    },
    catalogoBrandCorrectionOpen(row) {
      if (this.adminUser?.role !== 'owner' || !row || row.product_type === 'service') return;
      this.catalogoSelecionado = null;
      this.catalogoCadastro.open = false;
      this.catalogoCompatibilidade.open = false;
      this.catalogoMarcaCorrecao = {
        open: true,
        row,
        from_brand: String(row.brand || 'Sem marca'),
        to_brand: '',
        reason: '',
        confirmed: false,
        idempotency_key: '',
        saving: false,
        message: null,
        result: null,
        result_row: null,
      };
      this.$nextTick(() => {
        document.getElementById('catalog-brand-correction-target')?.focus();
        window.lucide?.createIcons();
      });
    },
    catalogoBrandCorrectionFromStock(row) {
      if (!row) return;
      this.currentPage = 'catalogo';
      this.catalogoBrandCorrectionOpen({
        ...row,
        tire_size: row.measure,
        official_quantity_on_hand: row.quantity_on_hand,
        official_quantity_reserved: row.quantity_reserved || 0,
        total_stock_available: row.quantity_available ?? row.quantity_on_hand,
        official_unit_cost: row.unit_cost,
        row_key: `stock:${measureKey(row.measure)}:${brandKey(row.brand)}:${row.tire_condition}`,
      });
    },
    catalogoBrandCorrectionClose() {
      if (this.catalogoMarcaCorrecao.saving) return;
      this.catalogoMarcaCorrecao = {
        open: false, row: null, from_brand: '', to_brand: '', reason: '', confirmed: false,
        idempotency_key: '', saving: false, message: null, result: null,
        result_row: null,
      };
    },
    catalogoBrandCorrectionCanSave() {
      const form = this.catalogoMarcaCorrecao;
      const target = brandKey(form.to_brand);
      return this.adminUser?.role === 'owner'
        && !form.saving && !form.result && form.confirmed && target && target !== 'semmarca'
        && target !== brandKey(form.from_brand)
        && String(form.reason || '').trim().length >= 2;
    },
    async catalogoBrandCorrectionSave() {
      if (this.adminUser?.role !== 'owner' || !this.catalogoBrandCorrectionCanSave()) return;
      const form = this.catalogoMarcaCorrecao;
      const row = form.row;
      const measure = row?.tire_size || row?.measure;
      const entityKey = row?.row_key
        || `${measure}:${form.from_brand}:${row?.tire_condition}`;
      form.saving = true;
      form.message = null;
      try {
        form.idempotency_key = form.idempotency_key
          || window.PAINEL_INTEGRITY.operation('stock-brand-correction', entityKey).key;
        const result = await this.apiPost('/admin/api/wholesale/stock/brand-correction', {
          measure,
          from_brand: form.from_brand,
          to_brand: String(form.to_brand || '').trim(),
          tire_condition: row?.tire_condition,
          reason: String(form.reason || '').trim(),
          idempotency_key: form.idempotency_key,
        });
        window.PAINEL_INTEGRITY.complete('stock-brand-correction', entityKey);
        await this.loadCatalogo();
        const resultRow = this.catalogoRows.find((item) =>
          measureKey(item.tire_size) === measureKey(result.measure)
          && brandKey(item.brand) === brandKey(result.to_brand)
          && item.tire_condition === result.tire_condition) || null;
        form.result = result;
        form.result_row = resultRow;
        form.message = {
          ok: true,
          text: `${result.measure} agora está como ${result.to_brand}. Saldo, custo e condição foram preservados com auditoria.`,
        };
      } catch (error) {
        const code = String(error.message || '');
        const messages = {
          brand_correction_source_not_found: 'O registro original não existe mais. Atualize o Catálogo e confira novamente.',
          brand_correction_target_exists: 'Já existe estoque dessa medida, marca e condição. A correção foi bloqueada para não misturar saldos ou custos.',
          brand_correction_catalog_conflict: 'Existem produtos comerciais nas duas marcas. A correção foi bloqueada para não juntar produtos diferentes.',
          brand_correction_catalog_ambiguous: 'O Catálogo possui produtos duplicados nessa medida. Corrija a duplicidade antes de trocar a marca.',
          brand_correction_source_ambiguous: 'O Estoque possui variantes duplicadas da marca atual. Corrija a duplicidade antes de continuar.',
          brand_correction_same: 'Escolha uma marca diferente da atual.',
          brand_correction_target_required: 'Informe a marca correta; “Sem marca” não é um destino válido.',
        };
        form.message = {
          ok: false,
          text: messages[code] || `Não foi possível corrigir a marca (${code}).`,
        };
      } finally {
        form.saving = false;
        this.$nextTick(() => window.lucide?.createIcons());
      }
    },
    catalogoBrandCorrectionContinue() {
      const nextRow = this.catalogoMarcaCorrecao.result_row;
      this.catalogoBrandCorrectionClose();
      if (nextRow?.catalogued === false) this.catalogoCreateOpen(nextRow);
    },
  };
};
