window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.galpaoMultibrand = function () {
  const clean = (value) => String(value || '').trim();
  const brandKey = (value) => clean(value).normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const variantKey = (measure, brand, condition) =>
    `${clean(measure)}\u0000${brandKey(brand)}\u0000${clean(condition)}`;

  return {
    stockVariantKey(rowOrMeasure, brand, condition) {
      return typeof rowOrMeasure === 'object' && rowOrMeasure
        ? variantKey(rowOrMeasure.measure, rowOrMeasure.brand, rowOrMeasure.tire_condition)
        : variantKey(rowOrMeasure, brand, condition);
    },
    stockVariant(measure, brand, condition) {
      const wantedMeasure = clean(measure);
      const wantedBrand = brandKey(brand);
      const wantedCondition = clean(condition);
      if (!wantedMeasure || !wantedBrand || !wantedCondition) return null;
      return this.atacadoMeasures.find((row) =>
        clean(row.measure) === wantedMeasure && brandKey(row.brand) === wantedBrand
        && clean(row.tire_condition) === wantedCondition) || null;
    },
    measureOnHand(measure, brand, condition) {
      const row = this.stockVariant(measure, brand, condition);
      return row?.quantity_on_hand == null ? null : Number(row.quantity_on_hand);
    },
    measureCost(measure, brand, condition) {
      const row = this.stockVariant(measure, brand, condition);
      return row?.unit_cost == null ? null : Number(row.unit_cost);
    },
    itemProfit(item) {
      const cost = this.measureCost(item.measure, item.brand, item.tire_condition);
      return cost == null ? null
        : (Number(item.unit_price || 0) - cost) * (Number(item.quantity) || 0);
    },
    measureFind(query, key) {
      const raw = clean(query).toLowerCase();
      const digits = (value) => String(value || '').replace(/\D/g, '');
      const queryDigits = digits(raw);
      const isSale = String(key || '').startsWith('v');
      let candidates = this.atacadoMeasures.filter((row) => {
        if (!raw) return !isSale || Number(row.quantity_on_hand) > 0;
        const measure = String(row.measure || '').toLowerCase();
        return measure.includes(raw)
          || (queryDigits !== '' && digits(measure).includes(queryDigits));
      });
      if (!isSale) {
        const measures = new Map();
        for (const row of candidates) {
          const measure = clean(row.measure);
          if (measure && !measures.has(measure)) {
            measures.set(measure, {
              measure,
              brand: null,
              quantity_on_hand: null,
              unit_cost: null,
              variant_key: `${measure}\u0000measure`,
            });
          }
        }
        candidates = [...measures.values()];
      } else {
        candidates = candidates.map((row) => ({
          ...row,
          variant_key: variantKey(row.measure, row.brand, row.tire_condition),
        }));
      }
      if (!raw && key === 'estoque') candidates = [];
      this.measureBox = { key, hits: candidates.slice(0, 12) };
    },
    measurePick(row, item) {
      item.measure = clean(row?.measure);
      if (Object.prototype.hasOwnProperty.call(item, 'brand') && row?.brand) {
        item.brand = clean(row.brand);
      }
      if (Object.prototype.hasOwnProperty.call(item, 'tire_condition') && row?.tire_condition) {
        item.tire_condition = clean(row.tire_condition);
      }
      this.measureBox = { key: null, hits: [] };
    },
    filmeMatches(row) {
      return Boolean(row)
        && clean(this.galpaoFilme.measure) === clean(row.measure)
        && brandKey(this.galpaoFilme.brand) === brandKey(row.brand)
        && clean(this.galpaoFilme.tire_condition) === clean(row.tire_condition);
    },

    repoKey(row) {
      return variantKey(row?.measure, row?.brand, row?.tire_condition);
    },
    repoGiro(row) {
      const sources = new Set(['venda_atacado', 'varejo']);
      const key = this.repoKey(row);
      return (this.galpaoFilme.rows || []).reduce((total, movement) => {
        if (this.repoKey(movement) !== key || !sources.has(movement.source)) return total;
        const delta = Number(movement.qty_delta || 0);
        return delta < 0 ? total + Math.abs(delta) : total;
      }, 0);
    },
    repoSugestao(row) {
      const balance = Math.max(0, Number(row.quantity_on_hand) || 0);
      const minimum = row.min_quantity == null ? 0 : Math.max(0, Number(row.min_quantity) || 0);
      return Math.max(1, minimum - balance);
    },
    repoQuantidade(row) {
      const defined = Number(this.repoQuantidades[this.repoKey(row)]);
      return Number.isInteger(defined) && defined > 0 ? defined : this.repoSugestao(row);
    },
    repoDefinirQuantidade(row, quantity) {
      const next = Math.max(1, Math.round(Number(quantity) || 1));
      this.repoQuantidades = { ...this.repoQuantidades, [this.repoKey(row)]: next };
    },
    repoRows() {
      return [...this.atacadoStock]
        .filter((row) => Number(row.quantity_on_hand) === 0 || this.stockPrecisaRepor(row))
        .sort((a, b) => {
          const priorityA = Number(a.quantity_on_hand) === 0 ? 0 : 1;
          const priorityB = Number(b.quantity_on_hand) === 0 ? 0 : 1;
          return priorityA - priorityB || this.repoGiro(b) - this.repoGiro(a)
            || this.repoKey(a).localeCompare(this.repoKey(b));
        });
    },
    repoRowsView() {
      const search = clean(this.repoBusca).toLowerCase();
      const digits = (value) => String(value || '').replace(/\D/g, '');
      const searchDigits = digits(search);
      let rows = this.repoRows();
      if (search) {
        rows = rows.filter((row) => row.measure.toLowerCase().includes(search)
          || String(row.brand || '').toLowerCase().includes(search)
          || (searchDigits && digits(row.measure).includes(searchDigits)));
      }
      if (this.repoFiltro === 'zeradas') {
        rows = rows.filter((row) => Number(row.quantity_on_hand) === 0);
      } else if (this.repoFiltro === 'abaixo') {
        rows = rows.filter((row) =>
          Number(row.quantity_on_hand) > 0 && this.stockPrecisaRepor(row));
      } else if (this.repoFiltro === 'giro') {
        rows = [...rows].sort((a, b) => this.repoGiro(b) - this.repoGiro(a)
          || this.repoKey(a).localeCompare(this.repoKey(b)));
      }
      return rows;
    },
    repoCobertura(row) {
      const sales = this.repoGiro(row);
      if (sales <= 0) return null;
      const projected = Math.max(0, Number(row.quantity_on_hand) || 0) + this.repoQuantidade(row);
      return Math.max(1, Math.round(projected / (sales / 30)));
    },
    repoPlano() {
      return this.repoRows().map((row) => ({
        ...row,
        suggested_quantity: this.repoQuantidade(row),
      }));
    },
    repoPlanoResumo() {
      const rows = this.repoPlano();
      return {
        medidas: new Set(rows.map((row) => row.measure)).size,
        variantes: rows.length,
        pneus: rows.reduce((total, row) => total + Number(row.suggested_quantity || 0), 0),
        investimento: rows.reduce((total, row) =>
          total + Number(row.suggested_quantity || 0) * Number(row.unit_cost || 0), 0),
      };
    },
    repoInsights() {
      const rows = this.repoRows();
      return {
        zeradas: rows.filter((row) => Number(row.quantity_on_hand) === 0).length,
        abaixo: rows.filter((row) => Number(row.quantity_on_hand) > 0).length,
        giro: rows.filter((row) => this.repoGiro(row) > 0).length,
      };
    },
    repoFornecedor() {
      const variants = new Set(this.repoRows().map((row) => this.repoKey(row)));
      return this.fornecedorBreakdown
        .filter((row) => variants.has(this.repoKey(row)) && Number(row.avg_cost) > 0)
        .sort((a, b) => Number(a.avg_cost) - Number(b.avg_cost))[0] || null;
    },
    repoAbrirCompra(rows) {
      const items = (rows || [])
        .filter((row) => row?.measure && row?.brand
          && Number(row.suggested_quantity || this.repoQuantidade(row)) > 0)
        .map((row) => ({
          measure: row.measure,
          brand: row.brand,
          tire_condition: row.tire_condition,
          quantity: Number(row.suggested_quantity || this.repoQuantidade(row)),
          unit_cost: '',
        }));
      if (!items.length) {
        this.stockMsg = { ok: false, text: 'Não há variantes selecionadas para criar a compra.' };
        return;
      }
      this.compraForm = {
        supplierKey: '', newName: '', newPhone: '', newDocument: '',
        notes: 'Reposição planejada pelo estoque oficial. Confirmar fornecedor, cotação e recebimento.',
        payment_status: 'paid', due_date: '', receipt_status: 'pending', idempotency_key: '',
        items,
      };
      this.compraMsg = {
        ok: true,
        text: 'Plano de reposição enviado para a nova compra. Confirme fornecedor, custos e recebimento.',
      };
      this.currentPage = 'compras';
      this.comprasOpenTab('nova');
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },

    custoCapital(row) {
      if (row?.capital != null) return Math.max(0, Number(row.capital) || 0);
      return Math.max(0, Number(row?.quantity_on_hand) || 0)
        * Math.max(0, Number(row?.unit_cost) || 0);
    },
    custoValido(row) {
      return row?.unit_cost != null && Number(row.unit_cost) > 0;
    },
    custoRowsBase() {
      const groups = new Map();
      for (const variant of this.atacadoStock) {
        const measure = clean(variant.measure);
        const condition = clean(variant.tire_condition);
        const groupKey = `${measure}\u0000${condition}`;
        const group = groups.get(groupKey) || {
          measure, tire_condition: condition, brands: [], variants: [], quantity_on_hand: 0,
          quantity_with_cost: 0, capital: 0, unit_cost: null, cost_complete: false,
        };
        const quantity = Math.max(0, Number(variant.quantity_on_hand) || 0);
        const validCost = this.custoValido(variant);
        group.variants.push(variant);
        if (variant.brand && !group.brands.includes(variant.brand)) group.brands.push(variant.brand);
        group.quantity_on_hand += quantity;
        if (validCost) {
          group.quantity_with_cost += quantity;
          group.capital += quantity * Number(variant.unit_cost);
        }
        groups.set(groupKey, group);
      }
      return [...groups.values()].map((group) => ({
        ...group,
        brands: group.brands.sort((a, b) => a.localeCompare(b, 'pt-BR')),
        unit_cost: group.quantity_with_cost > 0
          ? group.capital / group.quantity_with_cost : null,
        cost_complete: group.quantity_with_cost === group.quantity_on_hand,
      })).sort((a, b) => this.custoCapital(b) - this.custoCapital(a)
        || a.measure.localeCompare(b.measure));
    },
    custoTotal() {
      return this.custoRowsBase().reduce((total, row) => total + this.custoCapital(row), 0);
    },
    custoPneusComCusto() {
      return this.custoRowsBase().reduce((total, row) => total + row.quantity_with_cost, 0);
    },
    custoPercentual(row) {
      const total = this.custoTotal();
      return total > 0 ? this.custoCapital(row) / total * 100 : 0;
    },
    custoRows() {
      const search = clean(this.custoBusca).toLowerCase();
      const digits = (value) => String(value || '').replace(/\D/g, '');
      const searchDigits = digits(search);
      let rows = this.custoRowsBase();
      if (search) {
        rows = rows.filter((row) => row.measure.toLowerCase().includes(search)
          || String(row.tire_condition || '').toLowerCase().includes(search)
          || row.brands.some((brand) => brand.toLowerCase().includes(search))
          || (searchDigits && digits(row.measure).includes(searchDigits)));
      }
      if (this.custoOrdem === 'maior_custo') {
        rows = [...rows].sort((a, b) => Number(b.unit_cost || 0) - Number(a.unit_cost || 0));
      } else if (this.custoOrdem === 'menor_custo') {
        rows = [...rows].sort((a, b) => Number(a.unit_cost || 0) - Number(b.unit_cost || 0));
      }
      return rows;
    },
    custoTopRows() {
      return this.custoRowsBase().filter((row) => this.custoCapital(row) > 0).slice(0, 5);
    },
    custoMaxCapital() {
      return Math.max(1, ...this.custoTopRows().map((row) => this.custoCapital(row)));
    },
    custoTop3Percentual() {
      const total = this.custoTotal();
      return total <= 0 ? 0 : this.custoRowsBase().slice(0, 3)
        .reduce((sum, row) => sum + this.custoCapital(row), 0) / total * 100;
    },
    custoLider() {
      return this.custoRowsBase()[0] || null;
    },
    custoComCusto() {
      return this.custoRowsBase().filter((row) => this.custoValido(row)).length;
    },
  };
};
