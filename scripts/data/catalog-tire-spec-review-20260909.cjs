'use strict';

const BATCH = 'catalog-tire-spec-review-20260909-v1';
const CHECKED_AT = '2026-09-09T00:00:00Z';

const confirmed = [
  {
    productCode: 'LEVO-1107013-MV', brand: 'Levorin', measure: '110/70-13',
    treadPattern: 'Matrix Scooter', loadIndex: '48', speedRating: 'P', position: 'front',
    sourceUrl: 'https://levorin.com.br/pneu-moto/matrix-scooter/',
    sourceTitle: 'Levorin — Matrix Scooter',
  },
  {
    productCode: 'MAGG-1107013-MV', brand: 'Maggion', measure: '110/70-13',
    treadPattern: 'Sportíssimo II', loadIndex: '48', speedRating: 'P', position: 'front',
    sourceUrl: 'https://maggion.com.br/pneus/SportissimoII',
    sourceTitle: 'Maggion — Sportíssimo II',
  },
  {
    productCode: 'MICH-1107013-MV', brand: 'Michelin', measure: '110/70-13',
    treadPattern: 'City Grip 2', loadIndex: '48', speedRating: 'S', position: 'front',
    sourceUrl: 'https://www.michelin.com.br/motorbike/browse-tyres/by-dimension/110/70/13/48/S',
    sourceTitle: 'Michelin Brasil — City Grip 2 110/70-13 48S',
  },
  {
    productCode: 'PIR-1805517-MV', brand: 'Pirelli', measure: '180/55-17',
    treadPattern: 'Diablo Rosso', loadIndex: '73', speedRating: 'W', position: 'rear',
    sourceUrl: 'https://tyre24.pirelli.com/moto/assets/pirelli/pdf/global/PIRELLI_Product_Range_2025.pdf',
    sourceTitle: 'Pirelli Product Range 2025 — Diablo Rosso',
  },
];

const pendingCodes = [
  'CIAT-1407017-MV', 'DUNL-1207015-MV', 'IRA-909012-MV', 'IRC-1009012-MV',
  'IRC-1107013-MV', 'IRC-1109012-MV', 'KEND-1008014-MV', 'LEVO-1109017-MV',
  'LEVO-1407017-MV', 'LEVO-909012-MV', 'MAGG-1009018-MV', 'MAGG-1107017-MV',
  'MAGG-1207014-MV', 'MAGG-1208018-MV', 'MAGG-1407017-MV', 'MAG-909010-MV',
  'METZ-1208018-MV', 'METZ-1307013-MV', 'MET-909018-MV', 'METZ-909019-MV',
  'MICH-1107017-MV', 'MICH-1207015-MV', 'MICH-1307013-MV', 'MICH-1307016-MV',
  'MICH-1407017-MV', 'MICH-1507014-MV', 'MICH-1805518-MV', 'MIC-8010018-MV',
  'MIC-909010-MV', 'MIC-909010-REM', 'MICH-909018-MV', 'PIRE-1009012-MV',
  'PIRE-1109012-MV', 'PIRE-1207014-MV', 'PIRE-1207015-MV', 'PIRE-1207017-MV',
  'PIRE-1308017-MV', 'PIRE-1805518-MV', 'PIR-8010018-MV', 'PIRE-909012-MV',
  'PIRE-909019-MV', 'TECH-909012-MV', 'VIPA-1109017-MV', 'VIPA-1207014-MV',
  'VIPA-1209017-MV',
];

const pending = pendingCodes.map((productCode) => ({
  productCode,
  reason: 'Modelo/desenho exato ausente; conferir a inscrição no pneu físico.',
}));

module.exports = { BATCH, CHECKED_AT, confirmed, pending };
