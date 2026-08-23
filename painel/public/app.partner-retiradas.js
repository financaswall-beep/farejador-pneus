// Fila moderna de retiradas do parceiro. A tela apenas orquestra as rotas já
// auditadas; reserva, estoque, caixa, comissão e idempotência permanecem no servidor.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerRetiradas = function () {
  return {
    partnerRetiradasRows: [],
    partnerRetiradasLoading: false,
    partnerRetiradasError: '',
    partnerRetiradasNotice: '',
    partnerRetiradasSavingId: '',
    partnerRetiradasPayments: {},
    partnerRetiradasCancelId: null,
    partnerRetiradasCancelReason: '',
    partnerRetiradasPhotoUrls: {},
    partnerRetiradasPhotoOpen: false,
    partnerRetiradasPhotoUrl: '',

    async loadPartnerRetiradas() {
      if (!this.isPartnerPanel() || !this.hasPanelModule('retiradas')) return;
      const startedAt = performance.now();
      void this.partnerPanelTelemetry({
        page: 'retiradas', event_type: 'page_open', outcome: 'success',
      });
      this.partnerRetiradasLoading = true;
      this.partnerRetiradasError = '';
      try {
        const payload = await this.partnerApiGet('retiradas');
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        this.partnerRetiradasRows = rows;
        const nextPayments = { ...this.partnerRetiradasPayments };
        for (const row of rows) nextPayments[row.order_id] ||= 'Pix';
        this.partnerRetiradasPayments = nextPayments;
        if (this.hasPanelModule('batepapo')) {
          for (const row of rows) {
            if (row.photo_request_id) void this.partnerRetiradasLoadPhoto(row.photo_request_id);
          }
        }
        void this.partnerPanelTelemetry({
          page: 'retiradas', event_type: 'read', operation: 'load_pickups',
          outcome: 'success', duration_ms: Math.round(performance.now() - startedAt),
        });
      } catch (err) {
        this.partnerRetiradasError = this.partnerRetiradasErrorMessage(err);
        void this.partnerPanelTelemetry({
          page: 'retiradas', event_type: 'read', operation: 'load_pickups',
          outcome: 'error', status_code: err?.status || null,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: this.partnerPanelErrorCode(err),
        });
      } finally {
        this.partnerRetiradasLoading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    get partnerRetiradasCount() {
      return this.partnerRetiradasRows.length;
    },

    get partnerRetiradasAmount() {
      return this.partnerRetiradasRows.reduce(
        (sum, row) => sum + this.partnerRetiradasNumber(row.total_amount), 0,
      );
    },

    partnerRetiradasNumber(value) {
      const number = Number(value ?? 0);
      return Number.isFinite(number) ? number : 0;
    },

    partnerRetiradasItemsLabel(row) {
      const items = Array.isArray(row?.items) ? row.items : [];
      if (!items.length) return 'Itens não informados';
      return items.map((item) => {
        const quantity = this.partnerRetiradasNumber(item.quantity);
        const name = item.tire_size || item.item_name || 'item';
        const condition = item.tire_condition
          ? ` · ${String(item.tire_condition).replaceAll('_', ' ')}` : '';
        return `${quantity}× ${name}${condition}`;
      }).join(' · ');
    },

    partnerRetiradasIsTwoW(row) {
      return String(row?.source_tag || row?.source || '').trim().toLowerCase() === '2w';
    },

    partnerRetiradasPaymentFor(row) {
      return this.partnerRetiradasPayments[row.order_id] || 'Pix';
    },

    partnerRetiradasSetPayment(orderId, payment) {
      this.partnerRetiradasPayments = {
        ...this.partnerRetiradasPayments, [orderId]: payment,
      };
    },

    async partnerRetiradasConfirm(row) {
      if (!row?.order_id || this.partnerRetiradasSavingId) return;
      const startedAt = performance.now();
      this.partnerRetiradasSavingId = row.order_id;
      this.partnerRetiradasError = '';
      this.partnerRetiradasNotice = '';
      try {
        await this.partnerApiWrite(`retiradas/${row.order_id}`, 'POST', {
          payment_method: this.partnerRetiradasPaymentFor(row),
        });
        this.partnerRetiradasRows = this.partnerRetiradasRows
          .filter((item) => item.order_id !== row.order_id);
        this.partnerRetiradasNotice = 'Retirada finalizada: estoque e caixa confirmados pelo servidor.';
        void this.partnerPanelTelemetry({
          page: 'retiradas', event_type: 'write', operation: 'confirm_pickup',
          outcome: 'success', duration_ms: Math.round(performance.now() - startedAt),
        });
        await this.loadPartnerRetiradas();
      } catch (err) {
        this.partnerRetiradasError = this.partnerRetiradasErrorMessage(err);
        void this.partnerPanelTelemetry({
          page: 'retiradas', event_type: 'write', operation: 'confirm_pickup',
          outcome: 'error', status_code: err?.status || null,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: this.partnerPanelErrorCode(err),
        });
      } finally {
        this.partnerRetiradasSavingId = '';
      }
    },

    partnerRetiradasOpenCancel(row) {
      this.partnerRetiradasCancelId = row.order_id;
      this.partnerRetiradasCancelReason = '';
      this.partnerRetiradasError = '';
    },

    partnerRetiradasCloseCancel() {
      this.partnerRetiradasCancelId = null;
      this.partnerRetiradasCancelReason = '';
    },

    async partnerRetiradasCancel(row) {
      if (!row?.order_id || this.partnerRetiradasSavingId) return;
      const reason = String(this.partnerRetiradasCancelReason || '').trim();
      if (this.partnerRetiradasIsTwoW(row) && !reason) {
        this.partnerRetiradasError = 'Informe o motivo do cancelamento deste pedido da Rede.';
        return;
      }
      const startedAt = performance.now();
      this.partnerRetiradasSavingId = row.order_id;
      this.partnerRetiradasError = '';
      this.partnerRetiradasNotice = '';
      try {
        await this.partnerApiWrite(`retiradas/${row.order_id}`, 'DELETE', { reason });
        this.partnerRetiradasRows = this.partnerRetiradasRows
          .filter((item) => item.order_id !== row.order_id);
        this.partnerRetiradasCloseCancel();
        this.partnerRetiradasNotice = 'Pedido cancelado: a reserva foi liberada sem entrada no caixa.';
        void this.partnerPanelTelemetry({
          page: 'retiradas', event_type: 'write', operation: 'cancel_pickup',
          outcome: 'success', duration_ms: Math.round(performance.now() - startedAt),
        });
        await this.loadPartnerRetiradas();
      } catch (err) {
        this.partnerRetiradasError = this.partnerRetiradasErrorMessage(err);
        void this.partnerPanelTelemetry({
          page: 'retiradas', event_type: 'write', operation: 'cancel_pickup',
          outcome: 'error', status_code: err?.status || null,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: this.partnerPanelErrorCode(err),
        });
      } finally {
        this.partnerRetiradasSavingId = '';
      }
    },

    partnerRetiradasErrorMessage(err) {
      const code = err?.code || err?.message;
      if (code === 'pickup_already_retrieved') return 'Esta retirada já foi finalizada.';
      if (code === 'reserva_insuficiente') return 'A reserva de estoque não está íntegra. Não houve baixa.';
      if (err?.status === 403) return 'Seu usuário não tem permissão para operar Retiradas.';
      return err?.message || 'Não foi possível concluir a operação.';
    },

    partnerRetiradasPhone(row) {
      return String(row?.customer_phone || '').replace(/\D/g, '');
    },

    partnerRetiradasWaLink(row) {
      let digits = this.partnerRetiradasPhone(row);
      if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
      const text = 'Olá! Seu pedido está reservado e pronto para retirada na loja.';
      return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : '#';
    },

    async partnerRetiradasLoadPhoto(photoRequestId) {
      if (!photoRequestId || this.partnerRetiradasPhotoUrls[photoRequestId]) return;
      try {
        const blob = await this.partnerApiBlob(`photo-requests/${photoRequestId}/image`);
        this.partnerRetiradasPhotoUrls = {
          ...this.partnerRetiradasPhotoUrls,
          [photoRequestId]: URL.createObjectURL(blob),
        };
      } catch (_) {
        // Foto é apoio visual. Falha/sem permissão não bloqueia a retirada.
      }
    },

    partnerRetiradasOpenPhoto(photoRequestId) {
      const url = this.partnerRetiradasPhotoUrls[photoRequestId];
      if (!url) return;
      this.partnerRetiradasPhotoUrl = url;
      this.partnerRetiradasPhotoOpen = true;
    },

    partnerRetiradasClosePhoto() {
      this.partnerRetiradasPhotoOpen = false;
      this.partnerRetiradasPhotoUrl = '';
    },
  };
};
