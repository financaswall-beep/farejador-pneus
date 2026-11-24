window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.galpaoGrupos = function () {
  const endpoint = '/admin/api/wholesale/stock/groups';
  let overviewRequest = 0;
  let opening = 0;
  let groupLoad = null;
  const origins = '/admin/api/wholesale/stock/origins';
  const labels = { located: 'Somente localização', pending: 'Aguardando inspeção', approved: 'Conferido', blocked: 'Bloqueado' };
  const conditions = { novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' };
  const conservation = { selecionado: 'Selecionado', economico: 'Econômico' };
  const messages = {
    stock_group_invalid: 'Confira os campos e as quantidades.',
    stock_group_product_mismatch: 'Confira a medida, a marca, a condição e o modelo / desenho do produto no catálogo.',
    stock_group_offer_changed: 'O registro dos pneus mudou. Atualize e confira antes de tentar de novo.',
    stock_group_not_found: 'Este registro de pneus já não está disponível. Atualize a lista.',
    stock_group_unavailable: 'A quantidade excede o saldo livre para esta operação.',
    stock_group_not_editable: 'A situação atual dos pneus impede esta alteração.',
    stock_group_invalid_positions: 'Confira os códigos de pilha e use apenas uma linha por posição.',
    stock_group_invalid_inspection: 'Confira as unidades antes de confirmar um conjunto.',
    stock_group_model_required: 'Informe o modelo / desenho dos pneus conferidos.',
    reason_required: 'Informe o motivo desta operação.',
    stock_group_protected: 'Há pneus reservados neste registro. Confira o saldo livre.',
    stock_origin_changed: 'Há uma origem de venda a conferir. Atualize as pendências antes de mover ou editar estes pneus.',
    idempotency_conflict: 'A operação já foi registrada com outros dados. Atualize a lista.',
  };
  return {
    stockGroups: {
      groups: [], stock: [], stockId: '', query: '', groupId: null, form: null, move: null,
      loading: false, saving: false, error: '', message: '',
      overview: { stockId: '', status: 'idle', groups: [], ungrouped: 0 },
    },
    sgCondition(value) { return conditions[value] || ''; },
    sgStatus(value) { return labels[value] || ''; },
    sgConservation(value) { return conservation[value] || ''; },
    sgDate(value) { return value ? window.FarejadorTime.formatDateTime(value) : ''; },
    sgVariants() {
      const query = this.stockGroups.query.trim().toLowerCase();
      const variants = new Map();
      for (const row of this.stockGroups.stock) {
        if (!variants.has(row.stock_id)) variants.set(row.stock_id, row);
      }
      return [...variants.values()].filter(row => !query || row.stock_id === this.stockGroups.stockId
        || [row.measure, row.brand, this.sgCondition(row.tire_condition)].join(' ').toLowerCase().includes(query)
        || (query.replace(/\D/g, '') && row.measure.replace(/\D/g, '').includes(query.replace(/\D/g, ''))));
    },
    sgStock() { return this.stockGroups.stock.find(row => row.stock_id === this.stockGroups.stockId); },
    sgProducts() {
      return this.stockGroups.stock.filter(row => row.stock_id === this.stockGroups.stockId && row.product_id);
    },
    sgRows() { return this.stockGroups.groups.filter(row => row.stock_id === this.stockGroups.stockId); },
    sgActive() { return this.sgRows().find(row => row.group_id === this.stockGroups.groupId); },
    sgUngrouped() {
      const row = this.sgStock();
      const grouped = this.sgRows().reduce((sum, group) => sum + group.quantity_on_hand, 0);
      return row ? Math.max(0, row.quantity_on_hand - grouped) : 0;
    },
    async sgReadMeasureLocations(stockId) {
      const request = ++overviewRequest;
      const snapshot = { stockId, status: stockId ? 'loading' : 'idle', groups: [], ungrouped: 0 };
      this.stockGroups.overview = snapshot;
      if (!stockId) return;
      try {
        const data = await this.apiGet(endpoint + '?stock_id=' + encodeURIComponent(stockId));
        if (request !== overviewRequest) return;
        if (!Array.isArray(data.groups) || !Array.isArray(data.stock)) throw new Error('stock_groups_invalid_response');
        const groups = data.groups.filter(group => group.stock_id === stockId && (group.positions.length || group.origin_pending));
        const variant = data.stock.find(row => row.stock_id === stockId);
        const grouped = groups.reduce((sum, group) => sum + group.quantity_on_hand, 0);
        this.stockGroups.overview = { stockId, status: 'ready', groups,
          ungrouped: variant ? Math.max(0, variant.quantity_on_hand - grouped) : 0 };
      } catch (_) {
        if (request === overviewRequest) this.stockGroups.overview = { ...snapshot, status: 'error' };
      }
    },
    async sgOpen(row) {
      const state = this.stockGroups;
      if (row?.vehicle_type === 'motorcycle' || state.saving) return;
      if (!row && this.stockTab === 'pilhas' && groupLoad) return groupLoad;
      const intent = ++opening;
      if (row) {
        this.sgChoose();
        state.stockId = '';
        state.query = row.measure || '';
      }
      this.stockTab = 'pilhas';
      await this.sgLoad();
      if (row && intent === opening && this.stockTab === 'pilhas' && this.currentPage === 'estoque' && !state.error) {
        // Só fichas antigas sem ID usam a chave composta. Códigos de produto distintos podem pertencer à mesma variante.
        const ids = new Set(state.stock.filter(candidate => row.stock_id ? candidate.stock_id === row.stock_id
          : this.stockVariantKey(candidate) === this.stockVariantKey(row)).map(candidate => candidate.stock_id));
        state.stockId = ids.size === 1 ? [...ids][0] : '';
        this.$nextTick(() => {
          if (intent === opening && this.stockTab === 'pilhas' && this.currentPage === 'estoque') document.getElementById('galpao-pilha-variante')?.focus();
        });
      }
    },
    async sgLoad(afterWrite = false) {
      const state = this.stockGroups;
      if (groupLoad) {
        if (!afterWrite) return groupLoad;
        await groupLoad;
        return this.sgLoad();
      }
      state.loading = true;
      state.error = '';
      groupLoad = (async () => {
        try {
          const data = await this.apiGet(endpoint);
          state.groups = Array.isArray(data.groups) ? data.groups : [];
          state.stock = Array.isArray(data.stock) ? data.stock : [];
          if (!this.sgStock()) { state.stockId = ''; this.sgChoose(); }
          if (state.groupId) this.sgEdit(this.sgActive());
          await this.sgOrigins();
        } catch (_) { state.error = 'Não foi possível consultar as pilhas do galpão.'; }
      })();
      try { await groupLoad; } finally { groupLoad = null; state.loading = false; }
    },
    async sgOrigins() {
      const host = document.getElementById('galpao-origens-pendentes');
      if (!host) return;
      try {
        const { rows } = await this.apiGet(origins);
        window.StockOrigin.render(host,rows,{showOrder:true,
          save:this.adminUser?.role === 'owner' ? (p,body) => this.apiPost(origins + '/' + p.id,body) : null,
          onSaved:async() => { await this.sgLoad(true); this.stockGroups.message='Origem confirmada. O saldo total já estava contabilizado.'; },
          refresh:() => this.sgOrigins()});
      } catch (_) { host.textContent = 'Não foi possível consultar as origens pendentes. Use Atualizar para conferir.'; }
    },
    async sgAfterSale(orderId, wholesale = false) {
      if (!orderId || this.adminUser?.role !== 'owner') return;
      const load = () => this.apiGet(origins + (wholesale ? '?order_number=' : '?order_id=') + encodeURIComponent(orderId));
      let data;
      try { data = await load(); } catch (_) { return; }
      if (!data.rows?.length || !this.adminAuthenticated) return;
      const dialog = document.createElement('dialog'), host = document.createElement('div'), close = document.createElement('button');
      dialog.className = 'origin-dialog'; dialog.setAttribute('aria-label','Origem dos pneus da venda');
      close.type = 'button'; close.textContent = 'Fechar'; close.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => dialog.remove(), {once:true});
      const draw = rows => window.StockOrigin.render(host,rows,{showOrder:true,onDefer:() => dialog.close(),
        save:(p,body) => this.apiPost(origins + '/' + p.id, body),
        refresh:async() => { try { draw((await load()).rows); } catch (_) { host.textContent='Consulte a pendência em Estoque → Pilhas e conjuntos.'; } }});
      draw(data.rows); dialog.append(host,close); document.body.appendChild(dialog); dialog.showModal();
    },
    sgChoose() {
      Object.assign(this.stockGroups, { groupId: null, form: null, move: null, error: '', message: '' });
    },
    sgNew() {
      const products = this.sgProducts();
      if (!products.length) return;
      this.sgChoose();
      this.stockGroups.form = {
        product_id: products.length === 1 ? products[0].product_id : '',
        model: '', modelEdited: false,
        inspection_status: 'located', matched_set: false, conservation_grade: '', conservation_note: '',
        reason: '', positions: [{ location_code: '', quantity: '' }],
      };
      this.sgUseCatalogModel(this.stockGroups.form.product_id);
    },
    sgUseCatalogModel(productId) {
      const { form, groupId } = this.stockGroups;
      if (!form || groupId || form.modelEdited) return;
      const pattern = this.sgProducts().find(product => product.product_id === productId)?.tread_pattern?.trim() || '';
      form.model = pattern.length <= 120 ? pattern : '';
    },
    sgPositionRows() {
      const rows = this.sgRows().flatMap(group => {
        const positions = group.positions.length ? group.positions : [null];
        return positions.map(position => ({ group, position, key: group.group_id + '/' + (position?.location_code || '') }));
      });
      return rows.sort((left, right) => {
        if (!left.position || !right.position) return Number(!!right.position) - Number(!!left.position);
        return left.position.location_code.localeCompare(right.position.location_code, 'pt-BR', { numeric: true });
      });
    },
    sgEdit(group) {
      const state = this.stockGroups;
      if (!group) { this.sgChoose(); return; }
      state.groupId = group.group_id;
      state.form = { product_id: group.product_id, model: group.model || '', inspection_status: group.inspection_status,
        matched_set: group.matched_set, conservation_grade: group.conservation_grade || '',
        conservation_note: group.conservation_note || '', reason: '' };
      state.move = { from_location: '', to_location: '', quantity: '', reason: '' };
      state.error = '';
      state.message = '';
    },
    sgInspectionChanged() {
      const form = this.stockGroups.form;
      if (form.inspection_status !== 'approved') {
        form.matched_set = false;
        form.conservation_grade = '';
      }
    },
    async sgWrite(path, body, action) {
      const state = this.stockGroups;
      if (state.saving) return;
      const target = JSON.stringify(body);
      const operation = window.PAINEL_INTEGRITY.operation(action, target);
      state.saving = true;
      state.error = '';
      state.message = '';
      try {
        const result = await this.apiPost(path, { ...body, idempotency_key: operation.key });
        window.PAINEL_INTEGRITY.complete(action, target);
        state.groupId = result.group_id;
        await this.sgLoad(true);
        state.message = action === 'stock-group-move' ? 'Movimentação registrada.' : (body.group_id ? 'Conferência atualizada.' : 'Posição registrada.');
      } catch (error) { state.error = messages[error.message] || 'Não foi possível confirmar. Tente novamente.'; }
      finally { state.saving = false; }
    },
    async sgSave() {
      const state = this.stockGroups;
      const group = this.sgActive();
      const form = state.form;
      if (!form || !form.product_id || form.reason.trim().length < 2) {
        state.error = 'Informe o produto e o motivo.';
        return;
      }
      if (form.matched_set && !form.model.trim()) { state.error = messages.stock_group_model_required; return; }
      const body = { stock_id: state.stockId, product_id: form.product_id, model: form.model.trim() || null,
        inspection_status: form.inspection_status, matched_set: form.matched_set === true,
        conservation_grade: form.conservation_grade || null, conservation_note: form.conservation_note.trim() || null,
        reason: form.reason.trim() };
      if (group) Object.assign(body, { group_id: group.group_id, revision: group.revision });
      else {
        body.positions = form.positions.filter(row => row.location_code || row.quantity !== '')
          .map(row => ({ location_code: row.location_code.trim().toUpperCase(), quantity: Number(row.quantity) }));
        if (!body.positions.length || body.positions.some(row => !row.location_code || !Number.isInteger(row.quantity) || row.quantity < 1)) {
          state.error = 'Informe ao menos uma pilha e a quantidade física de pneus nela.';
          return;
        }
      }
      await this.sgWrite(endpoint, body, 'stock-group-save');
    },
    async sgMove() {
      const state = this.stockGroups;
      const group = this.sgActive();
      if (!group || !state.move) return;
      const form = state.move;
      const from = form.from_location.toUpperCase() || null;
      const to = form.to_location.trim().toUpperCase() || null;
      const quantity = Number(form.quantity);
      if (!from && group.inspection_status === 'approved') {
        state.error = 'Selecione a pilha de origem para movimentar pneus já conferidos.';
        return;
      }
      if (from === to || !Number.isInteger(quantity) || quantity < 1 || form.reason.trim().length < 2) {
        state.error = 'Informe a origem e/ou o destino, uma quantidade e o motivo.';
        return;
      }
      await this.sgWrite(endpoint + '/' + encodeURIComponent(group.group_id) + '/move', {
        revision: group.revision, from_location: from, to_location: to, quantity, reason: form.reason.trim(),
      }, 'stock-group-move');
    },
  };
};
