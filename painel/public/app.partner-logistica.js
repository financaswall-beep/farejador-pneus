// Logística moderna da unidade. A máquina de estados e os efeitos em reserva,
// estoque e caixa continuam sendo decididos atomicamente no servidor.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerLogistica = function () {
  const views = new Set(['active', 'history']);
  const transitions = Object.freeze({
    pending: ['dispatched', 'failed'],
    dispatched: ['pending', 'delivered', 'failed'],
    delivered: [], failed: [],
  });
  return {
    partnerLogistica: {
      rows: [], summary: null, view: 'active', page: 1, limit: 30,
      total: 0, hasMore: false, loading: false, error: '', notice: '', request: 0,
      busca: '', filtro: 'all', busyId: '', actionError: '', selectedId: '', problemOpen: false,
      routeOrder: [], photoUrls: {}, photoOpen: false, photoUrl: '',
      form: { courier: '', payment: 'Pix', reason: '', returnReason: '' },
    },

    partnerLogisticaStorageKey() {
      const unit = this.panelPartnerSlug || this.panelWorkplace?.id || 'unit';
      return `farejador_partner_logistics_order_${unit}`;
    },

    partnerLogisticaLoadOrder() {
      if (typeof localStorage === 'undefined') return [];
      try {
        const value = JSON.parse(localStorage.getItem(this.partnerLogisticaStorageKey()) || '[]');
        return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
      } catch (_) { return []; }
    },

    partnerLogisticaSyncOrder() {
      const known = new Set(this.partnerLogistica.rows.map((row) => row.order_id));
      const saved = this.partnerLogisticaLoadOrder().filter((id) => known.has(id));
      const missing = this.partnerLogistica.rows
        .map((row) => row.order_id).filter((id) => !saved.includes(id));
      this.partnerLogistica.routeOrder = [...saved, ...missing];
    },

    partnerLogisticaPersistOrder() {
      if (typeof localStorage === 'undefined') return;
      try {
        localStorage.setItem(
          this.partnerLogisticaStorageKey(), JSON.stringify(this.partnerLogistica.routeOrder),
        );
      } catch (_) { /* a ordem continua válida nesta sessão */ }
    },

    async loadPartnerLogistica(options = {}) {
      if (!this.isPartnerPanel()
          || (!this.hasPanelModule('logistica') && !this.hasPanelModule('entregas'))) return;
      const state = this.partnerLogistica;
      const view = views.has(options.view) ? options.view : state.view;
      const page = Math.max(1, Number(options.page ?? state.page) || 1);
      const request = ++state.request;
      state.view = view; state.page = page; state.loading = true; state.error = '';
      try {
        const payload = await this.partnerApiGet(
          'operacao/entregas?view=' + view + '&page=' + page + '&limit=' + state.limit,
        );
        if (request !== state.request) return;
        state.rows = Array.isArray(payload.rows) ? payload.rows : [];
        state.summary = payload.summary ?? null;
        const pagination = payload.pagination ?? {};
        const responsePage = Number(pagination.page ?? page);
        const responseLimit = Number(pagination.limit ?? state.limit);
        const responseTotal = Number(pagination.total ?? state.rows.length);
        state.view = views.has(pagination.view) ? pagination.view : view;
        state.page = Number.isInteger(responsePage) && responsePage > 0 ? responsePage : page;
        state.limit = Number.isInteger(responseLimit) && responseLimit > 0
          ? Math.min(responseLimit, 100) : state.limit;
        state.total = Number.isFinite(responseTotal) && responseTotal >= 0
          ? responseTotal : state.rows.length;
        state.hasMore = pagination.has_more === true;
        this.partnerLogisticaSyncOrder();
        if (!state.rows.some((row) => row.order_id === state.selectedId)) {
          state.selectedId = state.rows[0]?.order_id || '';
        }
        this.partnerLogisticaSelect(this.partnerLogisticaSelected());
      } catch (_) {
        if (request === state.request) {
          state.rows = []; state.summary = null; state.total = 0; state.hasMore = false;
          state.selectedId = ''; state.error = 'Não foi possível carregar as entregas desta unidade.';
        }
      } finally {
        if (request === state.request) state.loading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    partnerLogisticaSetView(view) {
      this.partnerLogistica.filtro = 'all';
      return this.loadPartnerLogistica({ view: views.has(view) ? view : 'active', page: 1 });
    },

    partnerLogisticaSetPage(page) {
      return this.loadPartnerLogistica({ view: this.partnerLogistica.view, page });
    },

    partnerLogisticaSetFilter(filter) {
      const allowed = new Set(['all', 'pending', 'dispatched', 'delivered', 'failed']);
      this.partnerLogistica.filtro = allowed.has(filter) ? filter : 'all';
      const visible = this.partnerLogisticaOrdered();
      if (!visible.some((row) => row.order_id === this.partnerLogistica.selectedId)) {
        this.partnerLogistica.selectedId = visible[0]?.order_id || '';
        this.partnerLogisticaSelect(this.partnerLogisticaSelected());
      }
    },

    partnerLogisticaFiltered() {
      const state = this.partnerLogistica;
      const query = String(state.busca || '').trim().toLocaleLowerCase('pt-BR');
      return state.rows.filter((row) => {
        if (state.filtro !== 'all' && row.delivery_status !== state.filtro) return false;
        if (!query) return true;
        return [row.order_id, row.customer_name, row.customer_phone, row.delivery_address,
          row.delivery_courier, ...(row.items || []).map((item) => item.label)]
          .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(query);
      });
    },

    partnerLogisticaOrdered() {
      const rows = this.partnerLogisticaFiltered();
      if (this.partnerLogistica.view === 'history') return rows;
      const order = this.partnerLogistica.routeOrder;
      const rank = (id) => { const index = order.indexOf(id); return index < 0 ? 1e9 : index; };
      return [...rows].sort((a, b) => rank(a.order_id) - rank(b.order_id));
    },

    partnerLogisticaMoveOrder(row, direction) {
      if (!row || this.partnerLogistica.view !== 'active') return;
      const order = [...this.partnerLogistica.routeOrder];
      const index = order.indexOf(row.order_id); const target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return;
      [order[index], order[target]] = [order[target], order[index]];
      this.partnerLogistica.routeOrder = order; this.partnerLogisticaPersistOrder();
    },

    partnerLogisticaSelected() {
      return this.partnerLogistica.rows.find(
        (row) => row.order_id === this.partnerLogistica.selectedId,
      ) || null;
    },

    partnerLogisticaSelect(row) {
      if (!row) return;
      const state = this.partnerLogistica;
      state.selectedId = row.order_id; state.actionError = ''; state.problemOpen = false;
      state.form = {
        courier: row.delivery_courier || this.operatorLabel || '', payment: 'Pix',
        reason: '', returnReason: 'Retorno confirmado na unidade',
      };
      if (row.photo_request_id) this.partnerLogisticaLoadPhoto(row);
      this.$nextTick(() => lucide.createIcons());
    },

    partnerLogisticaStatus(row) {
      const labels = { pending: 'Preparando', dispatched: 'Em rota',
        delivered: 'Entregue', failed: 'Aguardando retorno' };
      if (row?.order_status === 'cancelled' && row?.delivery_status === 'failed') {
        return 'Retorno confirmado';
      }
      return labels[row?.delivery_status] || 'Status desconhecido';
    },

    partnerLogisticaStatusClass(row) {
      if (row?.order_status === 'cancelled') return 'bg-gray-100 text-gray-600';
      return { pending: 'bg-amber-50 text-amber-700', dispatched: 'bg-sky-50 text-sky-700',
        delivered: 'bg-emerald-50 text-emerald-800', failed: 'bg-rose-50 text-rose-700' }
        [row?.delivery_status] || 'bg-gray-100 text-gray-600';
    },

    partnerLogisticaTransitions(row) {
      if (!row || row.order_status === 'cancelled') return [];
      return transitions[row.delivery_status] || [];
    },

    partnerLogisticaCan(row, next) {
      return this.partnerLogisticaTransitions(row).includes(next);
    },

    partnerLogisticaReturnCount() {
      const authoritative = Number(this.partnerLogistica.summary?.returns);
      if (Number.isFinite(authoritative)) return authoritative;
      return this.partnerLogistica.rows.filter((row) =>
        row.delivery_status === 'failed' && row.order_status !== 'cancelled').length;
    },

    partnerLogisticaWithoutCourierCount() {
      return this.partnerLogistica.rows.filter((row) =>
        row.delivery_status === 'dispatched' && !row.delivery_courier).length;
    },

    partnerLogisticaCouriers() {
      return [...new Set([this.operatorLabel, ...this.partnerLogistica.rows.map(
        (row) => row.delivery_courier,
      )].map((name) => String(name || '').trim()).filter(Boolean))].slice(0, 12);
    },

    partnerLogisticaItems(row) {
      return (row?.items || []).map((item) => `${item.quantity}x ${item.label}`).join(' · ')
        || 'Itens não informados';
    },

    partnerLogisticaPhone(row) {
      const digits = String(row?.customer_phone || '').replace(/\D/g, '');
      return digits.length > 4 ? `(**) *****-${digits.slice(-4)}` : 'Não informado';
    },

    partnerLogisticaDate(row) {
      const value = row?.dispatched_at || row?.created_at;
      if (!value) return '—';
      return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
        .format(new Date(value));
    },

    async partnerLogisticaMove(row, next, input = {}) {
      const state = this.partnerLogistica;
      if (!row?.order_id || state.busyId || !this.partnerLogisticaCan(row, next)) return false;
      const courier = String(input.delivery_courier || row.delivery_courier || '').trim() || null;
      const payment = String(input.payment_method || '').trim();
      const reason = String(input.reason || '').trim();
      if (next === 'dispatched' && !courier) {
        state.actionError = 'Informe quem vai fazer a entrega.'; return false;
      }
      if (next === 'delivered' && !payment) {
        state.actionError = 'Informe como o cliente pagou.'; return false;
      }
      if (next === 'failed' && reason.length < 3) {
        state.actionError = 'Informe o motivo da entrega não realizada.'; return false;
      }
      state.busyId = row.order_id; state.actionError = '';
      try {
        await this.partnerApiWrite('entregas/' + encodeURIComponent(row.order_id), 'POST', {
          delivery_status: next, delivery_courier: courier,
          payment_method: next === 'delivered' ? payment : null,
          reason: next === 'failed' ? reason : null,
        });
        state.notice = next === 'delivered'
          ? 'Entrega concluída: estoque e caixa foram confirmados pelo servidor.'
          : next === 'failed'
            ? 'Problema registrado. A reserva fica protegida até o pneu voltar à loja.'
            : 'Status da entrega atualizado.';
        await this.loadPartnerLogistica({ view: 'active', page: 1 }); return true;
      } catch (error) {
        state.actionError = error?.code === 'reserva_insuficiente'
          ? 'A reserva não está íntegra; nada foi baixado.'
          : error?.message || 'Não foi possível atualizar a entrega.';
        return false;
      } finally { state.busyId = ''; }
    },

    async partnerLogisticaConfirmReturn(row, reason = '') {
      const state = this.partnerLogistica;
      if (!row?.order_id || state.busyId || row.delivery_status !== 'failed'
          || row.order_status === 'cancelled') return false;
      state.busyId = row.order_id; state.actionError = '';
      try {
        await this.partnerApiWrite(
          'entregas/' + encodeURIComponent(row.order_id) + '/confirmar-retorno',
          'POST', { reason: String(reason || '').trim() || null },
        );
        state.notice = 'Retorno confirmado; a reserva foi liberada sem entrada no caixa.';
        await this.loadPartnerLogistica({ view: 'active', page: 1 }); return true;
      } catch (error) {
        state.actionError = error?.message || 'Não foi possível confirmar o retorno.';
        return false;
      } finally { state.busyId = ''; }
    },

    async partnerLogisticaLoadPhoto(row) {
      const id = row?.photo_request_id;
      if (!id || this.partnerLogistica.photoUrls[id]) return;
      try {
        const blob = await this.partnerApiBlob('operacao/entregas/fotos/' + encodeURIComponent(id));
        this.partnerLogistica.photoUrls = {
          ...this.partnerLogistica.photoUrls, [id]: URL.createObjectURL(blob),
        };
      } catch (_) { /* a foto nunca bloqueia o fluxo físico */ }
    },

    partnerLogisticaOpenPhoto(row) {
      const url = this.partnerLogistica.photoUrls[row?.photo_request_id];
      if (!url) return;
      this.partnerLogistica.photoUrl = url; this.partnerLogistica.photoOpen = true;
    },

    partnerLogisticaClosePhoto() {
      this.partnerLogistica.photoOpen = false; this.partnerLogistica.photoUrl = '';
    },
  };
};
