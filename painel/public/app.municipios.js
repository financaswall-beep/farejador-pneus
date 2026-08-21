window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.municipios = function () {
  return {
    networkMunicipalities: [], networkMunicipalitiesError: '',
    partnerMunicipalityChoice: '', approveMunicipalityChoice: '',
    coveragePartnerId: null, coverageMunicipios: [], coverageMunicipalityChoice: '',
    coverageSaving: false, coverageMsg: '',

    municipalityKey(value) {
      return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .trim().replace(/\s+/g, ' ').toLowerCase();
    },

    municipalityDisplayName(value) {
      const key = this.municipalityKey(value);
      return this.networkMunicipalities.find((name) => this.municipalityKey(name) === key) || value;
    },

    municipalitiesFromText(value) {
      const seen = new Set();
      return String(value || '').split(',').map((name) => this.municipalityDisplayName(name.trim()))
        .filter((name) => {
          const key = this.municipalityKey(name);
          if (!key || seen.has(key) || !this.networkMunicipalities.some((item) => this.municipalityKey(item) === key)) return false;
          seen.add(key);
          return true;
        });
    },

    availableNetworkMunicipalities(selected) {
      const selectedKeys = new Set((selected || []).map((name) => this.municipalityKey(name)));
      return this.networkMunicipalities.filter((name) => !selectedKeys.has(this.municipalityKey(name)));
    },

    municipalityListProperty(property) {
      const parts = property.split('.');
      const owner = parts.length === 1 ? this : this[parts[0]];
      return { owner, key: parts[parts.length - 1] };
    },

    addMunicipality(listProperty, choiceProperty) {
      const chosen = this.municipalityDisplayName(this[choiceProperty]);
      if (!chosen || !this.networkMunicipalities.includes(chosen)) return;
      const target = this.municipalityListProperty(listProperty);
      const current = Array.isArray(target.owner[target.key]) ? target.owner[target.key] : [];
      if (!current.some((name) => this.municipalityKey(name) === this.municipalityKey(chosen))) {
        target.owner[target.key] = [...current, chosen];
      }
      this[choiceProperty] = '';
    },

    removeMunicipality(listProperty, municipality) {
      const key = this.municipalityKey(municipality);
      const target = this.municipalityListProperty(listProperty);
      target.owner[target.key] = (target.owner[target.key] || []).filter((name) => this.municipalityKey(name) !== key);
    },

    async loadNetworkMunicipalities() {
      try {
        const response = await fetch('/api/network/municipalities', { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`api_${response.status}`);
        const payload = await response.json();
        this.networkMunicipalities = Array.isArray(payload.municipalities) ? payload.municipalities : [];
        this.networkMunicipalitiesError = this.networkMunicipalities.length ? '' : 'Lista de cidades vazia.';
      } catch (error) {
        this.networkMunicipalities = [];
        this.networkMunicipalitiesError = 'Não foi possível carregar a lista oficial de cidades.';
        console.error('network_municipalities_unavailable', error);
      }
    },

    syncCoverageForm() {
      const partner = this.selectedParceiro();
      if (!partner || this.coveragePartnerId === partner.id) return;
      this.coveragePartnerId = partner.id;
      this.coverageMunicipios = [...(partner.municipios || [])];
      this.coverageMunicipalityChoice = '';
      this.coverageMsg = '';
    },

    async saveSelectedPartnerCoverage() {
      const partner = this.selectedParceiro();
      if (!partner || this.coverageSaving) return;
      if (this.adminUser?.role !== 'owner') { window.alert('Somente o proprietário pode alterar as cidades.'); return; }
      if (!this.coverageMunicipios.length) { window.alert('Escolha ao menos uma cidade atendida.'); return; }
      this.coverageSaving = true;
      this.coverageMsg = '';
      try {
        const result = await this.apiPut(`/admin/api/partners/${encodeURIComponent(partner.id)}/coverage`, {
          municipios: this.coverageMunicipios,
        });
        partner.municipios = [...(result.municipios || this.coverageMunicipios)];
        this.coverageMunicipios = [...partner.municipios];
        this.coverageMsg = result.changed === false ? 'Já estava assim.' : 'Cidades atualizadas.';
      } catch (error) {
        this.coverageMsg = `Erro: ${error instanceof Error ? error.message : error}`;
      } finally {
        this.coverageSaving = false;
      }
    },
  };
};
