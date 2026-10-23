import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect,it } from 'vitest';

it('o login só retorna aos caminhos do Dot no mesmo site, bloqueando redirecionamento aberto',()=>{
  const source=readFileSync('painel/public/login.js','utf8');
  const declaration=source.match(/function matrixDestination\(\) \{[\s\S]*?return '\/admin\/painel';\s*\}/)![0];
  const origin='https://farejador.example';
  const target=(value:string)=>runInNewContext(declaration+';matrixDestination()',{
    URL,URLSearchParams,location:{origin,search:'?'+new URLSearchParams({dot_return:value})}});
  expect(target('/admin/dot/authorize?state=example')).toBe('/admin/dot/authorize?state=example');
  expect(target('/admin/dot/connections')).toBe('/admin/dot/connections');
  for(const attack of ['https://evil.example/admin/dot/authorize','//evil.example/admin/dot/authorize',
    '/admin/dot/authorize#evil','/admin/api/auth/bootstrap','javascript:alert(1)','/admin/dot/authorize/../other']) {
    expect(target(attack)).toBe('/admin/painel');
  }
});
