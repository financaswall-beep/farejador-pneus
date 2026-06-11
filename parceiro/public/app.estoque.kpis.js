/**
 * app.estoque.kpis.js - fabrica `estoqueKpis` do painel do parceiro (obra <=300, passo 7/11).
 * MORA AQUI: leitura/calculo de ESTOQUE - KPIs (valor, custo, unidades, baixo), filtros da
 * tela (busca/origem/status/marca/posicao + paginacao), series (movimentacao 4 semanas,
 * entradas/saidas do mes), stockBreakdown e os helpers 0076 de leitura stockAvailable
 * (disponivel = fisico - reservado) e stockItemValue. CONTRATO 0076: ver SECOES/ESTOQUE.md.
 * NAO MORA AQUI: acoes de escrita (app.estoque.forms.js); helpers compartilhados com o
 * financeiro (isPhysicalExitSale, saleRealizedAt, isCurrentMonth, salesUnitsFor - raiz ate o passo 9).
 * VEIO DE: app.js commit dcd8fa9 (ranges 599-733, 750-836, 1325-1331, 2908-2919), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.estoqueKpis = () => ({
    get stockValue() {
      return this.estoque.reduce((sum, item) => {
        const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
        const value = this.num(item.sale_price || item.average_cost);
        return sum + (qty * value);
      }, 0);
    },

    get stockCostValue() {
      return this.estoque.reduce((sum, item) => {
        const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
        return sum + (qty * this.num(item.average_cost));
      }, 0);
    },

    get stockTotalUnits() {
      return this.estoque.reduce((sum, item) => {
        return sum + (item.is_tracked ? this.num(item.quantity_on_hand) : 0);
      }, 0);
    },

    get stockLowItems() {
      return this.estoque.filter((item) => ['low_stock', 'out_of_stock'].includes(item.stock_status));
    },

    get stockOriginSplit() {
      const split = [
        { label: '2W', key: '2w', count: 0, value: 0, color: '#047857' },
        { label: 'Porta', key: 'porta', count: 0, value: 0, color: '#94a3b8' },
      ];
      for (const item of this.estoque) {
        const origin = this.stockOriginKey(item);
        const bucket = split.find((entry) => entry.key === origin) || split[1];
        const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
        bucket.count += qty;
        bucket.value += qty * this.num(item.average_cost || item.sale_price);
      }
      const total = split.reduce((sum, item) => sum + item.count, 0) || 1;
      return split.map((item) => ({ ...item, percent: Math.round((item.count / total) * 100) }));
    },

    get filteredStock() {
      const search = this.stockSearch.trim().toLowerCase();
      return this.estoque.filter((item) => {
        const origin = this.stockOriginKey(item);
        const haystack = [item.item_name, item.tire_size, item.brand, item.supplier_name]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (search && !haystack.includes(search)) return false;
        if (this.stockOriginFilter !== 'all' && origin !== this.stockOriginFilter) return false;
        if (this.stockStatusFilter !== 'all' && item.stock_status !== this.stockStatusFilter) return false;
        return true;
      });
    },

    get stockMovementSeries() {
      const weeks = [];
      const now = new Date();
      for (let i = 3; i >= 0; i -= 1) {
        const end = new Date(now);
        end.setDate(now.getDate() - (i * 7));
        const start = new Date(end);
        start.setDate(end.getDate() - 6);
        weeks.push({
          start,
          end,
          label: `${start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} - ${end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`,
          entradas: 0,
          saidas: 0,
        });
      }
      const addToWeek = (dateValue, key, amount) => {
        if (!dateValue) return;
        const date = new Date(dateValue);
        if (Number.isNaN(date.getTime())) return;
        const week = weeks.find((item) => date >= item.start && date <= item.end);
        if (week) week[key] += amount;
      };
      for (const purchase of this.compras) {
        if (purchase.status === 'cancelled') continue;
        const items = Array.isArray(purchase.items) ? purchase.items : [];
        const qty = items.reduce((sum, item) => sum + this.num(item.quantity), 0);
        addToWeek(purchase.purchased_at || purchase.created_at, 'entradas', qty);
      }
      if (!this.compras.length) {
        for (const item of this.estoque) {
          const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
          addToWeek(item.created_at, 'entradas', qty);
        }
      }
      for (const sale of this.activeSales) {
        // 0076: só saída física (pickup + delivery entregue); reserva não é saída.
        if (!this.isPhysicalExitSale(sale)) continue;
        const items = Array.isArray(sale.items) ? sale.items : [];
        const qty = items.reduce((sum, item) => sum + this.num(item.quantity), 0) || 1;
        addToWeek(this.saleRealizedAt(sale), 'saidas', qty);
      }
      return weeks;
    },

    get purchasedUnitsMonth() {
      return this.compras.reduce((sum, purchase) => {
        if (purchase.status === 'cancelled') return sum;
        // Só compras do mês corrente (antes somava todas de sempre).
        if (!this.isCurrentMonth(purchase.purchased_at || purchase.created_at)) return sum;
        const items = Array.isArray(purchase.items) ? purchase.items : [];
        return sum + items.reduce((itemSum, item) => itemSum + this.num(item.quantity), 0);
      }, 0);
    },

    get stockCreatedUnitsMonth() {
      const now = new Date();
      const month = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
      }).format(now);
      return this.estoque.reduce((sum, item) => {
        if (!item.is_tracked || !item.created_at) return sum;
        const createdMonth = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Sao_Paulo',
          year: 'numeric',
          month: '2-digit',
        }).format(new Date(item.created_at));
        if (createdMonth !== month) return sum;
        return sum + this.num(item.quantity_on_hand);
      }, 0);
    },

    get inventoryEntriesMonth() {
      // Enquanto nao existe ledger de movimentacao, evita contar duas vezes
      // compra que tambem criou item novo no estoque.
      return Math.max(this.purchasedUnitsMonth, this.stockCreatedUnitsMonth);
    },

    get soldUnitsMonth() {
      // Só saídas físicas (pickup + delivery entregue) do mês corrente.
      return this.salesUnitsFor(
        this.completedSales.filter((s) => this.isCurrentMonth(this.saleRealizedAt(s))),
      );
    },

    // ── Indicadores extras da tela de estoque (refit mockup) ──────────────
    get stockCategoriesCount() {
      // "Categorias" = marcas distintas com itens rastreados no estoque.
      const brands = new Set();
      for (const item of this.estoque) {
        if (item.brand) brands.add(String(item.brand).trim().toLowerCase());
      }
      return brands.size;
    },

    get stockTopSizes() {
      // Top medidas por quantidade em estoque (pra barra "Medidas com maior estoque").
      const bySize = new Map();
      for (const item of this.estoque) {
        const size = item.tire_size;
        if (!size) continue;
        const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
        bySize.set(size, (bySize.get(size) || 0) + qty);
      }
      const rows = [...bySize.entries()]
        .map(([label, qty]) => ({ label, qty }))
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 5);
      const max = rows.reduce((m, r) => Math.max(m, r.qty), 0) || 1;
      return rows.map((r) => ({ ...r, pct: Math.round((r.qty / max) * 100) }));
    },

    get stockTurnover() {
      // Giro aproximado: saídas do mês / estoque médio atual. Sem ledger, usa
      // o saldo atual como proxy do estoque médio.
      const base = this.stockTotalUnits || 0;
      if (!base) return 0;
      return this.soldUnitsMonth / base;
    },

    get stockBrandOptions() {
      const set = new Set();
      for (const i of this.estoque) { if (i.brand) set.add(String(i.brand).trim()); }
      return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    },

    get stockFilteredRows() {
      // Aplica os filtros de chip (marca/posição) por cima do filteredStock,
      // que já cuida de busca + status + origem.
      return this.filteredStock.filter((item) => {
        if (this.stockBrandFilter !== 'all' && String(item.brand || '').trim() !== this.stockBrandFilter) return false;
        if (this.stockPositionFilter !== 'all' && this.stockPositionLabel(item) !== this.stockPositionFilter) return false;
        return true;
      });
    },

    get stockTotalPages() {
      return Math.max(1, Math.ceil(this.stockFilteredRows.length / this.stockPageSize));
    },

    get stockPagedRows() {
      const page = Math.min(this.stockPage, this.stockTotalPages);
      const start = (page - 1) * this.stockPageSize;
      return this.stockFilteredRows.slice(start, start + this.stockPageSize);
    },

    get stockDetail() {
      // Item mostrado no painel de detalhes: o selecionado, ou o 1º da lista.
      if (this.stockSelected) {
        const found = this.estoque.find((i) => i.id === this.stockSelected);
        if (found) return found;
      }
      return this.stockFilteredRows[0] || null;
    },

    get stockModelsCount() {
      const set = new Set();
      for (const i of this.estoque) { const n = String(i.item_name || '').trim().toLowerCase(); if (n) set.add(n); }
      return set.size;
    },

    get stockLowPercent() {
      const total = this.estoque.length || 1;
      return Math.round((this.stockLowItems.length / total) * 100);
    },

    get stockBreakdown() {
      return this.estoque.reduce((acc, item) => {
        const status = item.stock_status || (item.is_tracked ? 'unknown' : 'not_tracked');
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, { in_stock: 0, low_stock: 0, out_of_stock: 0, unknown: 0, not_tracked: 0 });
    },

    // 0076: disponível = físico − reservado (item não rastreado = sem limite).
    // O carrinho/pedido bloqueia pela DISPONIBILIDADE, não pelo físico, para não
    // vender um pneu já comprometido com uma entrega.
    stockAvailable(item) {
      if (!item || !item.is_tracked) return Infinity;
      return this.num(item.quantity_on_hand) - this.num(item.quantity_reserved);
    },

    stockItemValue(item) {
      const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
      return qty * this.num(item.average_cost || item.sale_price);
    },
});
