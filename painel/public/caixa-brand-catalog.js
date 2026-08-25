(function () {
  'use strict';

  const Caixa = window.Caixa;
  const BRANDS = Object.freeze([
    'Bridgestone', 'CEAT', 'Dunlop', 'IRA', 'IRC', 'Kenda', 'Levorin', 'Maggion',
    'Metzeler', 'Michelin', 'Mitas', 'Pirelli', 'Rinaldi', 'Technic', 'Vipal',
  ]);
  const NAMES = Object.freeze({
    bridgestone: 'Bridgestone', ceat: 'CEAT', ciat: 'CEAT', dunlop: 'Dunlop',
    ira: 'IRA', irc: 'IRC', kenda: 'Kenda',
    levorin: 'Levorin', levorim: 'Levorin', maggion: 'Maggion', magion: 'Maggion',
    metzeler: 'Metzeler', michelin: 'Michelin', michellin: 'Michelin', mitas: 'Mitas',
    pirelli: 'Pirelli', rinaldi: 'Rinaldi', technic: 'Technic', vipal: 'Vipal',
  });
  const ASSETS = Object.freeze({
    pirelli: 'pirelli', metzeler: 'metzeler', michelin: 'michelin', michellin: 'michelin',
    bridgestone: 'bridgestone', dunlop: 'dunlop', levorin: 'levorin', levorim: 'levorin',
    rinaldi: 'rinaldi', maggion: 'maggion', magion: 'maggion', technic: 'technic',
    vipal: 'vipal', mitas: 'mitas', kenda: 'kenda', ceat: 'ceat', ciat: 'ceat',
    ira: 'ira', irc: 'irc',
  });

  function key(brand) {
    return String(brand || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  Caixa.catalogBrandOptions = BRANDS;
  Caixa.catalogLogoBrands = Object.freeze(BRANDS.filter(function (brand) {
    return Boolean(ASSETS[key(brand)]);
  }));
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
    return asset ? '/operacao/catalog-brands/' + asset + '.webp?v=20260824-catalog-brand3' : null;
  };
}());
