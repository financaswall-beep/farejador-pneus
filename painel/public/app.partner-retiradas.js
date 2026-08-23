// Retiradas no casco unico. A interface e compartilhada; o transporte continua
// separado: ps_ usa rotas RLS do parceiro e ms_ usa rotas administrativas.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerRetiradas = function () {
  return {
    partnerRetiradasRows: [], partnerRetiradasLoading: false,
    partnerRetiradasError: '', partnerRetiradasNotice: '',
    partnerRetiradasSavingId: '', partnerRetiradasPayments: {},
    partnerRetiradasServices: {}, partnerRetiradasServiceCatalog: [],
    partnerRetiradasSelectedId: '', partnerRetiradasSearch: '',
    partnerRetiradasFilter: 'all', partnerRetiradasCancelId: null,
    partnerRetiradasCancelReason: '',
    partnerRetiradasPhotoUrls: {}, partnerRetiradasPhotoOpen: false,
    partnerRetiradasPhotoUrl: '',

    async loadPartnerRetiradas() {
      if (!this.hasPanelModule('retiradas')) return;
      const startedAt = performance.now();
      this.partnerRetiradasLoading = true; this.partnerRetiradasError = '';
      try {
        const payload = this.isPartnerPanel()
          ? await this.partnerApiGet('retiradas') : await this.apiGet('/admin/api/retiradas');
        this.partnerRetiradasRows = Array.isArray(payload.rows) ? payload.rows : [];
        this.partnerRetiradasServiceCatalog = Array.isArray(payload.service_catalog)
          ? payload.service_catalog : [];
        const payments = { ...this.partnerRetiradasPayments };
        const services = { ...this.partnerRetiradasServices };
        for (const row of this.partnerRetiradasRows) {
          payments[row.order_id] ||= 'Pix';
          // Recarregar adota a verdade mais recente do servidor (inclusive outro caixa).
          services[row.order_id] = (Array.isArray(row.pickup_services)
            ? row.pickup_services.map((item) => ({ ...item })) : []);
        }
        this.partnerRetiradasPayments = payments;
        this.partnerRetiradasServices = services;
        if (this.isPartnerPanel() && this.hasPanelModule('batepapo')) {
          for (const row of this.partnerRetiradasRows) {
            if (row.photo_request_id) void this.partnerRetiradasLoadPhoto(row.photo_request_id);
          }
        }
        if (!this.partnerRetiradasSelectedId && this.partnerRetiradasActiveRows[0]) {
          this.partnerRetiradasSelectedId = this.partnerRetiradasActiveRows[0].order_id;
        }
        if (this.isPartnerPanel()) void this.partnerPanelTelemetry({
          page: 'retiradas', event_type: 'read', operation: 'load_pickups', outcome: 'success',
          duration_ms: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        this.partnerRetiradasError = this.partnerRetiradasErrorMessage(error);
        if (this.isPartnerPanel()) void this.partnerPanelTelemetry({
          page: 'retiradas', event_type: 'read', operation: 'load_pickups', outcome: 'error',
          status_code: error?.status || null, error_code: this.partnerPanelErrorCode(error),
        });
      } finally {
        this.partnerRetiradasLoading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    partnerRetiradasNumber(value) {
      const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0;
    },
    partnerRetiradasStage(row) {
      if (row?.retrieved_at || (row?.status === 'paid' && row?.awaiting_pickup === false)) return 'completed';
      if (row?.pickup_installation_started_at) return 'installing';
      if (row?.pickup_arrived_at) return 'arrived';
      return 'waiting';
    },
    partnerRetiradasStageLabel(row) {
      return ({ waiting: 'Aguardando cliente', arrived: 'Na loja', installing: 'Em instalação',
        completed: 'Concluído' })[this.partnerRetiradasStage(row)];
    },
    partnerRetiradasStageIcon(row) {
      return ({ waiting: 'clock-3', arrived: 'store', installing: 'wrench',
        completed: 'circle-check' })[this.partnerRetiradasStage(row)];
    },
    partnerRetiradasStepReached(row, step) {
      const reached = ({ waiting: 0, arrived: 1, installing: 3, completed: 4 })[
        this.partnerRetiradasStage(row)
      ] ?? 0;
      const target = ({ arrived: 1, payment: 2, installing: 3, completed: 4 })[step] ?? 99;
      return reached >= target;
    },
    partnerRetiradasIsToday(value) {
      if (!value) return false;
      return new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
        === new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    },
    get partnerRetiradasActiveRows() {
      return this.partnerRetiradasRows.filter((row) => this.partnerRetiradasStage(row) !== 'completed');
    },
    get partnerRetiradasCount() { return this.partnerRetiradasActiveRows.length; },
    get partnerRetiradasAmount() {
      return this.partnerRetiradasActiveRows.reduce(
        (sum, row) => sum + this.partnerRetiradasNumber(row.total_amount), 0,
      );
    },
    get partnerRetiradasSummary() {
      const rows = this.partnerRetiradasRows;
      return {
        waiting: rows.filter((row) => this.partnerRetiradasStage(row) === 'waiting').length,
        // "Chegaram hoje" continua contando quem ja avancou para instalacao ou conclusao.
        arrived: rows.filter((row) => this.partnerRetiradasIsToday(row.pickup_arrived_at)).length,
        installing: rows.filter((row) => this.partnerRetiradasStage(row) === 'installing').length,
        completed: rows.filter((row) => this.partnerRetiradasStage(row) === 'completed'
          && this.partnerRetiradasIsToday(row.retrieved_at)).length,
      };
    },
    get partnerRetiradasFilteredRows() {
      const query = String(this.partnerRetiradasSearch || '').trim().toLowerCase();
      return this.partnerRetiradasRows.filter((row) => {
        const stage = this.partnerRetiradasStage(row);
        const matchesStage = this.partnerRetiradasFilter === 'all'
          || this.partnerRetiradasFilter === stage;
        const haystack = `${row.customer_name || ''} ${row.order_id || ''} ${this.partnerRetiradasItemsLabel(row)}`.toLowerCase();
        return matchesStage && (!query || haystack.includes(query));
      });
    },
    get partnerRetiradasSelected() {
      return this.partnerRetiradasRows.find((row) => row.order_id === this.partnerRetiradasSelectedId) || null;
    },
    partnerRetiradasSelect(row) { this.partnerRetiradasSelectedId = row.order_id; },
    partnerRetiradasItemsLabel(row) {
      const items = Array.isArray(row?.items) ? row.items.filter((item) => !item.pickup_service_code) : [];
      return items.length ? items.map((item) => `${this.partnerRetiradasNumber(item.quantity)}× ${item.tire_size || item.product_name || item.item_name || 'item'}${item.brand ? ` ${item.brand}` : ''}`).join(' · ') : 'Itens não informados';
    },
    partnerRetiradasPhone(row) { return String(row?.customer_phone || '').replace(/\D/g, ''); },
    partnerRetiradasIsTwoW(row) {
      return String(row?.source_tag || row?.source || '').trim().toLowerCase() === '2w';
    },
    partnerRetiradasWaLink(row) {
      let digits = this.partnerRetiradasPhone(row); if ([10, 11].includes(digits.length)) digits = `55${digits}`;
      return digits ? `https://wa.me/${digits}?text=${encodeURIComponent('Olá! Seu pedido está reservado e pronto para retirada na loja.')}` : '#';
    },
    partnerRetiradasPaymentFor(row) { return this.partnerRetiradasPayments[row.order_id] || 'Pix'; },
    partnerRetiradasSetPayment(orderId, payment) {
      this.partnerRetiradasPayments = { ...this.partnerRetiradasPayments, [orderId]: payment };
    },
    partnerRetiradasDraft(row) { return this.partnerRetiradasServices[row?.order_id] || []; },
    partnerRetiradasAddService(row) {
      const used = new Set(this.partnerRetiradasDraft(row).map((item) => item.code));
      const next = this.partnerRetiradasServiceCatalog.find((item) => !used.has(item.code));
      if (!next) return;
      this.partnerRetiradasServices = { ...this.partnerRetiradasServices,
        [row.order_id]: [...this.partnerRetiradasDraft(row),
          { code: next.code, charge_mode: 'courtesy', amount_cents: 0 }] };
    },
    partnerRetiradasRemoveService(row, index) {
      this.partnerRetiradasServices = { ...this.partnerRetiradasServices,
        [row.order_id]: this.partnerRetiradasDraft(row).filter((_, position) => position !== index) };
    },
    partnerRetiradasServiceLabel(code) {
      return this.partnerRetiradasServiceCatalog.find((item) => item.code === code)?.label || code;
    },
    partnerRetiradasServiceCodeUsed(row, code, ignoredIndex) {
      return this.partnerRetiradasDraft(row).some((item, index) => index !== ignoredIndex && item.code === code);
    },
    partnerRetiradasSetServiceMode(row, index, mode) {
      const draft = this.partnerRetiradasDraft(row).map((item, position) => position === index
        ? { ...item, charge_mode: mode, amount_cents: mode === 'courtesy' ? 0 : Math.max(item.amount_cents || 0, 100) } : item);
      this.partnerRetiradasServices = { ...this.partnerRetiradasServices, [row.order_id]: draft };
    },
    partnerRetiradasSetServiceAmount(row, index, value) {
      const cents = Math.max(0, Math.round(Number(String(value).replace(',', '.')) * 100) || 0);
      const draft = this.partnerRetiradasDraft(row).map((item, position) => position === index ? { ...item, amount_cents: cents } : item);
      this.partnerRetiradasServices = { ...this.partnerRetiradasServices, [row.order_id]: draft };
    },
    partnerRetiradasServiceTotal(row) {
      return this.partnerRetiradasDraft(row).reduce((sum, item) => sum + item.amount_cents, 0) / 100;
    },
    partnerRetiradasGrandTotal(row) {
      // Depois da confirmacao os servicos ja fazem parte de total_amount no banco.
      // Somar o rascunho outra vez exibiria um total maior somente na tela.
      const pendingServices = this.partnerRetiradasStage(row) === 'completed'
        ? 0 : this.partnerRetiradasServiceTotal(row);
      return this.partnerRetiradasNumber(row?.total_amount) + pendingServices;
    },
    async partnerRetiradasStageSave(row, stage) {
      if (!row?.order_id || this.partnerRetiradasSavingId) return;
      this.partnerRetiradasSavingId = row.order_id; this.partnerRetiradasError = '';
      const body = { stage, services: this.partnerRetiradasDraft(row) };
      try {
        if (this.isPartnerPanel()) await this.partnerApiWrite(`retiradas/${row.order_id}/stage`, 'PUT', body);
        else await this.apiPut(`/admin/api/retiradas/${row.order_id}/stage`, body);
        await this.loadPartnerRetiradas();
      } catch (error) { this.partnerRetiradasError = this.partnerRetiradasErrorMessage(error); }
      finally { this.partnerRetiradasSavingId = ''; }
    },
    async partnerRetiradasConfirm(row) {
      if (!row?.order_id || this.partnerRetiradasSavingId) return;
      this.partnerRetiradasSavingId = row.order_id; this.partnerRetiradasError = '';
      const body = { payment_method: this.partnerRetiradasPaymentFor(row), services: this.partnerRetiradasDraft(row) };
      try {
        if (this.isPartnerPanel()) await this.partnerApiWrite(`retiradas/${row.order_id}`, 'POST', body);
        else await this.apiPost(`/admin/api/orders/${row.order_id}/retrieve`, body);
        this.partnerRetiradasNotice = 'Atendimento concluído: serviços, estoque e caixa foram confirmados juntos.';
        await this.loadPartnerRetiradas();
      } catch (error) { this.partnerRetiradasError = this.partnerRetiradasErrorMessage(error); }
      finally { this.partnerRetiradasSavingId = ''; }
    },
    partnerRetiradasOpenCancel(row) { this.partnerRetiradasCancelId = row.order_id; this.partnerRetiradasCancelReason = ''; },
    partnerRetiradasCloseCancel() { this.partnerRetiradasCancelId = null; this.partnerRetiradasCancelReason = ''; },
    async partnerRetiradasCancel(row) {
      if (!row?.order_id || this.partnerRetiradasSavingId) return;
      const reason = String(this.partnerRetiradasCancelReason || '').trim();
      if (!reason) { this.partnerRetiradasError = 'Informe o motivo do cancelamento.'; return; }
      this.partnerRetiradasSavingId = row.order_id;
      try {
        if (this.isPartnerPanel()) await this.partnerApiWrite(`retiradas/${row.order_id}`, 'DELETE', { reason });
        else await this.apiPost(`/admin/api/orders/${row.order_id}/cancel`, { reason });
        this.partnerRetiradasCloseCancel(); this.partnerRetiradasSelectedId = '';
        this.partnerRetiradasNotice = 'Pedido cancelado: reserva liberada sem entrada no caixa.';
        await this.loadPartnerRetiradas();
      } catch (error) { this.partnerRetiradasError = this.partnerRetiradasErrorMessage(error); }
      finally { this.partnerRetiradasSavingId = ''; }
    },
    partnerRetiradasErrorMessage(error) {
      if ((error?.code || error?.message) === 'pickup_already_retrieved') return 'Esta retirada já foi finalizada.';
      if ((error?.code || error?.message) === 'reserva_insuficiente') return 'A reserva de estoque não está íntegra. Nada foi baixado.';
      if (error?.status === 403) return 'Seu usuário não tem permissão para operar Retiradas.';
      return error?.message || 'Não foi possível concluir a operação.';
    },
    async partnerRetiradasLoadPhoto(photoRequestId) {
      if (!photoRequestId || this.partnerRetiradasPhotoUrls[photoRequestId]) return;
      try {
        const blob = await this.partnerApiBlob(`photo-requests/${photoRequestId}/image`);
        this.partnerRetiradasPhotoUrls = { ...this.partnerRetiradasPhotoUrls,
          [photoRequestId]: URL.createObjectURL(blob) };
      } catch (_) {
        // Falha/sem permissão não bloqueia a retirada: foto é apoio visual.
      }
    },
    partnerRetiradasOpenPhoto(photoRequestId) {
      const url = this.partnerRetiradasPhotoUrls[photoRequestId]; if (!url) return;
      this.partnerRetiradasPhotoUrl = url; this.partnerRetiradasPhotoOpen = true;
    },
    partnerRetiradasClosePhoto() {
      this.partnerRetiradasPhotoOpen = false; this.partnerRetiradasPhotoUrl = '';
    },
  };
};
