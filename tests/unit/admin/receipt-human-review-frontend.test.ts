import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const modulePath = resolve('painel/public/app.logistica.comprovantes.js');

function read(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

describe('Etapa 7 — fila administrativa de aprovacao humana', () => {
  it('nasce em modulo-fabrica proprio sem aumentar app.js', () => {
    expect(existsSync(modulePath)).toBe(true);
    const module = readFileSync(modulePath, 'utf8');
    const app = read('painel/public/app.js');

    expect(module).toContain('window.PAINEL_MODULES');
    expect(module).toContain('receiptActionKey');
    expect(app.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(300);
    expect(app).not.toContain('receiptActionKey');
  });

  it('serve e inclui o modulo com cache-bust explicito', () => {
    const staticRoute = read('src/admin/painel/route-static.ts');
    const html = read('painel/public/index.html');

    expect(staticRoute).toContain("'app.logistica.comprovantes.js'");
    expect(html).toMatch(/app\.logistica\.comprovantes\.js\?v=20260717-[a-z0-9-]+/);
  });

  it('evita as tres armadilhas conhecidas do front da casa', () => {
    const module = readFileSync(modulePath, 'utf8');
    const html = read('painel/public/index.html');

    expect(module).not.toContain('x-transition');
    expect(module).not.toContain('window.confirm');
    expect(module).toContain("this.adminUser?.role === 'owner'");
    expect(html).toContain("adminUser?.role === 'owner'");
    expect(html).toMatch(/:disabled="!![^\"]+"/);
  });

  it('reusa a mesma chave em retry e separa erro do admin e do entregador', () => {
    const module = readFileSync(modulePath, 'utf8');
    const courier = read('painel/public/entregas.js');

    expect(module).toContain('duplicate_trip_number');
    expect(module).toContain('Este comprovante já está na');
    expect(courier).not.toContain('duplicate_trip_number');
    expect(courier).toContain('Este arquivo já foi usado em outro comprovante');
  });
});
