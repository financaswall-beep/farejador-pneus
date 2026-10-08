// Navegador local com dados fictícios: nenhuma chamada para banco ou Chatwoot.
const { chromium } = require(process.env.FAREJADOR_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const output = path.resolve('output/partner-deliveries'); await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + (process.env.PARTNER_PREVIEW_PORT || '8775') + '/_preview/parceiro?cenario=entregas#entregas');
    await page.getByRole('button', { name: 'VER ENTREGA', exact: true }).first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.pd-order').count(), 3);
    await page.screenshot({ path: path.join(output, '01-lista.png') });
    await page.getByRole('button', { name: 'VER ENTREGA', exact: true }).first().click();
    await page.waitForFunction(() => [...document.querySelectorAll('.pd-photo img')].length === 2 && [...document.querySelectorAll('.pd-photo img')].every(img => img.complete));
    await page.screenshot({ path: path.join(output, '02-detalhe.png') });
    const route = new URL(await page.getByRole('link', { name: 'ABRIR ROTA' }).getAttribute('href'));
    assert.equal(route.searchParams.get('destination'), 'Rua Exemplo, 120\nMéier • Rio de Janeiro');
    for (const [width, height] of [[320,568], [390,667], [430,932]]) {
      await page.setViewportSize({ width, height });
      const action = page.getByRole('button', { name: 'ENTREGUEI E RECEBI', exact: true });
      await action.scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#partner-home-screen').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'largura ' + width);
      const button = await action.boundingBox(), nav = await page.locator('.ph-nav').boundingBox();
      assert.ok(button.y + button.height <= nav.y + 1, 'menu não cobre ação em ' + width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'ENTREGUEI E RECEBI', exact: true }).click();
    await page.screenshot({ path: path.join(output, '03-pagamento.png') });
    await page.getByRole('button', { name: 'CONFIRMAR ENTREGA', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Escolha como recebeu.' }).waitFor();
    await page.getByRole('button', { name: 'Pix', exact: true }).click();
    await page.getByRole('button', { name: 'CONFIRMAR ENTREGA', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.pd-order').length === 2);
    assert.equal(await page.locator('.pd-order').filter({ hasText: 'João Silva' }).count(), 0);
    await page.getByRole('button', { name: 'VER ENTREGA', exact: true }).first().click();
    await page.getByRole('button', { name: 'ASSUMIR ENTREGA', exact: true }).click();
    await page.getByRole('button', { name: 'INICIAR ENTREGA', exact: true }).click();
    await page.getByRole('button', { name: 'ENTREGUEI E RECEBI', exact: true }).waitFor();
    const problem = page.getByRole('button', { name: 'PROBLEMA NA ENTREGA', exact: true });
    for (const [width, height] of [[320,568], [390,844]]) {
      await page.setViewportSize({ width, height }); await problem.scrollIntoViewIfNeeded();
      const button = await problem.boundingBox(), nav = await page.locator('.ph-nav').boundingBox();
      assert.ok(button.y + button.height <= nav.y + 1, 'menu não cobre problema em ' + width);
    }
    await page.screenshot({ path: path.join(output, '04-botao-problema.png') });
    await problem.click();
    await page.getByRole('button', { name: 'REGISTRAR PROBLEMA', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Informe o que aconteceu' }).waitFor();
    const reason = page.getByRole('textbox', { name: 'Motivo do problema' });
    await reason.fill('Cliente ausente');
    await page.evaluate(() => window.Caixa.partnerHome.render());
    assert.equal(await reason.inputValue(), 'Cliente ausente');
    assert.equal(await reason.evaluate(el => document.activeElement === el), true);
    await page.screenshot({ path: path.join(output, '05-registrar-problema.png') });
    const request = page.waitForRequest(req => req.method() === 'POST' && req.url().includes('/api/entregas/'));
    await page.getByRole('button', { name: 'REGISTRAR PROBLEMA', exact: true }).click();
    assert.deepEqual((await request).postDataJSON(), { delivery_status: 'failed', delivery_courier: 'João Meier', payment_method: null, reason: 'Cliente ausente' });
    await page.getByText('A reserva continua protegida. Procure o responsável da loja.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'ENTREGUEI E RECEBI', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('OK: lista, fotos, rota, assumir/iniciar/concluir, pagamento, registrar problema com motivo, polling, 320/390/430px, zero erros JS. ' + output);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
