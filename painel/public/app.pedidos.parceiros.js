// Obra 300 (2026-07-05): fatia do painel da MATRIZ — pedido manual + novo parceiro + candidaturas (Etapa 3).
// VERBATIM das linhas 2098-2248 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.pedidosParceiros = function () {
  return {
    async submitManualOrder() {
      if (this.orderSubmitting) return;
      if (!this.saleForm.product_id) {
        this.orderError = 'Escolha um produto do catalogo.';
        return;
      }
      if (this.saleForm.fulfillment_mode === 'delivery' && !this.saleForm.delivery_address.trim()) {
        this.orderError = 'Informe o endereco de entrega ou troque para retirada.';
        return;
      }

      const items = [{
        product_id: this.saleForm.product_id,
        quantity: Number(this.saleForm.quantity || 1),
        unit_price: Number(this.saleForm.unit_price || 0),
      }];
      const deliveryAddress = this.saleForm.fulfillment_mode === 'delivery'
        ? this.saleForm.delivery_address
        : null;

      this.orderSubmitting = true;
      this.orderError = null;

      try {
        if (this.modalConv) {
          await this.apiPost('/admin/api/orders/register-manual', {
            conversation_id: this.modalConv.id,
            draft_id: this.modalConv.draft_id || null,
            items,
            payment_method: this.saleForm.payment_method || null,
            fulfillment_mode: this.saleForm.fulfillment_mode,
            delivery_address: deliveryAddress,
            idempotency_key: this.saleForm.idempotency_key,
            source_tag: this.saleForm.source_tag || null,
          });
        } else {
          await this.apiPost('/admin/api/orders/register-walkin', {
            customer_name: this.saleForm.customer_name?.trim() || null,
            customer_phone: this.saleForm.customer_phone?.trim() || null,
            items,
            payment_method: this.saleForm.payment_method || null,
            fulfillment_mode: this.saleForm.fulfillment_mode,
            delivery_address: deliveryAddress,
            idempotency_key: this.saleForm.idempotency_key,
            source_tag: this.saleForm.source_tag || 'walkin_balcao',
          });
        }

        this.saleModalOpen = false;
        await this.loadRealData();
        void this.loadVarejoResumo(); // venda nova entra nos cards do varejo (0117)
      } catch (err) {
        this.orderError = err instanceof Error ? err.message : String(err);
      } finally {
        this.orderSubmitting = false;
      }
    },

    openPartnerModal() {
      this.partnerError = null;
      this.partnerResult = null;
      this.partnerForm = { trade_name: '', responsible_name: '', whatsapp_phone: '', email: '', address: '', commission_percent: '', municipios: '', slug: '' };
      this.partnerModalOpen = true;
    },

    async submitNewPartner() {
      if (this.partnerSubmitting) return;
      if (!this.partnerForm.trade_name.trim()) { this.partnerError = 'Informe o nome do parceiro.'; return; }
      const municipios = this.partnerForm.municipios.split(',').map((s) => s.trim()).filter(Boolean);
      if (municipios.length === 0) { this.partnerError = 'Informe ao menos uma cidade de cobertura.'; return; }
      this.partnerSubmitting = true;
      this.partnerError = null;
      try {
        const result = await this.apiPost('/admin/api/partners', {
          trade_name: this.partnerForm.trade_name.trim(),
          responsible_name: this.partnerForm.responsible_name.trim() || null,
          whatsapp_phone: this.partnerForm.whatsapp_phone.trim() || null,
          email: this.partnerForm.email.trim() || null,
          address: this.partnerForm.address.trim() || null,
          commission_percent: this.partnerForm.commission_percent === '' ? null : Number(this.partnerForm.commission_percent),
          municipios,
          slug: this.partnerForm.slug.trim() || null,
        });
        this.partnerResult = result; // { slug, token, ... } — token (login) mostrado UMA vez
        await this.loadRealData();
      } catch (err) {
        this.partnerError = err instanceof Error ? err.message : String(err);
      } finally {
        this.partnerSubmitting = false;
      }
    },

    // ── Etapa 3: candidaturas de parceiro ──
    async loadApplications() {
      if (!this.adminAuthenticated) return;
      this.applicationsLoading = true;
      try {
        const payload = await this.apiGet('/admin/api/partner-applications?status=pending');
        this.applications = Array.isArray(payload) ? payload : (payload.rows || []);
      } catch (err) {
        this.applications = [];
      } finally {
        this.applicationsLoading = false;
      }
    },

    async openApplications() {
      this.approvingApp = null;
      this.approveResult = null;
      this.approveError = null;
      this.applicationsModalOpen = true;
      await this.loadApplications();
    },

    startApprove(app) {
      this.approvingApp = app;
      this.approveResult = null;
      this.approveError = null;
      this.approveForm = { municipios: app.municipios || '', commission_percent: '', slug: '' };
    },

    async confirmApprove() {
      if (this.approveSubmitting || !this.approvingApp) return;
      const municipios = (this.approveForm.municipios || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (municipios.length === 0) { this.approveError = 'Informe ao menos uma cidade de cobertura.'; return; }
      this.approveSubmitting = true;
      this.approveError = null;
      try {
        const result = await this.apiPost(`/admin/api/partner-applications/${this.approvingApp.id}/approve`, {
          municipios,
          commission_percent: this.approveForm.commission_percent === '' ? null : Number(this.approveForm.commission_percent),
          slug: this.approveForm.slug.trim() || null,
        });
        this.approveResult = result; // { slug, token, ... } — login mostrado UMA vez
        await this.loadApplications();
      } catch (err) {
        this.approveError = err instanceof Error ? err.message : String(err);
      } finally {
        this.approveSubmitting = false;
      }
    },

    async rejectApplication(app) {
      try {
        await this.apiPost(`/admin/api/partner-applications/${app.id}/reject`, {});
        await this.loadApplications();
      } catch (err) {
        // silencioso — recusar é best-effort
      }
    },

  };
};
