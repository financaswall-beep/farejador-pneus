/**
 * app.estoque.forms.js - fabrica `estoqueForms` do painel do parceiro (obra <=300, passo 7/11).
 * MORA AQUI: as ACOES de estoque - form criar/editar (saveStock POST /estoque, payload
 * completo), inativar (deleteStock DELETE soft), vinculo ao catalogo central (searchCatalog),
 * modais, selectStock e a movimentacao de saldo: dar entrada (+delta) e ajustar (absoluto)
 * via _persistStockQuantity, que REMONTA O PAYLOAD COMPLETO (upsert sobrescreve TUDO -
 * payload parcial APAGA colunas; ver SECOES/ESTOQUE.md "Como GRAVAR").
 * NAO MORA AQUI: leitura/KPIs (app.estoque.kpis.js); compras (savePurchase fica pro passo 9).
 * VEIO DE: app.js commit dcd8fa9 (ranges 2274-2418, 2921-3015), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.estoqueForms = () => ({
    // â”€â”€â”€ FORMS: STOCK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    editStock(item) {
      // Prefere colunas dimensionais do banco (migration 0038); cai pro parse da string sÃ³ pra
      // registros legados que ainda nÃ£o foram tocados depois da migration.
      const parsed = this.parseTireSize(item.tire_size);
      this.stockForm = {
        stock_id: item.id,
        item_type: item.item_type || 'pneu',
        item_name: item.item_name || '',
        tire_width: item.tire_width_mm ?? parsed.width,
        tire_aspect: item.tire_aspect_ratio ?? parsed.aspect,
        tire_rim: item.tire_rim_diameter ?? parsed.rim,
        brand: item.brand || '',
        supplier_name: item.supplier_name || '',
        quantity_on_hand: item.quantity_on_hand ?? null,
        minimum_quantity: item.minimum_quantity ?? null,
        average_cost: item.average_cost ?? null,
        sale_price: item.sale_price ?? null,
        tire_condition: item.tire_condition || 'Novo',
        shelf_location: item.shelf_location || '',
        // Posição em coluna própria (migration 0075); fallback à heurística p/ legado.
        tire_position: item.tire_position || this.stockPositionValue(item.supplier_name) || this.stockPositionValue(item.item_name) || '',
        is_tracked: Boolean(item.is_tracked),
        // P1: vínculo ao catálogo (NULL = item livre). catalog_name vem do JOIN em getPartnerEstoque.
        product_id: item.product_id ?? null,
        catalog_name: item.catalog_product_name ?? null,
      };
      this.catalogResults = [];
      this.currentTab = 'stock';
      this.goToSection('estoque');
    },

    clearStockForm() {
      this.stockForm = { stock_id: null, item_type: 'pneu', item_name: '', tire_width: null, tire_aspect: null, tire_rim: null, brand: '', supplier_name: '', quantity_on_hand: null, minimum_quantity: null, average_cost: null, sale_price: null, tire_condition: 'Novo', shelf_location: '', tire_position: '', is_tracked: true, product_id: null, catalog_name: null };
      this.catalogQuery = '';
      this.catalogResults = [];
    },

    // ─── P1: vínculo do estoque ao catálogo central (pro robô achar o item) ─────
    // Busca read-only em commerce.products (endpoint /catalogo/busca). NÃO é a venda
    // (que segue silo); é só o ponteiro product_id que o bot usa pra rotear.
    async searchCatalog() {
      const q = (this.catalogQuery || '').trim();
      if (q.length < 2) { this.catalogResults = []; return; }
      this.catalogSearching = true;
      try {
        const result = await this.api(`catalogo/busca?q=${encodeURIComponent(q)}`, { method: 'GET' });
        this.catalogResults = result.rows || [];
      } catch (err) {
        this.catalogResults = [];
      } finally {
        this.catalogSearching = false;
      }
    },
    selectCatalogProduct(p) {
      this.stockForm.product_id = p.id;
      this.stockForm.catalog_name = p.product_name;
      this.catalogResults = [];
      this.catalogQuery = '';
    },
    clearCatalogLink() {
      this.stockForm.product_id = null;
      this.stockForm.catalog_name = null;
      this.catalogResults = [];
      this.catalogQuery = '';
    },

    async saveStock() {
      if (!this.stockForm.item_name.trim()) { this.flash('Nome do item é obrigatório.'); return; }

      const itemType = this.stockForm.item_type || 'pneu';
      const isService = itemType === 'servico';
      // Serviço não controla estoque; pneu/insumo controlam. O tipo dirige is_tracked.
      const isTracked = !isService;

      // Medida só faz sentido pra pneu. Insumo/serviço ignoram os campos de medida.
      let tireSize = null;
      if (itemType === 'pneu') {
        // Validação da medida: ou está toda preenchida, ou totalmente vazia.
        const tireParts = [this.stockForm.tire_width, this.stockForm.tire_aspect, this.stockForm.tire_rim];
        const filledCount = tireParts.filter((v) => v !== null && v !== '' && Number(v) > 0).length;
        if (filledCount > 0 && filledCount < 3) {
          this.flash('Preencha largura, perfil e aro completos, ou deixe os três vazios.');
          return;
        }
        tireSize = filledCount === 3 ? this.composeTireSize(this.stockForm.tire_width, this.stockForm.tire_aspect, this.stockForm.tire_rim) : null;
      }

      this.saving = true;
      this.savingAction = 'stock';
      try {
        await this.api('estoque', {
          method: 'POST',
          body: JSON.stringify({
            stock_id: this.stockForm.stock_id || null,
            item_type: itemType,
            item_name: this.stockForm.item_name.trim(),
            tire_size: tireSize,
            // Dimensões separadas (migration 0038) — banco indexa pra busca rápida
            tire_width_mm: tireSize ? this.num(this.stockForm.tire_width) : null,
            tire_aspect_ratio: tireSize ? this.num(this.stockForm.tire_aspect) : null,
            tire_rim_diameter: tireSize ? this.num(this.stockForm.tire_rim) : null,
            brand: isService ? null : (this.stockForm.brand?.trim() || null),
            // supplier_name volta a ser só fornecedor/origem — passa direto, sem posição (migration 0075).
            supplier_name: this.stockForm.supplier_name?.trim() || null,
            // Posição do pneu em coluna própria.
            tire_position: itemType === 'pneu' ? (this.stockPositionValue(this.stockForm.tire_position) || null) : null,
            quantity_on_hand: isTracked ? this.num(this.stockForm.quantity_on_hand) : null,
            minimum_quantity: isTracked && this.stockForm.minimum_quantity !== null && this.stockForm.minimum_quantity !== '' ? this.num(this.stockForm.minimum_quantity) : null,
            average_cost: this.stockForm.average_cost !== null && this.stockForm.average_cost !== '' ? this.num(this.stockForm.average_cost) : null,
            sale_price: this.stockForm.sale_price !== null && this.stockForm.sale_price !== '' ? this.num(this.stockForm.sale_price) : null,
            tire_condition: itemType === 'pneu' ? (this.stockForm.tire_condition?.trim() || null) : null,
            shelf_location: isService ? null : (this.stockForm.shelf_location?.trim() || null),
            is_tracked: isTracked,
            // P1: ponteiro pro catálogo central (o robô casa por aqui). Serviço nunca vincula.
            product_id: isService ? null : (this.stockForm.product_id || null),
          }),
        });
        this.clearStockForm();
        this.stockModalOpen = false;
        await this.loadData();
        this.flash('Estoque salvo.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async deleteStock(stockId) {
      if (!confirm('Inativar este item? Sai da lista da unidade.')) return;
      this.saving = true;
      this.savingAction = 'stock-delete';
      try {
        await this.api(`estoque/${stockId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Item inativado.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    selectStock(item) {
      this.stockSelected = item.id;
    },

    openStockModal(item) {
      if (item) {
        this.editStock(item);
      } else {
        this.clearStockForm();
      }
      this.stockModalOpen = true;
    },

    closeStockModal() {
      this.stockModalOpen = false;
    },

    // ─── Movimentação de saldo (botões "Dar entrada" / "Ajustar saldo") ───────
    // Reusa POST /estoque (upsert). Como o upsert sobrescreve todas as colunas,
    // remontamos o payload COMPLETO do item e só trocamos quantity_on_hand.
    async _persistStockQuantity(item, newQty) {
      await this.api('estoque', {
        method: 'POST',
        body: JSON.stringify({
          stock_id: item.id,
          item_type: item.item_type || 'pneu',
          item_name: item.item_name,
          tire_size: item.tire_size ?? null,
          tire_width_mm: item.tire_width_mm ?? null,
          tire_aspect_ratio: item.tire_aspect_ratio ?? null,
          tire_rim_diameter: item.tire_rim_diameter ?? null,
          brand: item.brand ?? null,
          supplier_name: item.supplier_name ?? null,
          quantity_on_hand: newQty,
          minimum_quantity: item.minimum_quantity ?? null,
          average_cost: item.average_cost != null ? this.num(item.average_cost) : null,
          sale_price: item.sale_price != null ? this.num(item.sale_price) : null,
          tire_condition: item.tire_condition ?? null,
          shelf_location: item.shelf_location ?? null,
          tire_position: item.tire_position ?? null,
          is_tracked: Boolean(item.is_tracked),
          // P1: preserva o vínculo ao catálogo (o upsert sobrescreve tudo; omitir = apagar o link).
          product_id: item.product_id ?? null,
        }),
      });
      await this.loadData();
    },

    openStockEntry(item) {
      if (!item || !item.is_tracked) return;
      this.stockOpItem = item;
      this.stockEntryQty = null;
      this.stockEntryOpen = true;
    },
    closeStockEntry() { this.stockEntryOpen = false; this.stockOpItem = null; },

    async saveStockEntry() {
      const item = this.stockOpItem;
      const delta = this.num(this.stockEntryQty);
      if (!item) return;
      if (delta <= 0) { this.flash('Informe quantas unidades entraram (maior que zero).'); return; }
      this.saving = true; this.savingAction = 'stock-entry';
      try {
        const newQty = this.num(item.quantity_on_hand) + delta;
        await this._persistStockQuantity(item, newQty);
        this.closeStockEntry();
        this.flash(`Entrada de ${delta} un. registrada.`);
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally { this.saving = false; this.savingAction = ''; }
    },

    openStockAdjust(item) {
      if (!item || !item.is_tracked) return;
      this.stockOpItem = item;
      this.stockAdjustQty = this.num(item.quantity_on_hand);
      this.stockAdjustOpen = true;
    },
    closeStockAdjust() { this.stockAdjustOpen = false; this.stockOpItem = null; },

    async saveStockAdjust() {
      const item = this.stockOpItem;
      if (!item) return;
      if (this.stockAdjustQty === null || this.stockAdjustQty === '' || this.num(this.stockAdjustQty) < 0) {
        this.flash('Informe o novo saldo (zero ou mais).'); return;
      }
      this.saving = true; this.savingAction = 'stock-adjust';
      try {
        await this._persistStockQuantity(item, this.num(this.stockAdjustQty));
        this.closeStockAdjust();
        this.flash('Saldo ajustado.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally { this.saving = false; this.savingAction = ''; }
    },
});
