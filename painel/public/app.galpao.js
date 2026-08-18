window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.galpao = function () {
  return {
    measureBlur() {
      setTimeout(() => { this.measureBox = { key: null, hits: [] }; }, 150);
    },
    stockErrText(code, acao) {
      const map = {
        measure_not_in_catalog: 'Essa medida não está no catálogo. Confira (ex.: 90/90-18) ou peça pra adicionar ao catálogo.',
        measure_required: 'Diga a medida (ex.: 90/90-18).',
        quantity_invalid: 'Quantidade inválida.',
        cost_invalid: 'Custo inválido.',
        min_invalid: 'Mínimo inválido (número inteiro, 0 ou mais).',
        reason_required: 'Informe o motivo da alteração de saldo ou custo.',
        catalog_product_not_found: 'A medida existe, mas o produto correspondente não foi encontrado no Catálogo.',
        brand_required: 'Informe a marca do pneu.',
        tire_condition_required: 'Selecione a condição do pneu.',
      };
      return map[code] || `Não consegui ${acao === 'entrada' ? 'registrar a entrada' : 'salvar'} (${code}).`;
    },
    stockPrecisaRepor(row) {
      return row.min_quantity != null
        && Number(row.quantity_available ?? row.quantity_on_hand) <= Number(row.min_quantity);
    },
    async stockSubmit() {
      const measure = (this.stockForm.measure || '').trim();
      const brand = (this.stockForm.brand || '').trim();
      const tireCondition = this.stockForm.tire_condition || '';
      const qty = Number(this.stockForm.quantity_on_hand);
      const cost = Number(this.stockForm.unit_cost) || 0;
      const reason = (this.stockForm.entry_reason || '').trim();
      const minRaw = String(this.stockForm.min_quantity ?? '').trim();
      const min = minRaw === '' ? null : Number(minRaw); // vazio = sem mínimo (limpa)
      if (!measure) { this.stockMsg = { ok: false, text: 'Diga a medida (ex.: 90/90-18).' }; return; }
      if (!tireCondition) { this.stockMsg = { ok: false, text: 'Selecione a condição do pneu.' }; return; }
      if (!Number.isInteger(qty) || qty < 0) { this.stockMsg = { ok: false, text: 'Quantidade inválida.' }; return; }
      if (cost < 0) { this.stockMsg = { ok: false, text: 'Custo inválido.' }; return; }
      if (min !== null && (!Number.isInteger(min) || min < 0)) { this.stockMsg = { ok: false, text: 'Mínimo inválido (número inteiro, 0 ou mais).' }; return; }
      if (this.stockAdjustmentChangesValue() && reason.length < 2) {
        this.stockMsg = { ok: false, text: 'Informe o motivo da alteração de saldo ou custo.' };
        return;
      }
      this.stockSaving = true;
      this.stockMsg = null;
      try {
        await this.apiPost('/admin/api/wholesale/stock', {
          measure,
          brand: brand || null,
          tire_condition: tireCondition,
          quantity_on_hand: qty,
          unit_cost: cost,
          min_quantity: min,
          notes: this.stockForm.notes ? this.stockForm.notes.trim() : null,
          reason: reason || undefined,
        });
        this.stockMsg = { ok: true, text: `${measure}${brand ? ` · ${brand}` : ''}: ${qty} un · custo R$ ${cost.toFixed(2)}${min !== null ? ` · mínimo ${min}` : ''}.` };
        this.stockForm = { measure: '', brand: '', tire_condition: '', quantity_on_hand: '', unit_cost: '', min_quantity: '', notes: '', entry_nature: 'inventory_found', entry_reason: '', idempotency_key: '', original_quantity_on_hand: null, original_unit_cost: null };
        await this.loadAtacado();
        void this.loadStockReconciliation();
        void this.loadSino(); // mínimo mudou → o aviso "repor" pode ter mudado
      } catch (err) {
        this.stockMsg = { ok: false, text: this.stockErrText(err.message) };
      } finally {
        this.stockSaving = false;
      }
    },
    stockEdit(row) {
      this.stockForm = { measure: row.measure, brand: row.brand || '',
        tire_condition: row.tire_condition || '', quantity_on_hand: row.quantity_on_hand,
        unit_cost: row.unit_cost ?? '', min_quantity: row.min_quantity ?? '',
        notes: row.notes || '', entry_nature: 'inventory_found', entry_reason: '',
        idempotency_key: '', original_quantity_on_hand: row.quantity_on_hand,
        original_unit_cost: row.unit_cost ?? 0, identity_locked: true };
      this.stockMsg = null;
    },
    // ENTRADA de compra: soma a qtd e recalcula o custo médio ponderado (a conta que "bate").
    async stockEntry() {
      const measure = (this.stockForm.measure || '').trim();
      const brand = (this.stockForm.brand || '').trim();
      const tireCondition = this.stockForm.tire_condition || '';
      const qty = Number(this.stockForm.quantity_on_hand);
      const cost = Number(this.stockForm.unit_cost) || 0;
      const reason = (this.stockForm.entry_reason || '').trim();
      if (!measure) { this.stockMsg = { ok: false, text: 'Diga a medida (ex.: 90/90-18).' }; return; }
      if (!tireCondition) { this.stockMsg = { ok: false, text: 'Selecione a condição do pneu.' }; return; }
      if (!Number.isInteger(qty) || qty <= 0) { this.stockMsg = { ok: false, text: 'Quantos pneus entraram?' }; return; }
      if (cost < 0) { this.stockMsg = { ok: false, text: 'Custo inválido.' }; return; }
      if (reason.length < 2) { this.stockMsg = { ok: false, text: 'Explique a origem dessa entrada.' }; return; }
      this.stockSaving = true;
      this.stockMsg = null;
      try {
        this.stockForm.idempotency_key = this.stockForm.idempotency_key || window.PAINEL_INTEGRITY.operation('stock-entry', 'form').key;
        const row = await this.apiPost('/admin/api/wholesale/stock/entry', {
          measure, brand: brand || null, tire_condition: tireCondition,
          quantity_in: qty, unit_cost: cost, entry_nature: this.stockForm.entry_nature,
          reason, idempotency_key: this.stockForm.idempotency_key,
        });
        window.PAINEL_INTEGRITY.complete('stock-entry', 'form');
        this.stockMsg = { ok: true, text: `Entrada de ${qty} × ${measure}${brand ? ` · ${brand}` : ''} a R$ ${cost.toFixed(2)} → estoque ${row.quantity_on_hand} un · custo médio R$ ${Number(row.unit_cost).toFixed(2)}.` };
        this.stockForm = { measure: '', brand: '', tire_condition: '', quantity_on_hand: '', unit_cost: '', min_quantity: '', notes: '', entry_nature: 'inventory_found', entry_reason: '', idempotency_key: '', original_quantity_on_hand: null, original_unit_cost: null };
        await this.loadAtacado();
        void this.loadStockReconciliation();
        void this.loadSino(); // entrada pode ter tirado a medida do "repor"
      } catch (err) {
        this.stockMsg = { ok: false, text: this.stockErrText(err.message, 'entrada') };
      } finally {
        this.stockSaving = false;
      }
    },
    async stockRemove(row) {
      const measure = row.measure;
      const brand = row.brand || 'Sem marca';
      const reason = window.prompt(
        `Explique por que ${measure} · ${brand} deve ser removido do estoque:`,
        '',
      );
      if (reason == null) return;
      if (reason.trim().length < 2) {
        this.stockMsg = { ok: false, text: 'Informe um motivo para remover a variante.' };
        return;
      }
      if (!window.confirm(`Remover ${measure} · ${brand}? O saldo será baixado e conciliado no Financeiro.`)) return;
      try {
        const operation = window.PAINEL_INTEGRITY.operation('stock-remove', this.stockVariantKey(row));
        await this.apiPost('/admin/api/wholesale/stock/remove', {
          measure, brand, tire_condition: row.tire_condition,
          reason: reason.trim(), idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete('stock-remove', this.stockVariantKey(row));
        await this.loadAtacado();
        void this.loadStockReconciliation();
        void this.loadGalpaoFilme(); // a remoção entra no filme
      } catch (err) {
        this.stockMsg = { ok: false, text: err.message === 'stock_has_reservations'
          ? 'Não é possível remover: há unidades reservadas para pedidos em aberto.'
          : `Não consegui remover (${err.message}).` };
      }
    },
    // ── Auditoria 07-07: busca + "repor primeiro" — a lista que a tabela renderiza ──
    // Busca casa por TEXTO e por DÍGITOS (mesma régua do autocomplete); ordenação põe
    // ZEROU no topo, depois REPOR, depois o resto (alfabético dentro de cada grupo).
    stockRowsView() {
      const digits = (s) => (s || '').replace(/\D/g, '');
      const q = (this.stockBusca || '').trim().toLowerCase();
      const qd = digits(q);
      let rows = this.atacadoStock;
      if (q) rows = rows.filter((r) => r.measure.toLowerCase().includes(q)
        || String(r.brand || '').toLowerCase().includes(q)
        || String(r.tire_condition || '').toLowerCase().includes(q)
        || (qd !== '' && digits(r.measure).includes(qd)));
      const peso = (r) => (this.measureAvailable(r) === 0 ? 0 : (this.stockPrecisaRepor(r) ? 1 : 2));
      return [...rows].sort((a, b) => peso(a) - peso(b) || a.measure.localeCompare(b.measure));
    },
    // Resumo do topo: pneus no galpão, capital parado (Σ qty × custo médio — a MESMA conta
    // do indicador da aba Financeiro), variantes zeradas e pra repor. Calculado da lista
    // que JÁ veio (nunca diverge da tabela ao lado).
    stockResumo() {
      let pneus = 0, capital = 0, zeradas = 0, repor = 0;
      for (const r of this.atacadoStock) {
        const q = Number(r.quantity_on_hand) || 0;
        pneus += q;
        capital += q * (Number(r.unit_cost) || 0);
        if (this.measureAvailable(r) === 0) zeradas++;
        else if (this.stockPrecisaRepor(r)) repor++;
      }
      return { pneus, capital, zeradas, repor };
    },
    // ── BAIXA MANUAL com motivo (0128): quebra/perda/uso — recusa acima do saldo ──
    stockBaixaOpen(row) {
      this.stockBaixaForm = { measure: row.measure, brand: row.brand,
        tire_condition: row.tire_condition, quantity: '', tipo: 'breakage',
        texto: '', idempotency_key: '' };
      this.stockMsg = null;
      this.$nextTick(() => { const el = document.getElementById('galpao-baixa-qtd'); if (el) el.focus(); });
    },
    stockBaixaFechar() {
      this.stockBaixaForm = { measure: null, brand: null, tire_condition: null,
        quantity: '', tipo: 'breakage', texto: '', idempotency_key: '' };
    },
    async stockBaixaSubmit() {
      const f = this.stockBaixaForm;
      const qty = Number(f.quantity);
      if (!Number.isInteger(qty) || qty <= 0) { this.stockMsg = { ok: false, text: 'Quantos pneus saem?' }; return; }
      const labels = { breakage: 'quebra', loss: 'perda', internal_use: 'uso interno', other: 'outro' };
      const reason = labels[f.tipo] + (f.texto && f.texto.trim() ? ': ' + f.texto.trim() : '');
      this.stockBaixaSaving = true;
      this.stockMsg = null;
      try {
        f.idempotency_key = f.idempotency_key || window.PAINEL_INTEGRITY.operation('stock-manual-decrement', 'form').key;
        const row = await this.apiPost('/admin/api/wholesale/stock/baixa', {
          measure: f.measure, brand: f.brand, tire_condition: f.tire_condition,
          quantity: qty, nature: f.tipo, reason, idempotency_key: f.idempotency_key,
        });
        window.PAINEL_INTEGRITY.complete('stock-manual-decrement', 'form');
        this.stockMsg = { ok: true, text: `Baixa de ${qty} × ${f.measure} (${labels[f.tipo]}) — sobraram ${row.quantity_on_hand} un.` };
        this.stockBaixaFechar();
        await this.loadAtacado();
        void this.loadStockReconciliation();
        void this.loadSino(); // a baixa pode ter posto a medida no "repor"
        void this.loadGalpaoFilme();
      } catch (err) {
        this.stockMsg = { ok: false, text: this.stockBaixaErrText(err.message) };
      } finally {
        this.stockBaixaSaving = false;
      }
    },
    stockBaixaErrText(code) {
      const s = String(code);
      if (s.startsWith('baixa_maior_que_estoque')) {
        return `Não dá: o galpão só tem ${s.split(':')[1]} dessa medida. Confere o pneu físico — se o número do sistema estiver errado, corrija pelo Definir.`;
      }
      const map = {
        measure_not_found: 'Essa medida não está no galpão.',
        reason_required: 'Diga o motivo da baixa.',
        quantity_invalid: 'Quantidade inválida.',
        quantidade_inteira: 'Quantidade inválida (número inteiro).',
      };
      return map[code] || `Não consegui dar a baixa (${code}).`;
    },
    // ── O FILME (0128): a movimentação do galpão — quem mexeu, quanto, quando ──
    async loadGalpaoFilme(measure, brand, tireCondition) {
      if (measure !== undefined) this.galpaoFilme.measure = measure;
      if (measure === null && brand === undefined) {
        this.galpaoFilme.brand = null;
        this.galpaoFilme.tire_condition = null;
      }
      if (brand !== undefined) this.galpaoFilme.brand = brand;
      if (tireCondition !== undefined) this.galpaoFilme.tire_condition = tireCondition;
      if (window.PAINEL_STOCK_PREVIEW?.enabled()) {
        const selected = this.galpaoFilme.measure;
        const selectedBrand = this.galpaoFilme.brand;
        const selectedCondition = this.galpaoFilme.tire_condition;
        this.galpaoFilme.loading = false;
        this.galpaoFilme.rows = window.PAINEL_STOCK_PREVIEW.movements
          .filter((row) => (!selected || row.measure === selected)
            && (!selectedBrand || row.brand === selectedBrand)
            && (!selectedCondition || row.tire_condition === selectedCondition))
          .map((row) => ({ ...row }));
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
        return;
      }
      // guarda de corrida: o load geral do watch e o clique "filme" podem estar em voo
      // juntos — só a resposta do pedido MAIS RECENTE pode pintar a tela.
      const req = (this.galpaoFilme.req = (this.galpaoFilme.req || 0) + 1);
      this.galpaoFilme.loading = true;
      try {
        const m = this.galpaoFilme.measure;
        const b = this.galpaoFilme.brand;
        const condition = this.galpaoFilme.tire_condition;
        const params = new URLSearchParams();
        if (m) params.set('measure', m);
        if (b) params.set('brand', b);
        if (condition) params.set('tire_condition', condition);
        const r = await this.apiGet('/admin/api/wholesale/stock/movimentos' + (params.size ? '?' + params.toString() : ''));
        if (req !== this.galpaoFilme.req) return; // resposta velha: descarta
        this.galpaoFilme.rows = r.rows || [];
      } catch (err) {
        if (req !== this.galpaoFilme.req) return;
        this.galpaoFilme.rows = [];
        console.warn('filme do galpão falhou:', err.message);
      } finally {
        if (req === this.galpaoFilme.req) this.galpaoFilme.loading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    // Clicou "filme" numa medida: filtra a movimentação e desce até ela.
    filmeDaMedida(measure, brand, tireCondition) {
      void this.loadGalpaoFilme(measure, brand, tireCondition);
      this.$nextTick(() => { const el = document.getElementById('galpao-filme'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    },
    movRotulo(m) {
      const map = {
        definir: 'Definir (ajuste da tela)', entrada: 'Entrada avulsa', compra: 'Compra de fornecedor',
        cancelamento_compra: 'Compra cancelada', venda_atacado: 'Venda de atacado',
        cancelamento_venda: 'Venda de atacado cancelada', varejo: 'Venda do varejo (bot/balcão)',
        cancelamento_varejo: 'Varejo cancelado (voltou)', baixa_manual: 'Baixa manual',
        correcao_condicao: 'Correção de condição',
        correcao_marca: 'Correção de marca',
        remocao: 'Medida removida', sem_rotulo: 'mexida sem rótulo',
      };
      let t = m.source === 'definir' && String(m.reason || '').startsWith('Contagem física:')
        ? 'Contagem física' : (map[m.source] || m.source);
      if (m.source === 'baixa_manual' && m.reason) t += ' — ' + m.reason;
      else if (m.source === 'compra' && m.reason) t += ' (' + m.reason + ')';
      return t;
    },
    movQuando(m) {
      const d = new Date(m.created_at);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    },
    // Custo médio só aparece no filme quando MUDOU (entrada/compra recalculam; baixa não).
    movCustoTexto(m) {
      const b = m.cost_before == null ? null : Number(m.cost_before);
      const a = m.cost_after == null ? null : Number(m.cost_after);
      if (a == null || b === a) return '';
      if (b == null) return this.formatCurrency(a);
      return this.formatCurrency(b) + ' → ' + this.formatCurrency(a);
    },
  };
};
