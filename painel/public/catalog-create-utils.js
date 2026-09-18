(function () {
  'use strict';
  // Regras de cadastro compartilhadas pelo painel web e pelo app de operação.
  function productCode(measure, brand, condition) {
    const brandCode = String(brand || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'PNE';
    const measureCode = String(measure || '').replace(/\D/g, '') || 'MEDIDA';
    const conditionCode = condition === 'novo' ? 'NOV' : condition === 'remold' ? 'REM' : 'MV';
    return `${brandCode}-${measureCode}-${conditionCode}`;
  }
  // Medida nominal: não infere a construção ou a ficha técnica do pneu.
  function measureValue(value) {
    const text = String(value || '').trim().replace(/\s+/g, '').replace(',', '.');
    const metric = text.match(/^(\d{2,3})\/(\d{2,3})(?:-|R)(\d{2})$/i);
    if (metric) {
      const [, width, aspect, rim] = metric.map(Number);
      return width >= 50 && width <= 400 && aspect >= 20 && aspect <= 100 && rim >= 8 && rim <= 30
        ? `${width}/${aspect}-${metric[3]}` : '';
    }
    const inch = text.match(/^(\d\.\d{1,2})(?:-|R)(\d{2})$/i);
    return inch && Number(inch[1]) >= 1.5 && Number(inch[1]) <= 8 && Number(inch[2]) >= 8 && Number(inch[2]) <= 30
      ? `${Number(inch[1]).toFixed(2)}-${inch[2]}` : '';
  }
  function measureChoices(value, rows, allowNew = true) {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return [];
    const digits = raw.replace(/\D/g, ''), exact = measureValue(raw);
    const measures = [...new Set((rows || []).filter(row => row.product_type === 'tire')
      .map(row => measureValue(row.tire_size)).filter(Boolean))];
    const choices = measures.filter(measure => measure.includes(raw)
      || (digits && measure.replace(/\D/g, '').includes(digits)) || measure === exact)
      .sort((a, b) => Number(b === exact) - Number(a === exact) || a.localeCompare(b, 'pt-BR', { numeric: true }))
      .slice(0, 8).map(measure => ({ measure, isNew: false }));
    if (exact && !measures.includes(exact) && allowNew) choices.push({ measure: exact, isNew: true });
    return choices;
  }
  window.CatalogCreateUtils = Object.freeze({ productCode, measureValue, measureChoices });
}());
