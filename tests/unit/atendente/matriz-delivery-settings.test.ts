import { describe,it,expect } from 'vitest';
import { deliverySettingsSchema,matrizCoverageBlock,matrizScheduleText,applyMatrizDeliveryPolicies,type DeliverySettings } from '../../../src/atendente-v2/matriz-delivery-settings.js';
const settings:DeliverySettings={delivery_enabled:true,pickup_enabled:true,radius_km:12,
  address:'Matriz São Gonçalo',latitude:-22.8777701,longitude:-42.9900824,
  days:[1,2,3,4,5],opens_at:'08:00',closes_at:'18:00',delivery_days:1};
describe('limites de entrega da Matriz',()=>{
  it('substitui área, endereço e prazo antigos sem alterar o horário da loja e a garantia',()=>{
    const policies=['area_entrega','endereco','prazo_entrega_descricao','rotas_hoje','horario_funcionamento','garantia_descricao']
      .map(policy_key=>({policy_key,policy_value:'antigo',policy_version:'v1',description:null}));
    const result=applyMatrizDeliveryPolicies(policies,{settings,version:2,updated_at:'2026-09-09'});
    expect(result.filter(p=>p.policy_key==='endereco')).toHaveLength(1);
    expect(result.find(p=>p.policy_key==='endereco')?.policy_value).toBe(settings.address);
    expect(result.find(p=>p.policy_key==='prazo_entrega_descricao')?.policy_value).toContain('Somente para entregas da Matriz');
    expect(result.find(p=>p.policy_key==='horario_funcionamento')?.policy_value).toBe('antigo');
    expect(result.find(p=>p.policy_key==='garantia_descricao')?.policy_value).toBe('antigo');
    expect(result.some(p=>p.policy_key==='rotas_hoje')).toBe(false);
  });
  it('sem cadastro não ativa limite nem pausa a operação antiga',()=>{
    expect(matrizCoverageBlock(null,'delivery',null)).toBeNull();
  });
  it('cidade não permite ignorar distância desconhecida ou maior que o limite',()=>{
    expect(matrizCoverageBlock(settings,'delivery',null)).toBe('needs_location');
    expect(matrizCoverageBlock(settings,'delivery',12)).toBeNull();
    expect(matrizCoverageBlock(settings,'delivery',12.01)).toBe('outside_radius');
  });
  it('pausar entrega preserva retirada e o raio não limita quem vai buscar',()=>{
    const paused={...settings,delivery_enabled:false};
    expect(matrizCoverageBlock(paused,'delivery',1)).toBe('delivery_paused');
    expect(matrizCoverageBlock(paused,'pickup',100)).toBeNull();
    expect(matrizCoverageBlock({...settings,pickup_enabled:false},'pickup',1)).toBe('pickup_disabled');
  });
  it('não salva entrega habilitada sem raio nem horários inválidos',()=>{
    expect(deliverySettingsSchema.safeParse({...settings,radius_km:null}).success).toBe(false);
    expect(deliverySettingsSchema.safeParse({...settings,closes_at:'07:00'}).success).toBe(false);
    expect(deliverySettingsSchema.safeParse({...settings,days:[1,1]}).success).toBe(false);
    expect(deliverySettingsSchema.safeParse({...settings,days:[]}).success).toBe(false);
    expect(deliverySettingsSchema.safeParse({...settings,delivery_enabled:false,radius_km:null}).success).toBe(true);
  });
  it('o prazo informado não é atribuído aos parceiros ou prometido fora da janela',()=>{
    expect(matrizScheduleText(settings)).toContain('Somente para entregas da Matriz');
    expect(matrizScheduleText(settings)).toContain('Não aplicar esse prazo aos parceiros');
    expect(matrizScheduleText({...settings,delivery_days:null})).toContain('Prazo não cadastrado');
  });
});
