(function () {
  'use strict';
  const C = window.Caixa;
  // A categoria vem do cadastro. Medida e aro não determinam carro/moto.
  C.tireIllustration = function (row) {
    if (!['car', 'motorcycle'].includes(row.vehicle_type)) {
      const box = document.createElement('span'), label = document.createElement('small');
      box.className = 'ms-tire-unknown'; label.textContent = 'Tipo não identificado';
      box.append(C.createSvg([{ d: 'M3 3h10l8 8-10 10-8-8V3Zm5 5h.01' }]), label); return box;
    }
    const image = document.createElement('img'); image.className = 'ms-tire';
    image.src = row.vehicle_type === 'car' ? '/operacao/catalog-tire-car.png' : '/operacao/catalog-tire.webp';
    image.alt = row.vehicle_type === 'car' ? 'Ilustração de pneu de carro' : 'Ilustração de pneu de moto'; return image;
  };
}());
