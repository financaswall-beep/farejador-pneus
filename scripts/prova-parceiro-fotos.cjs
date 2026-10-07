// Prova visual local; servidor fictício, sem Chatwoot nem banco de produção.
const { chromium } = require(process.env.FAREJADOR_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
async function checkPhoneSizes(page, label) {
  for (const [width, height] of [[320, 568], [390, 667], [430, 932]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: label, exact: true }).scrollIntoViewIfNeeded();
    const fits = await page.locator('#partner-home-screen').evaluate(el => el.scrollWidth <= el.clientWidth);
    assert.equal(fits, true, 'Sem overflow horizontal em ' + width);
    const button = await page.getByRole('button', { name: label, exact: true }).boundingBox();
    const menu = await page.locator('.ph-nav').boundingBox();
    assert.ok(button.y + button.height <= menu.y + 1, 'Menu não cobre ' + label + ' em ' + width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#partner-home-screen').evaluate(el => { el.scrollTop = 0; });
}
async function main() {
  const out = path.resolve('output/partner-photo'); await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const uploads = []; page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/foto')) uploads.push(req.url()); });
    const base = 'http://127.0.0.1:' + (process.env.PARTNER_PREVIEW_PORT || '8772');
    await page.goto(base + '/_preview/parceiro?cenario=foto#fotos');
    await page.getByRole('button', { name: 'TIRAR FOTO', exact: true }).click();
    await page.getByRole('heading', { name: 'Foto do pneu', exact: true }).waitFor();
    assert.equal(await page.locator('.ps-photo-tire').getByRole('timer').count(), 1);
    await checkPhoneSizes(page, 'TIRAR FOTO');
    await page.screenshot({ path: path.join(out, '01-tirar-foto.png') });
    const image = path.resolve('painel/public/assets/partner-replenishment-tire-v1.webp');
    await page.locator('.ps-photo input[type=file]').first().setInputFiles(image);
    await page.getByRole('button', { name: 'ENVIAR FOTO', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'PRÓXIMO PNEU', exact: true }).count(), 0);
    await checkPhoneSizes(page, 'ENVIAR FOTO');
    await page.screenshot({ path: path.join(out, '02-foto-unica.png') });
    await page.goto(base + '/_preview/parceiro?cenario=fotos-duas#fotos');
    await page.getByRole('button', { name: 'FOTOGRAFAR 2 PNEUS', exact: true }).click();
    await page.locator('.ps-photo input[type=file]').first().setInputFiles(image);
    await page.getByRole('button', { name: 'PRÓXIMO PNEU', exact: true }).waitFor();
    await page.screenshot({ path: path.join(out, '03-primeiro-pneu.png') });
    await page.getByRole('button', { name: 'PRÓXIMO PNEU', exact: true }).click();
    await page.locator('.ps-photo input[type=file]').first().setInputFiles(image);
    await page.getByRole('button', { name: 'CONFERIR FOTOS', exact: true }).waitFor();
    await page.screenshot({ path: path.join(out, '04-segundo-pneu.png') });
    await page.getByRole('button', { name: 'CONFERIR FOTOS', exact: true }).click();
    await page.getByRole('heading', { name: 'Conferir fotos', exact: true }).waitFor();
    await page.screenshot({ path: path.join(out, '05-conferir-fotos.png') });
    await checkPhoneSizes(page, 'ENVIAR FOTOS');
    assert.equal(uploads.length, 0);
    assert.equal(await page.locator('.ps-photo-image img').count(), 2);
    await page.getByRole('button', { name: 'ENVIAR FOTOS', exact: true }).click();
    await page.waitForFunction(() => window.Caixa.partnerHome.currentTab() === 'partner-home');
    assert.equal(uploads.length, 2); assert.notEqual(uploads[0], uploads[1]);
    assert.deepEqual(errors, []);
    console.log('OK: um/dois pneus, câmera, conferência, envio correlacionado, três tamanhos de celular e zero erros JS. Capturas: ' + out);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
