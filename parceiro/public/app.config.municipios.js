window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.configMunicipios = () => ({
  networkMunicipalities: [], networkMunicipalitiesError: '',
  areaMunicipalities: [], areaMunicipalityChoice: '',

  municipalityKey(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .trim().replace(/\s+/g, ' ').toLowerCase();
  },

  municipalityDisplayName(value) {
    const key = this.municipalityKey(value);
    return this.networkMunicipalities.find((name) => this.municipalityKey(name) === key) || value;
  },

  availableNetworkMunicipalities(selected) {
    const selectedKeys = new Set((selected || []).map((name) => this.municipalityKey(name)));
    return this.networkMunicipalities.filter((name) => !selectedKeys.has(this.municipalityKey(name)));
  },

  addAreaMunicipality() {
    const chosen = this.municipalityDisplayName(this.areaMunicipalityChoice);
    if (chosen && this.networkMunicipalities.includes(chosen)
      && !this.areaMunicipalities.some((name) => this.municipalityKey(name) === this.municipalityKey(chosen))) {
      this.areaMunicipalities = [...this.areaMunicipalities, chosen];
    }
    this.areaMunicipalityChoice = '';
  },

  removeAreaMunicipality(municipality) {
    const key = this.municipalityKey(municipality);
    this.areaMunicipalities = this.areaMunicipalities.filter((name) => this.municipalityKey(name) !== key);
  },

  async loadPartnerMunicipalities() {
    if (this.networkMunicipalities.length) return;
    try {
      const response = await fetch('/api/network/municipalities', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`api_${response.status}`);
      const payload = await response.json();
      this.networkMunicipalities = Array.isArray(payload.municipalities) ? payload.municipalities : [];
      this.networkMunicipalitiesError = this.networkMunicipalities.length ? '' : 'Lista de cidades vazia.';
    } catch (error) {
      this.networkMunicipalitiesError = 'Não foi possível carregar as cidades. Recarregue a página.';
      console.error('partner_municipalities_unavailable', error);
    }
  },
});
