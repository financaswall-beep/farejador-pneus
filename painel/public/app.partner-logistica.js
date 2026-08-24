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
      busca: '', filtro: 'all', busyId: '', actionError: '',
      photoUrls: {}, photoOpen: false, photoUrl: '',
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
      } catch (_) {
        if (request === state.request) {
          state.rows = []; state.summary = null; state.total = 0; state.hasMore = false;
          state.error = 'Não foi possível carregar as entregas desta unidade.';
        }
      } finally {
        if (request === state.request) state.loading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    partnerLogisticaSetView(view) {
      return this.loadPartnerLogistica({
        view: views.has(view) ? view : 'active', page: 1,
      });
    },

    partnerLogisticaSetPage(page) {
      return this.loadPartnerLogistica({ view: this.partnerLogistica.view, page });
    },

    partnerLogisticaFiltered() {
      const state = this.partnerLogistica;
      const query = String(state.busca || '').trim().toLocaleLowerCase('pt-BR');
      return state.rows.filter((row) => {
        if (state.filtro !== 'all' && row.delivery_status !== state.filtro) return false;
        if (!query) return true;
        return [
          row.order_id, row.customer_name, row.customer_phone, row.delivery_address,
          row.delivery_courier, ...(row.items || []).map((item) => item.label),
        ].filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(query);
      });
    },

    partnerLogisticaStatus(row) {
      const labels = {
        pending: 'Preparando', dispatched: 'Saiu para entrega',
        delivered: 'Entregue', failed: 'Aguardando retorno',
      };
      if (row?.order_status === 'cancelled' && row?.delivery_status === 'failed') {
        return 'Retorno confirmado';
      }
      return labels[row?.delivery_status] || 'Status desconhecido';
    },

    partnerLogisticaTransitions(row) {
      if (!row || row.order_status === 'cancelled') return [];
      return transitions[row.delivery_status] || [];
    },

    partnerLogisticaCan(row, next) {
      return this.partnerLogisticaTransitions(row).includes(next);
    },

    async partnerLogisticaMove(row, next, input = {}) {
      const state = this.partnerLogistica;
      if (!row?.order_id || state.busyId || !this.partnerLogisticaCan(row, next)) return false;
      const courier = String(input.delivery_courier || row.delivery_courier || '').trim() || null;
      const payment = String(input.payment_method || '').trim();
      const reason = String(input.reason || '').trim();
      if (next === 'delivered' && !payment) {
        state.actionError = 'Informe como o cliente pagou.';
        return false;
      }
      if (next === 'failed' && reason.length < 3) {
        state.actionError = 'Informe o motivo da entrega não realizada.';
        return false;
      }
      state.busyId = row.order_id; state.actionError = '';
      try {
        await this.partnerApiWrite(
          'entregas/' + encodeURIComponent(row.order_id), 'POST', {
            delivery_status: next, delivery_courier: courier,
            payment_method: next === 'delivered' ? payment : null,
            reason: next === 'failed' ? reason : null,
          },
        );
        state.notice = next === 'delivered'
          ? 'Entrega concluída: estoque e caixa foram confirmados pelo servidor.'
          : next === 'failed'
            ? 'Falha registrada. A reserva fica protegida até o retorno físico.'
            : 'Status da entrega atualizado.';
        await this.loadPartnerLogistica({ view: 'active', page: 1 });
        return true;
      } catch (error) {
        state.actionError = error?.code === 'reserva_insuficiente'
          ? 'A reserva não está íntegra; nada foi baixado.'
          : error?.message || 'Não foi possível atualizar a entrega.';
        return false;
      } finally {
        state.busyId = '';
      }
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
        state.notice =
          'Retorno físico confirmado; a reserva foi liberada sem entrada no caixa.';
        await this.loadPartnerLogistica({ view: 'active', page: 1 });
        return true;
      } catch (error) {
        state.actionError = error?.message || 'Não foi possível confirmar o retorno.';
        return false;
      } finally {
        state.busyId = '';
      }
    },

    async partnerLogisticaLoadPhoto(row) {
      const id = row?.photo_request_id;
      if (!id || this.partnerLogistica.photoUrls[id]) return;
      try {
        const blob = await this.partnerApiBlob(
          'operacao/entregas/fotos/' + encodeURIComponent(id),
        );
        this.partnerLogistica.photoUrls = {
          ...this.partnerLogistica.photoUrls, [id]: URL.createObjectURL(blob),
        };
      } catch (_) {
        // A foto apoia a separação, mas nunca bloqueia o fluxo físico.
      }
    },

    partnerLogisticaOpenPhoto(row) {
      const url = this.partnerLogistica.photoUrls[row?.photo_request_id];
      if (!url) return;
      this.partnerLogistica.photoUrl = url;
      this.partnerLogistica.photoOpen = true;
    },

    partnerLogisticaClosePhoto() {
      this.partnerLogistica.photoOpen = false;
      this.partnerLogistica.photoUrl = '';
    },
  };
};
