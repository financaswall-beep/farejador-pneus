(function () {
  'use strict';

  const Caixa = window.Caixa;
  const BRANDS = Object.freeze([
    'Bridgestone', 'Dunlop', 'IRA', 'Kenda', 'Levorin', 'Maggion', 'Metzeler',
    'Michelin', 'Mitas', 'Pirelli', 'Rinaldi', 'Technic', 'Vipal',
  ]);
  const NAMES = Object.freeze({
    bridgestone: 'Bridgestone', dunlop: 'Dunlop', ira: 'IRA', kenda: 'Kenda',
    levorin: 'Levorin', levorim: 'Levorin', maggion: 'Maggion', magion: 'Maggion',
    metzeler: 'Metzeler', michelin: 'Michelin', michellin: 'Michelin', mitas: 'Mitas',
    pirelli: 'Pirelli', rinaldi: 'Rinaldi', technic: 'Technic', vipal: 'Vipal',
  });
  const ASSETS = Object.freeze({
    pirelli: 'pirelli', metzeler: 'metzeler', michelin: 'michelin', michellin: 'michelin',
    bridgestone: 'bridgestone', dunlop: 'dunlop', levorin: 'levorin', levorim: 'levorin',
    rinaldi: 'rinaldi', maggion: 'maggion', magion: 'maggion', technic: 'technic',
    vipal: 'vipal', mitas: 'mitas', kenda: 'kenda',
  });

  function key(brand) {
    return String(brand || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  Caixa.catalogBrandOptions = BRANDS;
  Caixa.canonicalCatalogBrand = function (brand) { return NAMES[key(brand)] || ''; };
  Caixa.populateCatalogBrandSelect = function (select) {
    if (!select || select.dataset.brandOptionsReady === 'true') return;
    BRANDS.forEach(function (brand) {
      const option = document.createElement('option');
      option.value = brand;
      option.textContent = brand;
      select.appendChild(option);
    });
    select.dataset.brandOptionsReady = 'true';
  };
  Caixa.catalogBrandLogo = function (brand) {
    const asset = ASSETS[key(brand)];
    return asset ? '/operacao/catalog-brands/' + asset + '.webp?v=20260822-caixa-brand2' : null;
  };
}());
