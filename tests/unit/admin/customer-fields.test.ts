import { readFileSync } from 'node:fs';
import { createContext,runInContext } from 'node:vm';
import { describe,expect,it } from 'vitest';
const context=createContext({window:{}});
runInContext(readFileSync('painel/public/customer-fields.js','utf8'),context);
const fields=runInContext('window.CustomerFields',context);
describe('máscaras e dados legados',() => {
  it.each(['+5521999994321','5521999994321','21999994321'])('apresenta %s formatado sem alterar a origem',value => {
    expect(fields.phone(value)).toBe('(21) 99999-4321');
    expect(fields.phone(fields.phone(value))).toBe('(21) 99999-4321');
  });
  it('não inventa DDD nem corta dígitos de entradas inválidas',() => {
    expect(fields.phone('2548825')).toBe('2548825');
    expect(fields.nationalPhone('2548825')).toBe(null);
    expect(fields.phoneMask('123456789012345678')).toBe('123456789012345678');
    expect(fields.phoneMask('+12125554321')).toBe('+12125554321');
  });
  it('distingue DDD 55 de código de país',() => {
    expect(fields.phone('55999994321')).toBe('(55) 99999-4321');
    expect(fields.phone('2125488825')).toBe('(21) 2548-8825');
  });
  it('formata documentos e CEP',() => {
    expect(fields.documentMask('52998224725')).toBe('529.982.247-25');
    expect(fields.documentMask('04252011000110')).toBe('04.252.011/0001-10');
    expect(fields.postalMask('24400000')).toBe('24400-000');
    expect(fields.documentMask('123456789012345678')).toBe('123456789012345678');
  });
});
