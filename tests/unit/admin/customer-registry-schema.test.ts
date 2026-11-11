import { describe, expect, it } from 'vitest';
import { createRegistrySchema,registryFields,validDocument } from '../../../src/admin/painel/customer-registry-schema.js';
const valid = {name:'  João   da Silva ',commercial_profile:'varejo',phone:'(21) 99999-4321',email:'  JOAO@EXAMPLE.COM ',
  document_number:'',postal_code:'24400-000',street:' Rua   Um ',number:'S/N',complement:'',neighborhood:'',city:'São Gonçalo',state:'rj'};
describe('cadastro padronizado de clientes',() => {
  it('normaliza sem remover acentos nem alterar nomes de empresas',() => {
    expect(registryFields.parse(valid)).toMatchObject({name:'João da Silva',phone:'+5521999994321',email:'joao@example.com',
      postal_code:'24400000',street:'Rua Um',state:'RJ'});
    expect(registryFields.parse({...valid,name:'2W Pneus LTDA'}).name).toBe('2W Pneus LTDA');
  });
  it.each(['2548825','999994321','(20) 99999-4321','2199994321','+55212548825','21abc999994321','+12125554321'])('recusa telefone incompleto/inválido %s sem completar dígitos',phone => {
    expect(registryFields.safeParse({...valid,phone}).success).toBe(false);
  });
  it.each(['(21) 2548-8825','+5521999994321','5521999994321','(55) 99999-4321'])('aceita telefone completo %s',phone => {
    expect(registryFields.safeParse({...valid,phone}).success).toBe(true);
  });
  it('campos opcionais vazios não exigem coleta adicional',() => {
    expect(registryFields.parse({...valid,phone:'',email:'',postal_code:'',state:''})).toMatchObject({phone:null});
  });
  it.each(['529.982.247-25','04.252.011/0001-10'])('valida dígitos verificadores de %s',document => {
    expect(validDocument(document)).toBe(true);
    expect(validDocument(document.slice(0,-1)+'9')).toBe(false);
  });
  it.each([{document_number:'111.111.111-11'},{postal_code:'24400'},{state:'XX'},{email:'abc'},{name:'   '},{street:'\u0000'}])('rejeita dados inválidos',patch => {
    expect(registryFields.safeParse({...valid,...patch}).success).toBe(false);
  });
  it('não aceita ambiente, SQL ou IDs de origem escolhidos no formulário',() => {
    expect(createRegistrySchema.safeParse({...valid,idempotency_key:'10000000-0000-4000-8000-000000000001',environment:'prod'}).success).toBe(false);
  });
  it('exige perfil comercial explícito no cadastro manual novo',() => {
    expect(createRegistrySchema.safeParse({...valid,idempotency_key:'10000000-0000-4000-8000-000000000001',commercial_profile:'nao_classificado'}).success).toBe(false);
  });
});
