// Obra 300 (2026-07-05): fatia do painel da MATRIZ — logística (0121) leitura: cards, rota, datas D+1, deep-links.
// VERBATIM das linhas 1233-1405 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.logistica = function () {
  return {
    async loadLogistica() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;
      try {
        const payload = await this.apiGet('/admin/api/logistica');
        // flag off → enabled:false → null (a tela mostra o aviso de dormente)
        this.logistica = payload && payload.enabled ? payload : null;
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
          const resp = await fetch(`/admin/api/logistica/comprovantes/${id}/imagem`, { headers: { Authorization: `Bearer ${this.apiToken}` } });
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
    // "A rota se pagou?" — frete cobrado + lucro dos pneus (custo congelado 0117)
    // − despesas da rota. Componentes vêm do servidor; aqui SÓ soma e formata.
    rotaResumo(t) {
      const r = t?.resumo;
      if (!r) return null;
      const despesas = Number(t.despesas_total || 0);
      if (!r.entregues && !despesas) return null; // rota sem entrega e sem gasto: nada a dizer
      const frete = Number(r.frete_total || 0);
      const lucro = Number(r.lucro_pneus || 0);
      return {
        entregues: Number(r.entregues || 0),
        frete,
        lucro,
        despesas,
        resultado: Math.round((frete + lucro - despesas) * 100) / 100,
        semCusto: Number(r.itens_sem_custo || 0),
      };
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
    async logisticaFalhou(d) {
      const who = d.customer_name || 'este pedido';
      const reason = window.prompt(`Marcar a entrega de ${who} como NÃO entregue?\n\nEscreva o motivo (o pedido é cancelado e o pneu VOLTA pro galpão):`);
      if (reason === null) return;
      this.logisticaSaving = true;
      try {
        await this.apiPost('/admin/api/logistica/entregas/falhou', {
          order_id: d.order_id,
          reason: reason.trim() || null,
        });
        this.logisticaMsg = { ok: true, text: 'Marcado como não entregue — pedido cancelado e galpão recomposto.' };
        await this.loadLogistica();
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
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },
    amanhaISO() {
      const d = new Date(); d.setDate(d.getDate() + 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
  };
};
