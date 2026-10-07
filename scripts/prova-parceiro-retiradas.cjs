// Prova em navegador com dados fictícios; nenhum acesso a banco/Chatwoot.
const { chromium } = require(process.env.FAREJADOR_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
async function main() {
  const output = path.resolve('output/partner-pickups'); await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const base = 'http://127.0.0.1:' + (process.env.PARTNER_PREVIEW_PORT || '8774');
    await page.goto(base + '/_preview/parceiro?cenario=retiradas#retiradas');
    await page.getByRole('button', { name: 'VER RETIRADA', exact: true }).first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.pu-order').count(), 3);
    await page.screenshot({ path: path.join(output, '01-lista.png') });
    await page.getByRole('button', { name: 'VER RETIRADA', exact: true }).first().click();
    await page.locator('.pu-tire-photo img').first().waitFor();
    assert.equal(await page.locator('.pu-tire').count(), 2);
    assert.equal(await page.locator('.pu-screen select').count(), 0);
    await page.screenshot({ path: path.join(output, '02-dois-pneus.png') });
    for (const [width, height] of [[320,568], [390,667], [430,932]]) {
      await page.setViewportSize({ width, height });
      const action = page.getByRole('button', { name: 'CONFIRMAR RETIRADA', exact: true });
      await action.scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#partner-home-screen').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'largura ' + width);
      const button = await action.boundingBox(); const menu = await page.locator('.ph-nav').boundingBox();
      assert.ok(button.y + button.height <= menu.y + 1, 'menu não cobre confirmar em ' + width);
    }
    await page.getByRole('button', { name: 'CONFIRMAR RETIRADA', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.pu-order').length === 2);
    assert.equal(await page.locator('.pu-order').filter({ hasText: 'João Silva' }).count(), 0);
    await page.getByRole('button', { name: 'VER RETIRADA', exact: true }).first().click();
    await page.getByRole('button', { name: 'Cliente não veio', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'SIM, CANCELAR', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'MANTER PEDIDO', exact: true }).click();
    await page.getByRole('button', { name: 'Voltar', exact: true }).click();
    assert.equal(await page.locator('.pu-order').count(), 2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/_preview/parceiro?cenario=retirada-uma#retiradas');
    await page.getByRole('button', { name: 'VER RETIRADA', exact: true }).click();
    await page.locator('.pu-tire-photo img').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(output, '03-um-pneu.png') });
    assert.equal(await page.locator('.pu-tire').count(), 1);
    assert.deepEqual(errors, []);
    console.log('OK: lista, um/dois pneus, confirmação individual, cancelamento protegido, 320/390/430px, zero erros JS. ' + output);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
