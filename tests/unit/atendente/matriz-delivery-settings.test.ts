import { describe,it,expect } from 'vitest';
import { deliverySettingsSchema,matrizCoverageBlock,matrizScheduleText,applyMatrizDeliveryPolicies,type DeliverySettings } from '../../../src/atendente-v2/matriz-delivery-settings.js';
import { DEFAULT_MATRIZ_FREIGHT } from '../../../src/atendente-v2/matriz-freight.js';
import { matrizStoreHoursText } from '../../../src/atendente-v2/matriz-store-hours.js';
const settings:DeliverySettings={delivery_enabled:true,pickup_enabled:true,radius_km:12,
  address:'Matriz São Gonçalo',latitude:-22.8777701,longitude:-42.9900824,
  days:[1,2,3,4,5],opens_at:'08:00',closes_at:'18:00',delivery_days:1,freight:{...DEFAULT_MATRIZ_FREIGHT}};
describe('limites de entrega da Matriz',()=>{
  const storeHours=[{day:1,opens_at:'08:00',closes_at:'18:00'},{day:6,opens_at:'08:00',closes_at:'13:00'}];
  it('separa atendimento da loja da entrega e informa sábado e dias fechados',()=>{
    const configured=deliverySettingsSchema.parse({...settings,store_hours:storeHours});
    const result=applyMatrizDeliveryPolicies([],{settings:configured,version:3,updated_at:'2026-09-15'});
    const hours=result.find(p=>p.policy_key==='horario_funcionamento')!;
    expect(hours.policy_version).toBe('matriz-delivery-3');
    expect(hours.policy_value).toContain('sábado: 08:00 às 13:00');
    expect(hours.policy_value).toContain('domingo: fechado');
    expect(hours.policy_value).toContain('Horário de Brasília');
    expect(result.find(p=>p.policy_key==='prazo_entrega_descricao')?.policy_value).toContain('18:00');
    expect(matrizStoreHoursText(null)).toBeNull();
    expect(matrizStoreHoursText(undefined)).toBeNull();
  });
  it('limpar cadastro retira horário antigo sem assumir a janela de entrega',()=>{
    const previous={policy_key:'horario_funcionamento',policy_value:'antigo',policy_version:'v1',description:null};
    const result=applyMatrizDeliveryPolicies([previous],{settings:{...settings,store_hours:null},version:4,updated_at:'2026-09-15'});
    const hours=result.filter(p=>p.policy_key==='horario_funcionamento');
    expect(hours).toHaveLength(1);
    expect(hours[0]?.policy_value).toContain('não cadastrado');
    expect(hours[0]?.policy_value).not.toContain('18:00');
  });
  it.each([
    [],[storeHours[0],storeHours[0]],[{day:7,opens_at:'08:00',closes_at:'18:00'}],
    [{day:1,opens_at:'25:00',closes_at:'18:00'}],[{day:1,opens_at:'08:00',closes_at:null}],
    [{day:1,opens_at:'18:00',closes_at:'08:00'}],[{day:1,opens_at:'08:00',closes_at:'08:00'}],
  ].map(hours=>({hours})))('rejeita cadastro de funcionamento inválido: %j',({hours})=>{
    expect(deliverySettingsSchema.safeParse({...settings,store_hours:hours}).success).toBe(false);
  });
  it('lê cadastro anterior com o mesmo frete e sem ampliar o raio salvo',()=>{
    const {freight,...previous}=settings;
    expect(deliverySettingsSchema.parse(previous)).toEqual(settings);
  });
  it('aceita até 55 km e bloqueia imediatamente fora da cobertura',()=>{
    const extended=deliverySettingsSchema.parse({...settings,radius_km:55});
    expect(matrizCoverageBlock(extended,'delivery',55)).toBeNull();
    expect(matrizCoverageBlock(extended,'delivery',55.01)).toBe('outside_radius');
    expect(deliverySettingsSchema.safeParse({...settings,radius_km:55.01}).success).toBe(false);
  });
  it.each([{first_limit_km:0},{second_limit_km:15},{second_limit_km:14},{second_limit_km:56},
    {first_price_brl:-1},{second_price_brl:1.999},{above_price_brl:10001},{above_price_brl:null}])('rejeita tabela inválida: %j',patch=>{
    expect(deliverySettingsSchema.safeParse({...settings,freight:{...settings.freight,...patch}}).success).toBe(false);
  });
  it('permite frete grátis sem confundir zero com campo vazio',()=>{
    expect(deliverySettingsSchema.parse({...settings,freight:{...settings.freight,first_price_brl:0}}).freight.first_price_brl).toBe(0);
  });
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
