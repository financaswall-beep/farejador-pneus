window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.clientesLeadsUi = function () {
  const fotosPendentes = new Set();
  const filaFotos = [];
  let fotosAtivas = 0;
  return {
    clientesLeadCanal: 'todos',
    clientesLeadFotos: {},
    clienteLeadDetalheAberto: false,
    clientesLeadEtapas: [
      { id:'novo',label:'Novos',tone:'bg-blue-50 text-blue-700',border:'border-t-blue-500' },
      { id:'atendimento',label:'Em atendimento',tone:'bg-teal-50 text-teal-800',border:'border-t-teal-600' },
      { id:'orcamento',label:'Orçamento enviado',tone:'bg-amber-50 text-amber-800',border:'border-t-amber-500' },
      { id:'perdido',label:'Perdidos',tone:'bg-rose-50 text-rose-700',border:'border-t-rose-400' },
      { id:'convertido',label:'Convertidos',tone:'bg-emerald-50 text-emerald-800',border:'border-t-emerald-600' },
    ],
    clienteLeadCanal(c) {
      const canal = this.clienteTexto(c?.origin);
      if (canal.includes('instagram')) return 'instagram';
      if (canal.includes('facebook')) return 'facebook';
      if (canal.includes('whatsapp')) return 'whatsapp';
      return 'chatwoot';
    },
    clienteLeadCanalLabel(c) {
      return ({ whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook', chatwoot: 'Chatwoot' })[this.clienteLeadCanal(c)];
    },
    clienteLeadManual(c) {
      return Boolean(c?.lead_manual_lane) && this.clienteLeadLane(c) !== 'convertido';
    },
    clienteLeadEtapaLabel(c) {
      return this.clientesLeadEtapas.find((lane) => lane.id === this.clienteLeadLane(c))?.label || 'Novo';
    },
    clienteLeadOrigemEtapa(c) {
      if (this.clienteLeadLane(c) === 'convertido') return 'Venda confirmada';
      if (this.clienteLeadManual(c)) return 'Etapa definida pela equipe';
      return ({ novo: 'Conversa recebida', atendimento: 'Atendimento em andamento',
        orcamento: 'Orçamento identificado', perdido: 'Conversa encerrada' })[this.clienteLeadLane(c)] || '';
    },
    clienteLeadFoto(c) { return this.clientesLeadFotos[c?.lead_conversation_id] || ''; },
    clienteLeadFotoFalhou(c) { if (c?.lead_conversation_id) this.clientesLeadFotos[c.lead_conversation_id] = ''; },
    carregarClienteLeadFoto(c, scope = 'clientes') {
      const id = c?.lead_conversation_id;
      if (!id || !this.adminAuthenticated || fotosPendentes.has(id) || Object.hasOwn(this.clientesLeadFotos, id)) return;
      fotosPendentes.add(id); filaFotos.push({ id,scope });
      this.processarClienteLeadFotos();
    },
    processarClienteLeadFotos() {
      while (fotosAtivas < 4 && filaFotos.length) {
        const { id,scope } = filaFotos.shift();
        if (!this.adminAuthenticated) { fotosPendentes.delete(id); continue; }
        fotosAtivas++;
        const prefix = scope==='bot' ? '/admin/api/bot/conversations/' : '/admin/api/clientes/leads/';
        this.apiGet(`${prefix}${encodeURIComponent(id)}/avatar`)
          .then((data) => {
            const value = data.avatar_url;
            this.clientesLeadFotos[id] = typeof value === 'string' && value.startsWith('https://') ? value : '';
          }).catch(() => { this.clientesLeadFotos[id] = ''; })
          .finally(() => { fotosAtivas--; fotosPendentes.delete(id); this.processarClienteLeadFotos(); });
      }
    },
    abrirClienteLead(c) {
      if (this.clientesLeadSelecionando) { this.clientesLeadMarcar(c.id); return; }
      this.selecionarCliente(c);
      this.clienteLeadDetalheAberto = true;
      this.carregarClienteLeadFoto(c);
      if (c?.lead_conversation_id && this.hasPanelModule?.('bot')) {
        this.consultarBotControle(c.lead_conversation_id).catch(() => { this.botControleModos[c.lead_conversation_id] = null; });
      }
      this.$nextTick(() => { document.getElementById('cliente-lead-fechar')?.focus(); });
    },
    fecharClienteLeadDetalhe() {
      this.clienteLeadDetalheAberto = false;
      this.$nextTick(() => { document.getElementById(`lead-card-${this.clienteSelecionadoId}`)?.focus(); });
    },
    clienteLeadConversaUrl(c) {
      const account = c?.chatwoot_account_id;
      const conversation = c?.chatwoot_conversation_id;
      if (!this.chatwootBaseUrl || !Number.isSafeInteger(Number(account)) || Number(account) <= 0
        || !Number.isSafeInteger(Number(conversation)) || Number(conversation) <= 0) return '';
      try {
        const base = new URL(this.chatwootBaseUrl);
        if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) return '';
        return `${base.origin}${base.pathname.replace(/\/$/, '')}/app/accounts/${account}/conversations/${conversation}`;
      } catch { return ''; }
    },
    clienteLeadFoco(event) {
      if (event.key !== 'Tab') return;
      const elements = [...event.currentTarget.querySelectorAll('button:not([disabled]), a[href], select:not([disabled])')]
        .filter((el) => el.getClientRects().length);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    },
  };
};
