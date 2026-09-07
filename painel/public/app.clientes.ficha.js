window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.clientesFicha = function () {
  let requestVersion = 0;
  let returnFocus = null;
  return {
    clienteFichaAberta: false,
    clienteFichaLoading: false,
    clienteFichaMaisLoading: false,
    clienteFichaErro: '',
    clienteFicha: null,
    clienteFichaOrigem: null,
    abrirFichaCliente(c) {
      if (!c?.source_id || !['chatwoot','balcao','parceiro','atacado'].includes(c.source)) return;
      returnFocus = document.activeElement;
      this.clienteFichaOrigem = { ...c };
      this.clienteFicha = null;
      this.clienteFichaErro = '';
      this.clienteFichaAberta = true;
      this.$nextTick(() => {
        if (!this.clienteFichaAberta) return;
        document.getElementById('cliente-ficha-fechar')?.focus();
        lucide.createIcons();
      });
      void this.carregarFichaCliente();
    },
    fecharFichaCliente() {
      requestVersion++;
      this.clienteFichaAberta = false;
      this.clienteFichaLoading = false;
      this.clienteFichaMaisLoading = false;
      this.clienteFicha = null;
      this.clienteFichaOrigem = null;
      this.clienteFichaErro = '';
      const target = returnFocus;
      returnFocus = null;
      this.$nextTick(() => { if (target?.isConnected) target.focus(); });
    },
    async carregarFichaCliente(more = false) {
      const c = this.clienteFichaOrigem;
      if (!this.clienteFichaAberta || !c || (more && this.clienteFichaMaisLoading)) return;
      const offset = more ? this.clienteFicha?.next_offset : 0;
      if (offset == null) return;
      const version = ++requestVersion;
      this.clienteFichaErro = '';
      this.clienteFichaLoading = !more;
      this.clienteFichaMaisLoading = more;
      try {
        const data = await this.apiGet(`/admin/api/clientes/${encodeURIComponent(c.source)}/${encodeURIComponent(c.source_id)}/ficha?limit=10&offset=${offset}`);
        if (version !== requestVersion || !this.clienteFichaAberta) return;
        this.clienteFicha = { ...data, orders:more ? [...this.clienteFicha.orders,...data.orders] : data.orders };
        this.carregarClienteLeadFoto(data.customer);
      } catch {
        if (version === requestVersion && this.clienteFichaAberta) {
          this.clienteFichaErro = more ? 'Não foi possível carregar mais compras.' : 'Não foi possível carregar a ficha deste cliente.';
        }
      } finally {
        if (version === requestVersion) {
          this.clienteFichaLoading = false;
          this.clienteFichaMaisLoading = false;
          this.$nextTick(() => lucide.createIcons());
        }
      }
    },
    clienteFichaCliente() { return this.clienteFicha?.customer || this.clienteFichaOrigem; },
    clienteFichaFoto() { return this.clienteLeadFoto(this.clienteFichaCliente()); },
    clienteFichaConversaUrl() {
      return this.clienteLeadConversaUrl(this.clienteFichaCliente());
    },
    clienteFichaMapaUrl() {
      const address = this.clienteFicha?.customer?.address;
      return address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : '';
    },
    clienteFichaLocalizacaoMapaUrl() { return this.clienteFicha?.customer?.shared_location?.maps_url || ''; },
    clienteFichaStatusPedido(order) {
      if (order.status === 'cancelled') return 'Cancelado';
      return order.completed ? 'Concluído' : 'Pendente';
    },
    clienteFichaModalidade(order) {
      return ({ delivery:'Entrega',pickup:'Retirada',wholesale:'Atacado' })[order.fulfillment_mode] || '';
    },
  };
};
