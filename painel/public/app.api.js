// Obra 300 (2026-07-05): fatia do painel da MATRIZ — credenciais + apiGet/Post/Put + salvar raio de entrega.
// VERBATIM das linhas 605-704 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.api = function () {
  return {
    async ensureCredentials() {
      if (this.adminAuthenticated) return true;
      const response = await fetch('/admin/api/auth/me', { credentials: 'same-origin' });
      if (!response.ok) {
        location.replace('/admin/login');
        return false;
      }
      const payload = await response.json();
      this.adminUser = payload.user;
      this.operatorLabel = payload.user.display_name;
      this.adminAuthenticated = true;
      if (payload.user.role !== 'owner') {
        this.liveMenu = this.liveMenu.filter((item) => item.id !== 'colaboradores');
      }
      return true;
    },

    apiHeaders() {
      return {
        'Content-Type': 'application/json',
      };
    },

    adminUnauthorized() {
      this.adminAuthenticated = false;
      this.adminUser = null;
      location.replace('/admin/login');
    },

    async apiGet(path) {
      if (!this.adminAuthenticated) throw new Error('missing_admin_session');
      const response = await fetch(path, { credentials: 'same-origin', headers: this.apiHeaders() });
      if (response.status === 401) this.adminUnauthorized();
      if (!response.ok) throw new Error(`api_${response.status}`);
      return response.json();
    },

    async apiPost(path, body) {
      if (!this.adminAuthenticated) throw new Error('missing_admin_session');
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: this.apiHeaders(),
        body: JSON.stringify(body),
      });
      if (response.status === 401) this.adminUnauthorized();
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const e = new Error(payload.error || `api_${response.status}`);
        e.payload = payload; e.status = response.status; // detalhe do erro (ex.: oversell)
        throw e;
      }
      return response.json();
    },

    async apiPut(path, body) {
      if (!this.adminAuthenticated) throw new Error('missing_admin_session');
      const response = await fetch(path, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: this.apiHeaders(),
        body: JSON.stringify(body),
      });
      if (response.status === 401) this.adminUnauthorized();
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `api_${response.status}`);
      }
      return response.json();
    },

    async logoutAdmin() {
      try {
        await fetch('/admin/api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      } finally {
        this.adminAuthenticated = false;
        location.replace('/admin/login');
      }
    },

    // Matriz define o raio de entrega do parceiro selecionado (proximidade-primeiro Fase 2).
    async salvarRaioEntrega() {
      const p = this.selectedParceiro();
      if (!p) return;
      if (!p.fazEntrega) { alert('Este parceiro está como só retirada — peça pra ele ligar a entrega no painel antes de definir o raio.'); return; }
      let km = p.deliveryRadiusKm;
      if (km === '' || km === undefined) km = null;
      if (km !== null) {
        km = Number(km);
        if (!Number.isFinite(km) || km <= 0) { alert('Informe um raio válido (km maior que zero).'); return; }
        if (km > 9999.99) { alert('Raio muito grande.'); return; }
      }
      this.savingRaio = true;
      try {
        await this.apiPut(`/admin/api/partners/${encodeURIComponent(p.id)}/delivery-radius`, { delivery_radius_km: km });
        p.deliveryRadiusKm = km;
        this.raioSalvoMsg = km === null ? 'Raio limpo.' : 'Raio salvo.';
        setTimeout(() => { this.raioSalvoMsg = ''; }, 2500);
      } catch (err) {
        const msg = String(err && err.message || err);
        alert(msg === 'partner_pickup_only'
          ? 'Esse parceiro está como só retirada — não dá pra definir raio.'
          : 'Não consegui salvar o raio: ' + msg);
      } finally {
        this.savingRaio = false;
      }
    },

  };
};
