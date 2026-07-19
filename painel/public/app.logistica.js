// Obra 300 (2026-07-05): fatia do painel da MATRIZ — logística (0121) leitura: cards, rota, datas D+1, deep-links.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.logistica = function () {
  return {
    async loadLogistica() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      try {
        const payload = await this.apiGet('/admin/api/logistica');
        // flag off → enabled:false → null (a tela mostra o aviso de dormente)
        this.logistica = payload && payload.enabled ? payload : null;
        if (this.logisticaRotaSelecionadaId && !this.logisticaRotaSelecionada()) {
          this.logisticaRotaSelecionadaId = null;
        }
        void this.loadReceiptThumbs();
      } catch (err) {
        // Erro de REDE não apaga a tela (mantém o dado anterior; lição da Onda 1).
        console.warn('logistica load falhou:', err.message);
      } finally {
        this.logisticaLoaded = true;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    // Miniaturas dos comprovantes: o endpoint exige Bearer, e <img src> não manda
    // header (levaria 401 — achado da banca 07-03). Busca com o token e vira blob URL.
    async loadReceiptThumbs() {
      const rotas = [...(this.logistica?.rotas_abertas || []), ...(this.logistica?.rotas_recentes || [])];
      const vivos = new Set();
      for (const t of rotas) for (const r of (t.receipts || [])) vivos.add(r.id);
      // revoga o que saiu de cena (rota antiga fora do top-10)
      for (const id of Object.keys(this.receiptUrls)) {
        if (!vivos.has(id)) { try { URL.revokeObjectURL(this.receiptUrls[id]); } catch (e) { /* já foi */ } delete this.receiptUrls[id]; }
      }
      for (const id of vivos) {
        if (this.receiptUrls[id]) continue;
        try {
          const resp = await fetch(`/admin/api/logistica/comprovantes/${id}/imagem`, { credentials: 'same-origin' });
          if (!resp.ok) continue;
          this.receiptUrls[id] = URL.createObjectURL(await resp.blob());
        } catch (e) { /* miniatura é cosmética; o dado da rota já está na tela */ }
      }
    },
    logisticaItens(d) {
      const items = Array.isArray(d?.items) ? d.items : [];
      if (!items.length) return 'Sem itens';
      return items.map((it) => `${Number(it.quantity)}× ${it.label}`).join(' · ');
    },
    logisticaStatusLabel(s) {
      if (s === 'dispatched') return 'Saiu pra entrega';
      if (s === 'delivered') return 'Entregue';
      if (s === 'failed') return 'Não entregue';
      return 'Em separação';
    },
    // Contato do card (paridade com o card de entrega do PARCEIRO, app.format.js):
    // deep-links custo ZERO — o entregador fala pelo WhatsApp/discador DELE (fora
    // da API Meta); Waze/Maps abrem navegação no endereço do cliente (sem chave/cota).
    toE164Phone(rawDigits) {
      const d = String(rawDigits || '').replace(/\D/g, '');
      if (!d) return null;
      if (d.length === 10 || d.length === 11) return `+55${d}`;
      return `+${d}`; // 12+ dígitos: assume que já veio com DDI
    },
    waLink(rawPhone, text) {
      const e164 = this.toE164Phone(rawPhone);
      if (!e164) return '#';
      const digits = e164.replace(/\D/g, '');
      const t = text ? `?text=${encodeURIComponent(text)}` : '';
      return `https://wa.me/${digits}${t}`;
    },
    deliveryAddr(d) {
      return String(d?.delivery_address || '').trim();
    },
    wazeNavUrl(d) {
      const addr = this.deliveryAddr(d);
      if (!addr) return '#';
      return `https://waze.com/ul?q=${encodeURIComponent(addr)}&navigate=yes`;
    },
    mapsNavUrl(d) {
      const addr = this.deliveryAddr(d);
      if (!addr) return '#';
      return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`;
    },
    rotaDoPedido(d) {
      if (!d?.trip_id || !this.logistica) return null;
      return (this.logistica.rotas_abertas || []).find((t) => t.id === d.trip_id)
        || (this.logistica.rotas_recentes || []).find((t) => t.id === d.trip_id) || null;
    },
    rotaKm(t) {
      if (t?.km_start == null || t?.km_end == null) return null;
      const km = Number(t.km_end) - Number(t.km_start);
      return Number.isFinite(km) && km >= 0 ? km : null;
    },
    logisticaDateISO(value) {
      if (!value) return '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(d);
    },
    logisticaPeriodoFinalISO() {
      const d = new Date(this.hojeISO() + 'T12:00:00-03:00');
      d.setUTCDate(d.getUTCDate() + 6);
      return this.logisticaDateISO(d);
    },
    logisticaDataOperacional(d) {
      if (d?.delivery_status === 'delivered' && d.delivered_at) return this.logisticaDateISO(d.delivered_at);
      return this.logisticaDateISO(d?.scheduled_date || d?.created_at);
    },
    logisticaDentroPeriodo(d) {
      const data = this.logisticaDataOperacional(d);
      if (!data) return true;
      if (this.logisticaPeriodo === 'amanha') return data === this.amanhaISO();
      if (this.logisticaPeriodo === '7dias') return data >= this.hojeISO() && data <= this.logisticaPeriodoFinalISO();
      return data === this.hojeISO();
    },
    logisticaPeriodoLabel() {
      if (this.logisticaPeriodo === 'amanha') return 'Amanhã';
      if (this.logisticaPeriodo === '7dias') return 'Próximos 7 dias';
      return 'Hoje';
    },
    setLogisticaPeriodo(periodo) {
      this.logisticaPeriodo = periodo;
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    setLogisticaFiltro(filtro, abrirEntregas = false) {
      this.logisticaFiltro = filtro;
      if (abrirEntregas) {
        this.logisticaTab = 'entregas';
        this.logisticaRotaSelecionadaId = null;
      }
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    setLogisticaTab(tab) {
      this.logisticaTab = tab;
      this.logisticaRotaSelecionadaId = null;
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    logisticaTodasEntregas() {
      const rows = [
        ...(this.logistica?.reportadas || []),
        ...(this.logistica?.abertas || []),
        ...(this.logistica?.finalizadas || []),
      ];
      const seen = new Set();
      return rows.filter((d) => {
        if (!d?.order_id || seen.has(d.order_id)) return false;
        seen.add(d.order_id);
        return true;
      });
    },
    logisticaBuscaMatch(d) {
      const q = String(this.logisticaBusca || '').trim().toLocaleLowerCase('pt-BR');
      if (!q) return true;
      const text = [d?.order_number, d?.order_id, d?.customer_name, d?.customer_phone, d?.delivery_address, this.logisticaItens(d)]
        .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR');
      return text.includes(q);
    },
    logisticaEntregasView() {
      let rows;
      if (this.logisticaFiltro === 'problemas') {
        return (this.logistica?.reportadas || []).filter((d) => this.logisticaBuscaMatch(d));
      }
      else {
        rows = [...(this.logistica?.abertas || []), ...(this.logistica?.reportadas || [])];
        if (this.logisticaFiltro === 'aguardando') rows = rows.filter((d) => d.delivery_status === 'pending');
        if (this.logisticaFiltro === 'rota') rows = rows.filter((d) => d.delivery_status === 'dispatched');
      }
      return rows.filter((d) => this.logisticaDentroPeriodo(d) && this.logisticaBuscaMatch(d));
    },
    logisticaFinalizadasView() {
      return (this.logistica?.finalizadas || []).filter((d) => this.logisticaDentroPeriodo(d) && this.logisticaBuscaMatch(d));
    },
    logisticaResumoCards() {
      const noPeriodo = this.logisticaTodasEntregas().filter((d) => this.logisticaDentroPeriodo(d));
      return {
        total: noPeriodo.length,
        aguardando: noPeriodo.filter((d) => d.delivery_status === 'pending').length,
        rota: noPeriodo.filter((d) => d.delivery_status === 'dispatched').length,
        problemas: (this.logistica?.reportadas || []).length,
      };
    },
    logisticaOrderLabel(d) {
      if (d?.order_number) return String(d.order_number).startsWith('#') ? d.order_number : `#${d.order_number}`;
      return d?.order_id ? `#${String(d.order_id).slice(0, 8).toUpperCase()}` : '—';
    },
    logisticaPagamentoLabel(d) {
      const value = String(d?.payment_method || '').trim();
      const labels = { pix: 'Pix', cash: 'Dinheiro', dinheiro: 'Dinheiro', card: 'Cartão', cartao: 'Cartão', 'pix_on_delivery': 'Pix na entrega', 'cash_on_delivery': 'Dinheiro na entrega' };
      return labels[value.toLowerCase()] || value || 'Não informado';
    },
    logisticaStatusClass(d) {
      if (d?.delivery_status === 'failed') return 'bg-rose-50 text-rose-700 border-rose-100';
      if (d?.delivery_status === 'dispatched') return 'bg-emerald-50 text-emerald-700 border-emerald-100';
      if (d?.delivery_status === 'delivered') return 'bg-emerald-50 text-emerald-700 border-emerald-100';
      return 'bg-amber-50 text-amber-700 border-amber-100';
    },
    logisticaRotaAtual() {
      return (this.logistica?.rotas_abertas || [])[0] || null;
    },
    logisticaEntregasDaRota(t) {
      if (!t?.id) return [];
      return this.logisticaTodasEntregas().filter((d) => d.trip_id === t.id);
    },
    logisticaRotaProgresso(t) {
      const rows = this.logisticaEntregasDaRota(t);
      const entregues = Number(t?.resumo?.entregues ?? rows.filter((d) => d.delivery_status === 'delivered').length);
      const total = Math.max(Number(t?.deliveries_count || 0), rows.length);
      return { entregues, total, percentual: total ? Math.round((entregues / total) * 100) : 0 };
    },
    logisticaRotaRestantes(t) {
      if (t?.remaining_count != null) return Number(t.remaining_count);
      return this.logisticaEntregasDaRota(t).filter((d) => d.delivery_status === 'pending' || d.delivery_status === 'dispatched').length;
    },
    logisticaRotaTotal(t) {
      if (t?.orders_total != null) return Number(t.orders_total);
      return this.logisticaEntregasDaRota(t).reduce((sum, d) => sum + Number(d.total_amount || 0), 0);
    },
    async logisticaStatus(d, status) {
      this.logisticaSaving = true;
      try {
        await this.apiPost('/admin/api/logistica/entregas/status', {
          order_id: d.order_id,
          status,
          courier: (this.logisticaCouriers[d.order_id] || d.delivery_courier || '').trim() || null,
          payment_method: status === 'delivered' ? (this.logisticaPays[d.order_id] || 'Pix') : null,
        });
        this.logisticaMsg = status === 'delivered'
          ? { ok: true, text: 'Entrega finalizada — pedido fechado.' }
          : { ok: true, text: 'Saiu pra entrega.' };
        await this.loadLogistica();
      } catch (err) {
        this.logisticaMsg = { ok: false, text: `Não consegui atualizar (${err.message}).` };
      } finally {
        this.logisticaSaving = false;
      }
    },
    logisticaFalhou(d) {
      this.logisticaDialog = { open: true, kind: 'delivery-failure', delivery: d, reason: '' };
      this.$nextTick(() => this.$refs.logisticaDialogReason?.focus());
    },
    fecharLogisticaDialog() {
      this.logisticaDialog = { open: false, kind: null, delivery: null, reason: '' };
    },
    async confirmarLogisticaDialog() {
      const dialog = this.logisticaDialog;
      if (!dialog?.open || !dialog.delivery) return;
      const reason = String(dialog.reason || '').trim();
      if (!reason) {
        this.logisticaMsg = { ok: false, text: 'Informe o motivo antes de confirmar.' };
        return;
      }
      this.fecharLogisticaDialog();
      this.logisticaSaving = true;
      try {
        await this.apiPost('/admin/api/logistica/entregas/falhou', {
          order_id: dialog.delivery.order_id,
          reason,
        });
        this.logisticaMsg = { ok: true, text: 'Marcado como não entregue — pedido cancelado e galpão recomposto.' };
        await this.loadLogistica();
        void this.loadSino();
      } catch (err) {
        this.logisticaMsg = { ok: false, text: `Não consegui marcar (${err.message}).` };
      } finally {
        this.logisticaSaving = false;
      }
    },
    entregasSemRota() {
      if (!this.logistica) return [];
      return (this.logistica.abertas || []).filter((d) => !d.trip_id);
    },
    // Rota aberta pra "pendurar" (a UI só deixa 1 aberta por vez).
    rotaAberta() {
      return (this.logistica?.rotas_abertas || [])[0] || null;
    },
    // ── Agendamento (07-03e): toda entrega nasce pra D+1; o dono remarca se precisar ──
    hojeISO() {
      return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    },
    amanhaISO() {
      const d = new Date(this.hojeISO() + 'T12:00:00-03:00'); d.setUTCDate(d.getUTCDate() + 1);
      return this.logisticaDateISO(d);
    },
    // Rótulo amigável da data prevista (hoje/amanhã/atrasada/dd-mm). Compara YYYY-MM-DD
    // como string (lexicográfico = cronológico). "Atrasada" só faz sentido antes de sair.
    dataEntregaLabel(d) {
      const dt = d?.scheduled_date; if (!dt) return '';
      const [, m, day] = dt.split('-'); const br = day + '/' + m;
      if (d.delivery_status === 'pending' && dt < this.hojeISO()) return 'atrasada · era ' + br;
      if (dt === this.hojeISO()) return 'pra hoje';
      if (dt === this.amanhaISO()) return 'pra amanhã';
      return 'pra ' + br;
    },
    dataEntregaClass(d) {
      const dt = d?.scheduled_date;
      if (d?.delivery_status === 'pending' && dt < this.hojeISO()) return 'bg-rose-50 text-rose-700';
      if (dt === this.hojeISO()) return 'bg-blue-50 text-blue-700';
      return 'bg-amber-50 text-amber-700';
    },
  }; };
