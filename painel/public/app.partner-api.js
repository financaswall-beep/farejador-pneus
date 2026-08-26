// Encanamento compartilhado das telas modernas do parceiro. O token ps_ nunca
// entra em apiGet/admin: ele só é anexado a URLs /parceiro/:slug/api/*.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerApi = function () {
  return {
    panelSelectedPartner() {
      try {
        const selected = JSON.parse(sessionStorage.getItem('farejador_panel_workplace') || 'null');
        return selected?.kind === 'partner' && selected?.modern_panel_enabled === true
          ? selected : null;
      } catch (_) {
        return null;
      }
    },

    async ensurePartnerPanelCredentials(selected) {
      const slug = String(selected.slug || '');
      const tokenKey = `farejador_partner_token_${slug}`;
      const token = sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || '';
      if (!slug || !/^ps_[a-f0-9]{64}$/.test(token)) {
        this.partnerPanelUnauthorized(slug);
        return false;
      }
      const response = await fetch(`/parceiro/${encodeURIComponent(slug)}/api/me`, {
        credentials: 'same-origin', headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        this.partnerPanelUnauthorized(slug);
        return false;
      }
      const me = await response.json();
      if (me.slug !== slug || !me.permissions || typeof me.permissions !== 'object') {
        this.partnerPanelUnauthorized(slug);
        return false;
      }
      if (me.modern_panel_enabled !== true) {
        sessionStorage.removeItem('farejador_panel_workplace');
        location.replace(`/parceiro/${encodeURIComponent(slug)}/`);
        return false;
      }
      this.panelScope = 'partner';
      this.panelPartnerSlug = slug;
      this.panelPartnerToken = token;
      this.panelWorkplace = {
        id: selected.id, kind: 'partner', slug, name: me.unit_name || selected.name || slug,
        role: me.role,
      };
      this.panelModules = Object.entries(me.permissions)
        .filter(([, allowed]) => allowed === true).map(([module]) => module);
      const partnerOnlyModules = me.permissions.entregas === true ? ['logistica'] : [];
      this.panelModules = [...new Set([...this.panelModules, ...partnerOnlyModules])];
      // Marketing, Bot e Rede não entram: não existem na projeção da unidade.
      this.adminUser = null;
      this.operatorLabel = me.display_name || me.username || 'Operador';
      this.adminAuthenticated = true;
      if (!this.panelPageEnabled(this.currentPage)) {
        this.currentPage = this.firstPanelPage() || 'resumo';
      }
      return true;
    },

    partnerApiResourceUrl(resource) {
      if (!this.adminAuthenticated || !this.isPartnerPanel()) {
        throw new Error('missing_partner_session');
      }
      if (!/^[a-z0-9][a-z0-9/_?=&.-]*$/i.test(resource) || resource.includes('..')) {
        throw new Error('invalid_partner_resource');
      }
      return `/parceiro/${encodeURIComponent(this.panelPartnerSlug)}/api/${resource}`;
    },

    async partnerApiFetch(resource, options = {}) {
      const method = String(options.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        throw new Error('invalid_partner_method');
      }
      const response = await fetch(this.partnerApiResourceUrl(resource), {
        ...options,
        method,
        credentials: 'same-origin',
        headers: { ...(options.headers || {}), Authorization: `Bearer ${this.panelPartnerToken}` },
      });
      if (response.status === 401) this.partnerPanelUnauthorized(this.panelPartnerSlug);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.message || payload.error || `api_${response.status}`);
        error.code = payload.error || `api_${response.status}`;
        error.status = response.status;
        throw error;
      }
      return response;
    },

    async partnerApiGet(resource) {
      const response = await this.partnerApiFetch(resource);
      return response.json();
    },

    async partnerApiWrite(resource, method, body) {
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('invalid_partner_write_method');
      const response = await this.partnerApiFetch(resource, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return response.json();
    },

    async partnerApiBlob(resource) {
      const response = await this.partnerApiFetch(resource);
      return response.blob();
    },

    partnerPanelErrorCode(error) {
      const raw = String(error?.code || error?.message || 'unknown_error');
      return raw.replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 80) || 'unknown_error';
    },

    async partnerPanelTelemetry(event) {
      if (!this.adminAuthenticated || !this.isPartnerPanel()) return;
      try {
        const response = await fetch(this.partnerApiResourceUrl('panel-canary-events'), {
          method: 'POST', credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.panelPartnerToken}`,
          },
          body: JSON.stringify(event),
        });
        if (response.status === 409) {
          sessionStorage.removeItem('farejador_panel_workplace');
          location.replace(`/parceiro/${encodeURIComponent(this.panelPartnerSlug)}/`);
        }
      } catch (_) {
        // Telemetria nunca bloqueia leitura, retirada, estoque ou caixa.
      }
    },

    partnerPanelUnauthorized(slug) {
      if (slug) {
        sessionStorage.removeItem(`farejador_partner_token_${slug}`);
        localStorage.removeItem(`farejador_partner_token_${slug}`);
      }
      sessionStorage.removeItem('farejador_panel_workplace');
      this.adminAuthenticated = false;
      this.panelPartnerToken = '';
      location.replace('/admin/login');
    },

    async logoutPartnerPanel() {
      try {
        await fetch(`/parceiro/${encodeURIComponent(this.panelPartnerSlug)}/api/logout`, {
          method: 'POST', credentials: 'same-origin',
          headers: { Authorization: `Bearer ${this.panelPartnerToken}` },
        });
      } finally {
        this.partnerPanelUnauthorized(this.panelPartnerSlug);
      }
    },
  };
};
