// Obra 300 (2026-07-05): fatia do painel da MATRIZ — estoque do galpão por medida: busca, custo médio, entrada.
// VERBATIM das linhas 1744-1859 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.galpao = function () {
  return {
    async loadStockReconciliation() {
      this.stockReconciliation.loading = true;
      this.stockReconciliation.error = null;
      try {
        const report = await this.apiGet('/admin/api/wholesale/stock/reconciliation');
        this.stockReconciliation.summary = report.summary || null;
        this.stockReconciliation.rows = report.rows || [];
      } catch (err) {
        this.stockReconciliation.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.stockReconciliation.loading = false;
      }
    },
    reconciliationStatusText(status) {
      const labels = {
        aligned: 'Alinhado', quantity_divergent: 'Saldo diferente', catalog_only: 'SÃ³ no catÃ¡logo legado',
        official_only: 'SÃ³ no estoque oficial', official_ambiguous: 'Cadastro oficial duplicado',
        official_cost_missing: 'Custo oficial ausente',
      };
      return labels[status] || status;
    },
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
        min_invalid: 'Mínimo inválido (número inteiro, 0 ou mais).',
      };
      return map[code] || `Não consegui ${acao === 'entrada' ? 'registrar a entrada' : 'salvar'} (${code}).`;
    },
    // 0126: badge "repor" da tabela — mínimo definido e qtd chegou nele (zero tem cor própria).
    stockPrecisaRepor(row) {
      return row.min_quantity != null && Number(row.quantity_on_hand) <= Number(row.min_quantity);
    },
    async stockSubmit() {
      const measure = (this.stockForm.measure || '').trim();
      const qty = Number(this.stockForm.quantity_on_hand);
      const cost = Number(this.stockForm.unit_cost) || 0;
      const minRaw = String(this.stockForm.min_quantity ?? '').trim();
      const min = minRaw === '' ? null : Number(minRaw); // vazio = sem mínimo (limpa)
      if (!measure) { this.stockMsg = { ok: false, text: 'Diga a medida (ex.: 90/90-18).' }; return; }
      if (!Number.isInteger(qty) || qty < 0) { this.stockMsg = { ok: false, text: 'Quantidade inválida.' }; return; }
      if (cost < 0) { this.stockMsg = { ok: false, text: 'Custo inválido.' }; return; }
      if (min !== null && (!Number.isInteger(min) || min < 0)) { this.stockMsg = { ok: false, text: 'Mínimo inválido (número inteiro, 0 ou mais).' }; return; }
      this.stockSaving = true;
      this.stockMsg = null;
      try {
        await this.apiPost('/admin/api/wholesale/stock', {
          measure,
          quantity_on_hand: qty,
          unit_cost: cost,
          min_quantity: min,
          notes: this.stockForm.notes ? this.stockForm.notes.trim() : null,
        });
        this.stockMsg = { ok: true, text: `${measure}: ${qty} un · custo R$ ${cost.toFixed(2)}${min !== null ? ` · mínimo ${min}` : ''}.` };
        this.stockForm = { measure: '', quantity_on_hand: '', unit_cost: '', min_quantity: '', notes: '' };
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
      this.stockForm = { measure: row.measure, quantity_on_hand: row.quantity_on_hand, unit_cost: row.unit_cost ?? '', min_quantity: row.min_quantity ?? '', notes: row.notes || '' };
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
        this.stockForm = { measure: '', quantity_on_hand: '', unit_cost: '', min_quantity: '', notes: '' };
        await this.loadAtacado();
        void this.loadStockReconciliation();
        void this.loadSino(); // entrada pode ter tirado a medida do "repor"
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
        void this.loadStockReconciliation();
        void this.loadGalpaoFilme(); // a remoção entra no filme
      } catch (err) {
        this.stockMsg = { ok: false, text: `Não consegui remover (${err.message}).` };
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
      if (q) rows = rows.filter((r) => r.measure.toLowerCase().includes(q) || (qd !== '' && digits(r.measure).includes(qd)));
      const peso = (r) => (Number(r.quantity_on_hand) === 0 ? 0 : (this.stockPrecisaRepor(r) ? 1 : 2));
      return [...rows].sort((a, b) => peso(a) - peso(b) || a.measure.localeCompare(b.measure));
    },
    // Resumo do topo: pneus no galpão, capital parado (Σ qty × custo médio — a MESMA conta
    // do indicador da aba Financeiro), medidas zeradas e pra repor. Calculado da lista
    // que JÁ veio (nunca diverge da tabela ao lado).
    stockResumo() {
      let pneus = 0, capital = 0, zeradas = 0, repor = 0;
      for (const r of this.atacadoStock) {
        const q = Number(r.quantity_on_hand) || 0;
        pneus += q;
        capital += q * (Number(r.unit_cost) || 0);
        if (q === 0) zeradas++;
        else if (this.stockPrecisaRepor(r)) repor++;
      }
      return { pneus, capital, zeradas, repor };
    },
    // ── BAIXA MANUAL com motivo (0128): quebra/perda/uso — recusa acima do saldo ──
    stockBaixaOpen(row) {
      this.stockBaixaForm = { measure: row.measure, quantity: '', tipo: 'quebra', texto: '' };
      this.stockMsg = null;
      this.$nextTick(() => { const el = document.getElementById('galpao-baixa-qtd'); if (el) el.focus(); });
    },
    stockBaixaFechar() {
      this.stockBaixaForm = { measure: null, quantity: '', tipo: 'quebra', texto: '' };
    },
    async stockBaixaSubmit() {
      const f = this.stockBaixaForm;
      const qty = Number(f.quantity);
      if (!Number.isInteger(qty) || qty <= 0) { this.stockMsg = { ok: false, text: 'Quantos pneus saem?' }; return; }
      const reason = f.tipo + (f.texto && f.texto.trim() ? ': ' + f.texto.trim() : '');
      this.stockBaixaSaving = true;
      this.stockMsg = null;
      try {
        const row = await this.apiPost('/admin/api/wholesale/stock/baixa', { measure: f.measure, quantity: qty, reason });
        this.stockMsg = { ok: true, text: `Baixa de ${qty} × ${f.measure} (${f.tipo}) — sobraram ${row.quantity_on_hand} un.` };
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
    async loadGalpaoFilme(measure) {
      if (measure !== undefined) this.galpaoFilme.measure = measure;
      // guarda de corrida: o load geral do watch e o clique "filme" podem estar em voo
      // juntos — só a resposta do pedido MAIS RECENTE pode pintar a tela.
      const req = (this.galpaoFilme.req = (this.galpaoFilme.req || 0) + 1);
      this.galpaoFilme.loading = true;
      try {
        const m = this.galpaoFilme.measure;
        const r = await this.apiGet('/admin/api/wholesale/stock/movimentos' + (m ? '?measure=' + encodeURIComponent(m) : ''));
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
    filmeDaMedida(measure) {
      void this.loadGalpaoFilme(measure);
      this.$nextTick(() => { const el = document.getElementById('galpao-filme'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    },
    movRotulo(m) {
      const map = {
        definir: 'Definir (ajuste da tela)', entrada: 'Entrada avulsa', compra: 'Compra de fornecedor',
        cancelamento_compra: 'Compra cancelada', venda_atacado: 'Venda de atacado',
        cancelamento_venda: 'Venda de atacado cancelada', varejo: 'Venda do varejo (bot/balcão)',
        cancelamento_varejo: 'Varejo cancelado (voltou)', baixa_manual: 'Baixa manual',
        remocao: 'Medida removida', sem_rotulo: 'mexida sem rótulo',
      };
      let t = map[m.source] || m.source;
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
