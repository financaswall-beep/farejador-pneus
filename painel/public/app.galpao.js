// Obra 300 (2026-07-05): fatia do painel da MATRIZ — estoque do galpão por medida: busca, custo médio, entrada.
// VERBATIM das linhas 1744-1859 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.galpao = function () {
  return {
    measureOnHand(measure) {
      // Quanto tem de uma medida (pro form de venda mostrar "em estoque"). null = não cadastrada.
      const m = (measure || '').trim();
      if (!m) return null;
      const row = this.atacadoMeasures.find((x) => x.measure === m);
      return row && row.quantity_on_hand != null ? Number(row.quantity_on_hand) : null;
    },
    // Custo unitário cadastrado da medida (null = sem estoque/custo). Fase 3.
    measureCost(measure) {
      const m = (measure || '').trim();
      if (!m) return null;
      const row = this.atacadoMeasures.find((x) => x.measure === m);
      return row && row.unit_cost != null ? Number(row.unit_cost) : null;
    },
    // Lucro estimado de um item da venda = (preço − custo) × qtd. null se a medida não tem custo.
    itemProfit(it) {
      const cost = this.measureCost(it.measure);
      if (cost == null) return null;
      return (Number(it.unit_price || 0) - cost) * (Number(it.quantity) || 0);
    },
    // Autocomplete da medida: casa por TEXTO e por DÍGITOS (ignora / - e espaço — ex.:
    // "90 90 18" acha "90/90-18"). Campo vazio na VENDA mostra o que TEM no galpão (atalho
    // pra escolher clicando); no cadastro do galpão (key='estoque') não abre nada vazio.
    measureFind(query, key) {
      const raw = (query || '').trim().toLowerCase();
      const digits = (s) => (s || '').replace(/\D/g, ''); // só números: casa qualquer separador
      const qd = digits(raw);
      let hits;
      if (!raw) {
        hits = key === 'estoque' ? [] : this.atacadoMeasures.filter((m) => Number(m.quantity_on_hand) > 0).slice(0, 12);
      } else {
        hits = this.atacadoMeasures.filter((m) => {
          const mm = m.measure.toLowerCase();
          return mm.includes(raw) || (qd !== '' && digits(mm).includes(qd));
        }).slice(0, 12);
      }
      this.measureBox = { key, hits };
    },
    measurePick(value, obj) {
      obj.measure = value;
      this.measureBox = { key: null, hits: [] };
    },
    measureBlur() {
      // delay pra o clique numa sugestão (mousedown) acontecer antes de fechar
      setTimeout(() => { this.measureBox = { key: null, hits: [] }; }, 150);
    },
    // Texto amigável dos erros do cadastro do galpão (Fase 4: medida fora do catálogo).
    stockErrText(code, acao) {
      const map = {
        measure_not_in_catalog: 'Essa medida não está no catálogo. Confira (ex.: 90/90-18) ou peça pra adicionar ao catálogo.',
        measure_required: 'Diga a medida (ex.: 90/90-18).',
        quantity_invalid: 'Quantidade inválida.',
        cost_invalid: 'Custo inválido.',
      };
      return map[code] || `Não consegui ${acao === 'entrada' ? 'registrar a entrada' : 'salvar'} (${code}).`;
    },
    async stockSubmit() {
      const measure = (this.stockForm.measure || '').trim();
      const qty = Number(this.stockForm.quantity_on_hand);
      const cost = Number(this.stockForm.unit_cost) || 0;
      if (!measure) { this.stockMsg = { ok: false, text: 'Diga a medida (ex.: 90/90-18).' }; return; }
      if (!Number.isInteger(qty) || qty < 0) { this.stockMsg = { ok: false, text: 'Quantidade inválida.' }; return; }
      if (cost < 0) { this.stockMsg = { ok: false, text: 'Custo inválido.' }; return; }
      this.stockSaving = true;
      this.stockMsg = null;
      try {
        await this.apiPost('/admin/api/wholesale/stock', {
          measure,
          quantity_on_hand: qty,
          unit_cost: cost,
          notes: this.stockForm.notes ? this.stockForm.notes.trim() : null,
        });
        this.stockMsg = { ok: true, text: `${measure}: ${qty} un · custo R$ ${cost.toFixed(2)}.` };
        this.stockForm = { measure: '', quantity_on_hand: '', unit_cost: '', notes: '' };
        await this.loadAtacado();
      } catch (err) {
        this.stockMsg = { ok: false, text: this.stockErrText(err.message) };
      } finally {
        this.stockSaving = false;
      }
    },
    stockEdit(row) {
      this.stockForm = { measure: row.measure, quantity_on_hand: row.quantity_on_hand, unit_cost: row.unit_cost ?? '', notes: row.notes || '' };
      this.stockMsg = null;
    },
    // ENTRADA de compra: soma a qtd e recalcula o custo médio ponderado (a conta que "bate").
    async stockEntry() {
      const measure = (this.stockForm.measure || '').trim();
      const qty = Number(this.stockForm.quantity_on_hand);
      const cost = Number(this.stockForm.unit_cost) || 0;
      if (!measure) { this.stockMsg = { ok: false, text: 'Diga a medida (ex.: 90/90-18).' }; return; }
      if (!Number.isInteger(qty) || qty <= 0) { this.stockMsg = { ok: false, text: 'Quantos pneus entraram?' }; return; }
      if (cost < 0) { this.stockMsg = { ok: false, text: 'Custo inválido.' }; return; }
      this.stockSaving = true;
      this.stockMsg = null;
      try {
        const row = await this.apiPost('/admin/api/wholesale/stock/entry', { measure, quantity_in: qty, unit_cost: cost });
        this.stockMsg = { ok: true, text: `Entrada de ${qty} × ${measure} a R$ ${cost.toFixed(2)} → estoque ${row.quantity_on_hand} un · custo médio R$ ${Number(row.unit_cost).toFixed(2)}.` };
        this.stockForm = { measure: '', quantity_on_hand: '', unit_cost: '', notes: '' };
        await this.loadAtacado();
      } catch (err) {
        this.stockMsg = { ok: false, text: this.stockErrText(err.message, 'entrada') };
      } finally {
        this.stockSaving = false;
      }
    },
    async stockRemove(measure) {
      if (!window.confirm(`Remover ${measure} do estoque do galpão?`)) return;
      try {
        await this.apiPost('/admin/api/wholesale/stock/remove', { measure });
        await this.loadAtacado();
      } catch (err) {
        this.stockMsg = { ok: false, text: `Não consegui remover (${err.message}).` };
      }
    },

  };
};
