/**
 * app.entregas.js - fabrica `entregas` do painel do parceiro (obra <=300, passo 10/11).
 * MORA AQUI: a tela Entrega (rota do entregador) - deliveries/zonas/rota ordenavel
 * salva no aparelho (routeList/moveRoute/persistRouteOrder) + labels de status/itens;
 * e a tela Retiradas (pickup do bot) - fila pickupAwaiting (feed proprio), marcar
 * retirado (POST retiradas/:id) e cancelar com motivo (2W exige motivo).
 * NAO MORA AQUI: aba Pedidos/criacao e setDeliveryStatus (app.pedidos.js).
 * VEIO DE: app.js commit 29e9817 (ranges 623-713, 880-930), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.entregas = () => ({
    // ─── ENTREGA ──────────────────────────────────────────────
    // Toda venda marcada como entrega (deriva das vendas ja carregadas).
    get deliveriesAll() {
      return this.activeSales.filter((sale) => sale.fulfillment_mode === 'delivery');
    },

    // Em aberto = pendente + saiu; "entregues" quando o filtro pede.
    get deliveries() {
      return this.deliveriesAll.filter((d) => this.deliveryShowDone
        ? d.delivery_status === 'delivered'
        : d.delivery_status !== 'delivered');
    },

    get deliveryOpenCount() {
      return this.deliveriesAll.filter((d) => d.delivery_status !== 'delivered').length;
    },

    // Agrupa por bairro/regiao extraido do endereco ("rua, num - bairro - cidade").
    get deliveriesByZone() {
      const groups = {};
      for (const d of this.deliveries) {
        const label = this.deliveryZone(d);
        (groups[label] = groups[label] || []).push(d);
      }
      return Object.keys(groups)
        .sort((a, b) => a.localeCompare(b, 'pt-BR'))
        .map((label) => ({ label, items: groups[label] }));
    },

    // Nomes de entregadores usados recentemente (sugestao no campo de texto livre).
    get recentCouriers() {
      const seen = [];
      for (const d of this.deliveriesAll) {
        const name = String(d.delivery_courier || '').trim();
        if (name && !seen.includes(name)) seen.push(name);
      }
      return seen.slice(0, 8);
    },

    deliveryZone(sale) {
      const addr = String(sale?.delivery_address || '').trim();
      if (!addr) return 'Sem endereço';
      const parts = addr.split(' - ').map((s) => s.trim()).filter(Boolean);
      return parts.length >= 2 ? parts[parts.length - 2] : 'Outras entregas';
    },

    // Lista da aba Entrega. Em aberto = ordem da rota (ajustável pelo entregador, salva no aparelho);
    // novos pedidos entram no fim. Finalizadas = mais recentes primeiro.
    get routeList() {
      const base = this.deliveries;
      if (this.deliveryShowDone) {
        return [...base].sort((a, b) => new Date(b.delivered_at || 0) - new Date(a.delivered_at || 0));
      }
      const order = this.routeOrder || [];
      const rank = (id) => { const i = order.indexOf(id); return i === -1 ? 1e9 : i; };
      return [...base].sort((a, b) => {
        const r = rank(a.order_id) - rank(b.order_id);
        if (r !== 0) return r;
        return new Date(a.created_at || 0) - new Date(b.created_at || 0);
      });
    },

    moveRoute(sale, dir) {
      const ids = this.routeList.map((d) => d.order_id);
      const i = ids.indexOf(sale.order_id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      this.routeOrder = ids;
      this.persistRouteOrder();
    },

    persistRouteOrder() {
      try { localStorage.setItem(`farejador_route_order_${this.slug}`, JSON.stringify(this.routeOrder)); }
      catch (e) { /* localStorage indisponível: ordem só nesta sessão */ }
    },

    deliveryStatusLabel(status) {
      if (status === 'dispatched') return 'Saiu pra entrega';
      if (status === 'delivered') return 'Finalizada';
      if (status === 'failed') return 'Não entregue';
      return 'Em separação';
    },

    deliveryItemsLabel(sale) {
      const items = Array.isArray(sale?.items) ? sale.items : [];
      if (!items.length) return 'Sem itens';
      return items
        .map((item) => `${this.num(item.quantity)}× ${item.tire_size || item.item_name || 'item'}`)
        .join(' · ');
    },

    // ─── Retirada reservada do bot (pickup): tela Retiradas ───
    // Deriva do feed PRÓPRIO this.retiradas (GET /api/retiradas, já filtrado no
    // servidor pra pickup aguardando) — não de this.vendas — pra o balconista que
    // só tem permissão 'retiradas' ver a fila sem precisar de 'vendas'.
    get pickupAwaiting() {
      return this.retiradas.filter((o) => o.fulfillment_mode === 'pickup' && o.awaiting_pickup && o.status !== 'cancelled');
    },
    get pickupAwaitingCount() { return this.pickupAwaiting.length; },
    get pickupAwaitingAmount() { return this.pickupAwaiting.reduce((s, o) => s + this.num(o.total_amount), 0); },
    isTwoW(sale) { return this.normalizeSource(sale && (sale.source_tag || sale.source)) === '2w'; },

    async markRetrieved(sale) {
      if (!sale || !sale.order_id) return;
      const action = `retrieve-${sale.order_id}`;
      const payment_method = this.pickupPayDrafts[sale.order_id] || 'Pix';
      this.saving = true; this.savingAction = action;
      try {
        await this.api(`retiradas/${sale.order_id}`, { method: 'POST', body: JSON.stringify({ payment_method }) });
        await this.loadData();
        this.flash('Retirada finalizada — pneu baixado e dinheiro no caixa.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    // Cancelar retirada com motivo (ex.: cliente reservou e não veio). 2W exige motivo (anti-trapaça).
    // Usa o endpoint de RETIRADAS (não vendas) pra o balconista que só tem 'retiradas' poder cancelar.
    openCancelOrder(sale) { this.cancelOpenId = sale.order_id; this.cancelReasonText = ''; },
    closeCancelOrder() { this.cancelOpenId = null; this.cancelReasonText = ''; },
    async confirmCancelOrder(sale) {
      if (!sale || !sale.order_id) return;
      const reason = (this.cancelReasonText || '').trim();
      if (this.isTwoW(sale) && !reason) {
        this.flash('Escreva o motivo do cancelamento (pedido da Rede 2W).');
        return;
      }
      const action = `cancel-${sale.order_id}`;
      this.saving = true; this.savingAction = action;
      try {
        await this.api(`retiradas/${sale.order_id}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
        await this.loadData();
        this.flash('Pedido cancelado — reserva liberada.');
        this.cancelOpenId = null; this.cancelReasonText = '';
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },
});
