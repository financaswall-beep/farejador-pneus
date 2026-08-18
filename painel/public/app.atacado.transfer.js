window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.atacadoTransfer = function () {
  return {
    atacadoBusinessInstant(date, today = this.finHoje(), nowIso = new Date().toISOString()) {
      return this.businessFactInstant(date, today, nowIso);
    },
    atacadoBuyerUnits() {
      const units = this.atacadoBuyerSelecionado()?.partner_units;
      return Array.isArray(units) ? units : [];
    },
    atacadoBuyerChanged() {
      const units = this.atacadoBuyerUnits();
      this.atacadoForm.receiving_unit_id = units.length === 1 ? units[0].partner_unit_id : '';
    },
    atacadoStartAddition(v) {
      if (!v || (v.status !== 'confirmed' && v.partner_transfer_status !== 'in_transit')) return;
      const rootId = v.parent_order_id || v.id;
      const root = this.atacadoVendas.find((row) => row.id === rootId) || v;
      this.atacadoForm = {
        buyerKey: `c:${root.buyer_id}`,
        newName: '', newPhone: '',
        notes: `Acréscimo do pedido ${String(rootId).slice(0, 8)}`,
        sold_at: this.finHoje(), payment_status: 'paid', payment_date: this.finHoje(),
        due_date: '', idempotency_key: '', parent_order_id: rootId,
        receiving_unit_id: root.partner_unit_id || '',
        items: [{ measure: '', brand: '', tire_condition: '', quantity: 1, unit_price: '' }],
      };
      this.vendaAtacadoSelecionada = null;
      this.vendasTab = 'atacado';
      this.atacadoMsg = { ok: true, text: 'Acréscimo aberto. Inclua somente os pneus extras desta saída.' };
      this.$nextTick(() => {
        document.getElementById('atacado-sale-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        window.lucide && window.lucide.createIcons();
      });
    },
    atacadoStopAddition() {
      this.atacadoForm = {
        buyerKey: '', newName: '', newPhone: '', notes: '', sold_at: '',
        payment_status: 'paid', payment_date: '', due_date: '', idempotency_key: '',
        parent_order_id: '', receiving_unit_id: '',
        items: [{ measure: '', brand: '', tire_condition: '', quantity: 1, unit_price: '' }],
      };
      this.atacadoMsg = null;
    },
    async loadAtacadoCargo() {
      const value = await this.apiGet('/admin/api/wholesale/cargo');
      this.atacadoCargo = (value.data || []).map((row) => ({ ...row, return_reason: '' }));
    },
    async atacadoOpenArrival(v) {
      if (!v || v.partner_transfer_status !== 'in_transit') return;
      this.vendaAtacadoSelecionada = null;
      try {
        await this.loadAtacadoCargo();
        this.atacadoArrival = {
          open: true, order: v, saving: false, error: null,
          items: (v.items || []).filter((item) => !item.source_cargo_lot_id).map((item) => ({
            ...item, accepted_quantity: Number(item.quantity),
          })),
          cargo: this.atacadoCargo.map((row) => ({
            ...row, take_quantity: 0, unit_price: '',
          })),
        };
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      } catch (error) {
        this.atacadoMsg = { ok: false, text: this.atacadoErrText(error.message) };
      }
    },
    atacadoArrivalRefused() {
      return (this.atacadoArrival.items || []).reduce((sum, item) => sum
        + Math.max(0, Number(item.quantity) - Number(item.accepted_quantity || 0)), 0);
    },
    atacadoArrivalTotal() {
      const itemCents = (this.atacadoArrival.items || []).reduce((sum, item) => sum
        + Number(item.accepted_quantity || 0) * Math.round(Number(item.unit_price || 0) * 100), 0);
      const cargoCents = (this.atacadoArrival.cargo || []).reduce((sum, item) => sum
        + Number(item.take_quantity || 0) * Math.round(Number(item.unit_price || 0) * 100), 0);
      return (itemCents + cargoCents) / 100;
    },
    async atacadoSubmitArrival() {
      const state = this.atacadoArrival;
      if (!state.order || state.saving) return;
      const invalidItem = state.items.some((item) => !Number.isInteger(Number(item.accepted_quantity))
        || Number(item.accepted_quantity) < 0
        || Number(item.accepted_quantity) > Number(item.quantity));
      const additions = state.cargo.filter((item) => Number(item.take_quantity) > 0);
      const invalidCargo = additions.some((item) => !Number.isInteger(Number(item.take_quantity))
        || Number(item.take_quantity) > Number(item.quantity_available)
        || !Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0);
      if (invalidItem || invalidCargo) {
        state.error = 'Confira as quantidades aceitas, os extras e os preços.';
        return;
      }
      const scope = state.order.id;
      const key = window.PAINEL_INTEGRITY.operation('partner-arrival-adjustment', scope).key;
      state.saving = true;
      state.error = null;
      try {
        const result = await this.apiPost(`/admin/api/wholesale/sales/${state.order.id}/arrival-adjustment`, {
          items: state.items.map((item) => ({
            order_item_id: item.id, accepted_quantity: Number(item.accepted_quantity),
          })),
          cargo_additions: additions.map((item) => ({
            cargo_lot_id: item.id, quantity: Number(item.take_quantity),
            unit_price: Number(item.unit_price),
          })),
          idempotency_key: key,
        });
        window.PAINEL_INTEGRITY.complete('partner-arrival-adjustment', scope);
        this.atacadoArrival.open = false;
        this.atacadoMsg = { ok: true, text: `Chegada acertada: ${result.accepted_units} pneu(s) ficaram com o parceiro; ${this.atacadoArrivalRefused()} recusado(s) continuam na carga.` };
        await this.loadAtacadoVendas();
      } catch (error) {
        state.error = this.atacadoErrText(error.message);
      } finally {
        state.saving = false;
      }
    },
    async atacadoReturnCargo(lot) {
      const reason = String(lot.return_reason || '').trim();
      if (reason.length < 2) {
        this.atacadoMsg = { ok: false, text: 'Informe o motivo do retorno físico ao galpão.' };
        return;
      }
      const scope = lot.id;
      const key = window.PAINEL_INTEGRITY.operation('partner-cargo-return', scope).key;
      try {
        const result = await this.apiPost(`/admin/api/wholesale/cargo/${lot.id}/return`, {
          reason, idempotency_key: key,
        });
        window.PAINEL_INTEGRITY.complete('partner-cargo-return', scope);
        this.atacadoMsg = { ok: true, text: `${result.returned_quantity} pneu(s) voltaram fisicamente e já estão disponíveis no galpão.` };
        await this.loadAtacadoVendas();
      } catch (error) {
        this.atacadoMsg = { ok: false, text: this.atacadoErrText(error.message) };
      }
    },
    async atacadoSubmit() {
      if (this.adminUser?.role !== 'owner') {
        this.atacadoMsg = { ok: false, text: 'Somente o proprietário pode registrar vendas pelo painel administrativo.' };
        return;
      }
      const f = this.atacadoForm;
      const body = { items: [], notes: f.notes ? f.notes.trim() : null };
      const soldDate = f.sold_at || this.finHoje();
      if (soldDate > this.finHoje()) {
        this.atacadoMsg = { ok: false, text: 'A data da venda não pode estar no futuro.' };
        return;
      }
      const requestNow = new Date().toISOString();
      body.sold_at = this.atacadoBusinessInstant(soldDate, this.finHoje(), requestNow);
      if (f.parent_order_id) {
        body.parent_order_id = f.parent_order_id;
      } else if (f.buyerKey === 'new') {
        if (!f.newName.trim()) { this.atacadoMsg = { ok: false, text: 'Diga o nome do novo cliente.' }; return; }
        body.new_customer = { name: f.newName.trim(), phone: f.newPhone.trim() || null };
      } else if (f.buyerKey.startsWith('c:')) {
        body.customer_id = f.buyerKey.slice(2);
      } else if (f.buyerKey.startsWith('p:')) {
        body.partner_id = f.buyerKey.slice(2);
      } else {
        this.atacadoMsg = { ok: false, text: 'Escolha o borracheiro.' }; return;
      }
      const selectedBuyer = this.atacadoBuyerSelecionado();
      const units = this.atacadoBuyerUnits();
      if (selectedBuyer?.is_partner) {
        const unitId = f.receiving_unit_id || (units.length === 1 ? units[0].partner_unit_id : '');
        if (!unitId) {
          this.atacadoMsg = { ok: false, text: 'Escolha a unidade parceira que receberá os pneus.' };
          return;
        }
        body.partner_unit_id = unitId;
      }
      const items = f.items
        .filter((it) => it.measure && it.measure.trim() && Number(it.quantity) > 0)
        .map((it) => ({
          measure: it.measure.trim(),
          brand: it.brand && it.brand.trim() ? it.brand.trim() : null,
          tire_condition: it.tire_condition || null,
          quantity: Number(it.quantity),
          unit_price: Number(it.unit_price) || 0,
        }));
      if (items.length === 0) { this.atacadoMsg = { ok: false, text: 'Adicione ao menos um pneu (medida e quantidade).' }; return; }
      if (items.some((item) => !item.brand)) { this.atacadoMsg = { ok: false, text: 'Informe a marca de cada pneu.' }; return; }
      if (items.some((item) => !item.tire_condition)) {
        this.atacadoMsg = { ok: false, text: 'Selecione a condição de cada pneu.' };
        return;
      }
      body.items = items;
      if (this.atacadoFinance && f.payment_status === 'pending') {
        if (!f.due_date) {
          this.atacadoMsg = { ok: false, text: 'Informe o vencimento da venda fiada.' };
          return;
        }
        body.payment_status = 'pending';
        body.due_date = f.due_date;
      } else {
        body.payment_status = 'paid';
        if (!body.partner_unit_id) {
          const paidDate = f.payment_date || soldDate;
          if (paidDate > this.finHoje()) {
            this.atacadoMsg = { ok: false, text: 'A data do pagamento não pode estar no futuro.' };
            return;
          }
          body.paid_at = this.atacadoBusinessInstant(
            paidDate,
            this.finHoje(),
            paidDate === soldDate ? body.sold_at : requestNow,
          );
        }
      }
      const integrityScope = f.parent_order_id ? `addition:${f.parent_order_id}` : 'form';
      f.idempotency_key = f.idempotency_key
        || window.PAINEL_INTEGRITY.operation('wholesale-sale-create', integrityScope).key;
      body.idempotency_key = f.idempotency_key;
      this.atacadoSaving = true;
      this.atacadoMsg = null;
      try {
        const result = await this.apiPost('/admin/api/wholesale/sales', body);
        const fiadoTxt = result.partner_unit_id
          ? ' (PENDENTE — será confirmado no acerto da chegada)'
          : (body.payment_status === 'pending' ? ' (FIADO — foi pro a receber)' : '');
        const additionText = result.parent_order_id ? 'Acréscimo registrado' : 'Venda registrada';
        const receiptText = result.linked_partner_purchase_id
          ? ' A entrada já apareceu para o parceiro confirmar o recebimento.' : '';
        this.atacadoMsg = { ok: true, text: `${additionText} pra ${result.buyer_name} — ${this.formatCurrency(Number(result.total_amount))}${fiadoTxt}.${receiptText}` };
        window.PAINEL_INTEGRITY.complete('wholesale-sale-create', integrityScope);
        this.atacadoForm = {
          buyerKey: '', newName: '', newPhone: '', notes: '', sold_at: '',
          payment_status: 'paid', payment_date: '', due_date: '', idempotency_key: '',
          parent_order_id: '', receiving_unit_id: '',
          items: [{ measure: '', brand: '', tire_condition: '', quantity: 1, unit_price: '' }],
        };
        await this.loadAtacadoVendas();
      } catch (err) {
        this.atacadoMsg = { ok: false, text: this.atacadoErrText(err.message) };
      } finally {
        this.atacadoSaving = false;
      }
    },
  };
};
