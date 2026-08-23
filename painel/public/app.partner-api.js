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
      this.panelScope = 'partner';
      this.panelPartnerSlug = slug;
      this.panelPartnerToken = token;
      this.panelWorkplace = {
        id: selected.id, kind: 'partner', slug, name: me.unit_name || selected.name || slug,
        role: me.role,
      };
      this.panelModules = Object.entries(me.permissions)
        .filter(([, allowed]) => allowed === true).map(([module]) => module);
      this.adminUser = null;
      this.operatorLabel = me.display_name || me.username || 'Operador';
      this.adminAuthenticated = true;
      if (!this.panelPageEnabled(this.currentPage)) {
        this.currentPage = this.firstPanelPage() || 'resumo';
      }
      return true;
    },

    async partnerApiGet(resource) {
      if (!this.adminAuthenticated || !this.isPartnerPanel()) {
        throw new Error('missing_partner_session');
      }
      if (!/^[a-z0-9][a-z0-9/_?=&.-]*$/i.test(resource) || resource.includes('..')) {
        throw new Error('invalid_partner_resource');
      }
      const response = await fetch(
        `/parceiro/${encodeURIComponent(this.panelPartnerSlug)}/api/${resource}`,
        { credentials: 'same-origin', headers: { Authorization: `Bearer ${this.panelPartnerToken}` } },
      );
      if (response.status === 401) this.partnerPanelUnauthorized(this.panelPartnerSlug);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.error || `api_${response.status}`);
        error.status = response.status;
        throw error;
      }
      return response.json();
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
