// Fontes próprias do sino: atualizadas juntas, sem depender da página aberta.
// Marcar como lida não resolve a pendência; falhas preservam a última resposta.
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (mataria o getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.sino = function () {
  let navigation = 0;
  return {
    sinoComissoes: null, sinoApplications: [], sinoLoading: false,
    sinoError: null, sinoUpdatedAt: null, sinoScope: null, sinoRequest: 0,

    sinoCan(module) {
      return this.adminUser?.role === 'owner' || this.hasPanelModule(module);
    },
    sinoReadKey() {
      const user = this.adminUser;
      const id = user?.id || user?.username;
      return id && user.auth_type !== 'emergency' ? 'farejador_sino_lidas_v2:' + id : null;
    },
    sinoContext() {
      return JSON.stringify([this.sinoReadKey(), this.adminUser?.role, [...(this.panelModules || [])].sort()]);
    },
    resetSino() {
      navigation++;
      this.sinoRequest++;
      this.sino = null; this.sinoComissoes = null; this.sinoApplications = [];
      this.sinoLidas = []; this.sinoScope = null;
      this.sinoLoading = false; this.sinoError = null; this.sinoUpdatedAt = null;
    },
    get sinoStatus() {
      if (this.sinoLoading) return 'Atualizando alertas…';
      if (this.sinoError) return this.sinoError;
      return this.sinoUpdatedAt ? 'Alertas atualizados para seus acessos.' : 'Aguardando atualização dos alertas.';
    },
    get sinoEmpty() {
      return !!this.sinoUpdatedAt && !this.sinoLoading && !this.sinoError && this.notificacoes.length === 0;
    },
    async loadSino() {
      if (!this.adminAuthenticated || this.panelScope !== 'matrix'
          || !location.pathname.startsWith('/admin/painel')) { this.resetSino(); return; }
      const scope = this.sinoContext();
      if (scope !== this.sinoScope) {
        this.resetSino(); this.sinoScope = scope;
        try {
          const key = this.sinoReadKey();
          const saved = key ? JSON.parse(localStorage.getItem(key) || '[]') : [];
          this.sinoLidas = Array.isArray(saved) ? saved.filter(id => typeof id === 'string').slice(-100) : [];
        } catch (_) { this.sinoLidas = []; }
      }
      if (this.sinoLoading) return;
      const request = ++this.sinoRequest;
      this.sinoLoading = true; this.sinoError = null;
      const sources = [{ key: 'sino', path: '/admin/api/matriz/notificacoes' }];
      if (this.sinoCan('rede')) sources.push({ key: 'sinoComissoes', path: '/admin/api/rede/comissoes' });
      if (this.adminUser?.role === 'owner') sources.push({ key: 'sinoApplications', path: '/admin/api/partner-applications?status=pending' });
      const results = await Promise.allSettled(sources.map(async source => {
        let timer;
        try {
          const data = await Promise.race([this.apiGet(source.path), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('sino_timeout')), 12000);
          })]);
          if (!data || typeof data !== 'object') throw new Error('sino_invalid_response');
          if (source.key !== 'sinoApplications') return data;
          const rows = Array.isArray(data) ? data : data.rows;
          if (!Array.isArray(rows)) throw new Error('sino_invalid_response');
          return rows;
        } finally { clearTimeout(timer); }
      }));
      if (request !== this.sinoRequest) return;
      if (!this.adminAuthenticated || scope !== this.sinoContext() || this.panelScope !== 'matrix') {
        this.resetSino(); return;
      }
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') this[sources[i].key] = result.value;
        else {
          if (String(result.reason?.message) === 'api_403') this[sources[i].key] = sources[i].key === 'sinoApplications' ? [] : null;
          this.sinoError = 'Não foi possível atualizar todos os alertas. Os últimos dados disponíveis foram mantidos.';
        }
      });
      if (!this.sinoError) this.sinoUpdatedAt = new Date().toISOString();
      this.sinoLoading = false;
    },

    // A lista que o dropdown renderiza. Cada item tem um id-assinatura: se o
    // ESTADO muda (mais uma medida baixa, total do fiado cresceu), o id muda e
    // a notificação volta a contar como não lida — mudou = re-avisar.
    get notificacoes() {
      if (!this.adminAuthenticated || this.sinoScope !== this.sinoContext()) return [];
      const itens = [];
      const s = this.sino;
      if (s) {
        const expiry = s.bot_reservation_expiry_failures;
        if (expiry && expiry.count > 0) itens.push({
          id: 'bot-expiry-failed:' + expiry.count + ':' + expiry.orders.map(o => o.order_number).sort().join(','),
          icon: 'triangle-alert', iconBg: 'bg-rose-50', iconColor: 'text-rose-600',
          title: expiry.count + ' reserva(s) vencida(s) precisam de revisão',
          desc: 'A liberação falhou várias vezes. ' + expiry.orders.map(o => o.order_number + ' · ' + o.unit_name).join('; '),
          page: 'bot', section: 'vendas', time: 'conferir pedidos do Bot →',
        });
        const health = s.ledger_health;
        if (health && ['red','yellow','error'].includes(health.status)) itens.push({
          id: 'ledger-health:' + health.status + ':' + health.error_signals + ':' + health.pending_signals,
          icon: 'shield-alert', iconBg: 'bg-amber-50', iconColor: 'text-amber-600',
          title: health.status === 'error' ? 'Conferência financeira não concluída' : 'Conferência financeira precisa de atenção',
          desc: health.status === 'error' ? 'A conferência automática será tentada novamente.'
            : health.error_signals + ' divergência(s) e ' + health.pending_signals + ' pendência(s). Abra o Financeiro para conferir.',
          page: 'financeiro', time: 'abrir Financeiro →',
        });
        if (s.bot_reservations_expiring > 0) itens.push({
          id: 'bot-reservations:' + s.bot_reservations_expiring,
          icon: 'clock', iconBg: 'bg-amber-50', iconColor: 'text-amber-600',
          title: 'Reservas do bot perto de expirar',
          desc: s.bot_reservations_expiring + ' reserva(s) sem retirada. Confira antes da liberação automática.',
          page: 'retiradas', time: 'abrir Retiradas →',
        });
        if (s.normalization_failed > 0) itens.push({
          id: 'normalization-failed:' + s.normalization_failed,
          icon: 'message-circle', iconBg: 'bg-rose-50', iconColor: 'text-rose-600',
          title: 'Mensagens precisam de revisão',
          desc: s.normalization_failed + ' evento(s) não foram processados. Confira a ingestão e reprocesse após corrigir a causa.',
          page: 'bot', time: 'abrir Bot →',
        });
        const br = s.bot_resilience;
        if (br && br.enabled && (br.dead_letters > 0 || br.api_ack_unconfirmed > 0)) {
          itens.push({
            id: 'bot-resilience:' + br.dead_letters + ':' + br.api_ack_unconfirmed,
            icon: 'bot', iconBg: 'bg-rose-50', iconColor: 'text-rose-600',
            title: 'Bot precisa de revisão humana',
            desc: br.dead_letters + ' falha(s) final(is) e ' + br.api_ack_unconfirmed +
              ' envio(s) aceito(s) sem confirmação do webhook.',
            page: 'bot', section: 'conversas', time: 'abrir revisão do Bot →',
          });
        }
        for (const e of s.entregas_falhadas || []) {
          itens.push({
            id: 'falha:' + JSON.stringify([e.order_id, e.reason]),
            icon: 'truck', iconBg: 'bg-rose-50', iconColor: 'text-rose-600',
            title: 'Entrega não realizada — você decide',
            desc: (e.customer_name || 'Cliente') + (e.reason ? ' — "' + e.reason + '"' : '') +
              '. Recoloque na fila ou cancele.',
            page: 'logistica', orderId: e.order_id, time: 'revisar ocorrência →',
          });
        }
        const repor = s.galpao_repor || [];
        if (repor.length > 0) {
          const nomes = repor.slice(0, 3).map((m) => m.measure + ' · '
            + this.catalogoConditionLabel(m.tire_condition) + ' ('
            + m.quantity_on_hand + '/mín. ' + m.min_quantity + ')');
          itens.push({
            id: 'galpao:' + JSON.stringify(repor.map(m =>
              JSON.stringify([m.vehicle_type, m.measure, m.tire_condition, m.quantity_on_hand, m.min_quantity])).sort()),
            icon: 'package', iconBg: 'bg-amber-50', iconColor: 'text-amber-600',
            title: 'Galpão pra repor (' + repor.length + (repor.length === 1 ? ' medida)' : ' medidas)'),
            desc: nomes.join(' · ') + (repor.length > 3 ? ' e mais ' + (repor.length - 3) : ''),
            page: 'estoque', time: 'abrir Estoque →',
          });
        }
        if (s.fiado_vencido && s.fiado_vencido.count > 0) {
          itens.push({
            id: 'fiado:' + s.fiado_vencido.count + ':' + s.fiado_vencido.total,
            icon: 'wallet', iconBg: 'bg-rose-50', iconColor: 'text-rose-600',
            title: 'Fiado vencido no atacado',
            desc: s.fiado_vencido.count + ' venda(s) vencida(s), ' +
              this.formatCurrency(Number(s.fiado_vencido.total)) + ' pra cobrar.',
            page: 'financeiro', tab: 'cobrancas', filter: 'vencida', time: 'abrir Cobranças →',
          });
        }
        if (s.a_pagar_vencido && s.a_pagar_vencido.count > 0) {
          itens.push({
            id: 'pagar:' + s.a_pagar_vencido.count + ':' + s.a_pagar_vencido.total,
            icon: 'receipt', iconBg: 'bg-amber-50', iconColor: 'text-amber-600',
            title: 'Conta vencida a pagar',
            desc: s.a_pagar_vencido.count + ' conta(s) vencida(s), ' +
              this.formatCurrency(Number(s.a_pagar_vencido.total)) + ' no total.',
            page: 'financeiro', tab: 'pagar', filter: 'vencida', time: 'abrir Contas a pagar →',
          });
        }
      }
      const apps = this.sinoApplications || [];
      if (apps.length > 0) {
        itens.push({
          id: 'cand:' + JSON.stringify(apps.map(a => a.id).sort()),
          icon: 'inbox', iconBg: 'bg-indigo-50', iconColor: 'text-indigo-600',
          title: apps.length + (apps.length === 1 ? ' candidatura de parceiro' : ' candidaturas de parceiro'),
          desc: (apps[0] && apps[0].trade_name ? '"' + apps[0].trade_name + '"' : 'Novo interessado') +
            (apps.length > 1 ? ' e mais ' + (apps.length - 1) : '') + ' esperando sua análise.',
          action: 'applications', time: 'abrir Candidaturas →',
        });
      }
      // Comissão >= alarme do dono (alarme mora no localStorage — front soma sozinho).
      const estouradas = ((this.sinoComissoes && this.sinoComissoes.enabled && this.sinoComissoes.partners) || [])
        .filter((p) => this.comissaoEstourou(p));
      if (estouradas.length > 0) {
        const total = estouradas.reduce((acc, p) => acc + Number(p.open_total || 0), 0);
        itens.push({
          id: 'comissao:' + JSON.stringify(estouradas.map(p =>
            JSON.stringify([p.partner_id, Number(p.open_total || 0).toFixed(2), Number(p.open_count || 0)])).sort()),
          icon: 'coins', iconBg: 'bg-brand-50', iconColor: 'text-brand-600',
          title: 'Comissão passou do seu alarme',
          desc: estouradas.map((p) => p.partner_name).join(', ') + ' — ' +
            this.formatCurrency(total) + ' em aberto.',
          page: 'rede', section: 'operacao', time: 'abrir Comissões →',
        });
      }
      return itens.filter(n => n.action === 'applications' ? this.adminUser?.role === 'owner' : this.sinoCan(n.page))
        .map((n) => ({ ...n, read: this.sinoLidas.includes(n.id) }));
    },

    async sinoClick(notif) {
      notif = this.notificacoes.find(n => n.id === notif?.id);
      if (!notif) return;
      const navigationRequest = ++navigation;
      const scope = this.sinoContext();
      this.sinoMarcarLida(notif.id);
      // Candidatura abre o MODAL (não é uma página); o resto navega pela aba.
      if (notif.action === 'applications') this.openApplications();
      else if (notif.page) {
        this.currentPage = notif.page;
        if (notif.page === 'rede') this.redeSection = notif.section || 'visao';
        if (notif.page === 'estoque') {
          this.stockTab = 'reposicao'; this.stockVehicleType = 'all';
          this.$dispatch?.('sino-reposicao');
        }
        if (notif.page === 'retiradas') {
          this.partnerRetiradasFilter = 'waiting'; this.partnerRetiradasSearch = '';
          this.partnerRetiradasSelectedId = '';
        }
        if (notif.page === 'bot') this.botTab = notif.section || 'visao';
        if (notif.page === 'financeiro') this.finTab = notif.tab || 'visao';
        if (notif.page === 'logistica') this.logisticaTab = 'visao';
        // Financeiro tem sub-abas: a notificação leva DIRETO na certa, já filtrada
        // (conta vencida → Contas a pagar/vencidas; fiado → Cobranças/vencidas).
        // O filtro aplicado é o da ABA DESTINO — o da outra fica como estava.
        if (notif.tab) {
          this.finTab = notif.tab;
          if (notif.tab === 'cobrancas') this.cobrancaFiltro = notif.filter || '';
          if (notif.tab === 'pagar') this.pagarFiltro = notif.filter || '';
        }
      }
      this.$nextTick(() => {
        if (notif.section === 'conversas' && this.$refs?.sinoBotTechnical) this.$refs.sinoBotTechnical.open = true;
        lucide.createIcons();
      });
      if (notif.orderId && this.loadLogistica) {
        try { await this.loadLogistica({ propagate: true }); }
        catch (_) { return; } // A própria Logística mostra a falha e preserva os dados.
        if (navigationRequest !== navigation || scope !== this.sinoContext()
            || !this.adminAuthenticated || this.currentPage !== 'logistica') return;
        const order = this.logisticaTodasEntregas?.().find(d => d.order_id === notif.orderId);
        if (order?.delivery_status === 'failed' && order.status !== 'cancelled') this.logOpAbrirDialog?.('pedido', notif.orderId);
      }
    },

    sinoMarcarLida(id) {
      if (this.sinoLidas.includes(id)) return;
      // cap: assinaturas antigas saem pela frente (itens resolvidos somem da fonte)
      this.sinoLidas = [...this.sinoLidas, id].slice(-100);
      const key = this.sinoReadKey();
      try { if (key) localStorage.setItem(key, JSON.stringify(this.sinoLidas)); }
      catch (_) { /* A leitura continua válida em memória se o navegador bloquear o armazenamento. */ }
    },

    sinoMarcarTodas() {
      for (const n of this.notificacoes) this.sinoMarcarLida(n.id);
    },

  };
};
