import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe,expect,it,vi } from 'vitest';

function panel() {
  const sandbox={window:{PAINEL_MODULES:{}}} as any;
  runInNewContext(readFileSync('painel/public/app.bot.entrega.js','utf8'),sandbox);
  const ui=sandbox.window.PAINEL_MODULES.botEntrega();
  const settings={delivery_enabled:true,pickup_enabled:true,radius_km:12,address:'Matriz teste',latitude:0,longitude:0,
    days:[1],opens_at:'09:00',closes_at:'16:00',delivery_days:1,
    freight:{first_limit_km:5,first_price_brl:9.9,second_limit_km:10,second_price_brl:15,above_price_brl:20}};
  ui.botEntregaForm=ui.botEntregaEditar(settings);
  ui.botEntregaOriginal=JSON.stringify(ui.botEntregaForm);
  ui.botEntregaConfig={settings,version:2,configured:true};
  return ui;
}

describe('funcionamento da loja no painel',()=>{
  it('aplica o horário comum nos dias selecionados e mantém o sábado diferente ao reabrir',()=>{
    const ui=panel();
    ui.botLojaDia(1);ui.botLojaDia(2);
    ui.botLojaAplicarHora('opens_at','08:00');ui.botLojaAplicarHora('closes_at','18:00');
    ui.botLojaDia(6);
    expect(ui.botLojaMostrarPorDia).toBe(false);
    expect(ui.botEntregaPayload().store_hours).toEqual([1,2,6].map(day=>({day,opens_at:'08:00',closes_at:'18:00'})));
    ui.botEntregaForm.store_hours.find((day:any)=>day.day===6).closes_at='13:00';
    expect(ui.botLojaMostrarPorDia).toBe(true);
    const saved=ui.botEntregaPayload();
    ui.botEntregaForm=ui.botEntregaEditar(saved);
    expect(ui.botLojaMostrarPorDia).toBe(true);
    expect(ui.botEntregaPayload().store_hours[2].closes_at).toBe('13:00');
    ui.botLojaUsarMesmoHorario();
    expect(ui.botLojaMostrarPorDia).toBe(false);
    expect(ui.botEntregaPayload().store_hours.every((day:any)=>day.closes_at==='18:00')).toBe(true);
  });
  it('desmarcar um dia conserva seu horário caso seja selecionado novamente',()=>{
    const ui=panel();
    ui.botLojaDia(1);ui.botLojaAplicarHora('opens_at','08:00');ui.botLojaAplicarHora('closes_at','18:00');
    ui.botLojaDia(1);
    expect(ui.botEntregaPayload().store_hours).toBeNull();
    ui.botLojaDia(1);
    expect(ui.botLojaHoraComum('closes_at')).toBe('18:00');
  });
  it('carrega cadastro antigo vazio sem copiar horários de entrega nem marcar alteração',()=>{
    const ui=panel();
    expect(ui.botLojaHorarioConfigurado).toBe(false);
    expect(ui.botEntregaDirty).toBe(false);
    expect(ui.botEntregaPayload().store_hours).toBeNull();
    expect(ui.botEntregaForm.store_hours.every((day:any)=>!day.opens_at&&!day.closes_at)).toBe(true);
  });
  it('salva sábado diferente, recarrega o resultado e mantém dias e horários da entrega',async()=>{
    const ui=panel();
    Object.assign(ui.botEntregaForm.store_hours.find((day:any)=>day.day===1),{enabled:true,opens_at:'08:00',closes_at:'18:00'});
    Object.assign(ui.botEntregaForm.store_hours.find((day:any)=>day.day===6),{enabled:true,opens_at:'08:00',closes_at:'13:00'});
    expect(ui.botEntregaDirty).toBe(true);
    ui.apiPut=vi.fn(async(_url:string,body:any)=>({settings:body.settings,version:3,configured:true}));
    await ui.botEntregaSalvar();
    expect(ui.apiPut).toHaveBeenCalledWith('/admin/api/bot/entrega',expect.objectContaining({expected_version:2,settings:expect.objectContaining({
      days:[1],opens_at:'09:00',closes_at:'16:00',
      store_hours:[{day:1,opens_at:'08:00',closes_at:'18:00'},{day:6,opens_at:'08:00',closes_at:'13:00'}],
    })}));
    expect(ui.botEntregaErro).toBe('');
    expect(ui.botEntregaDirty).toBe(false);
    expect(ui.botEntregaConfig.version).toBe(3);
    expect(ui.botEntregaForm.store_hours.find((day:any)=>day.day===0).enabled).toBe(false);
  });
  it('bloqueia salvamento incompleto e só limpa horários desmarcados no payload',async()=>{
    const ui=panel();
    const saturday=ui.botEntregaForm.store_hours.find((day:any)=>day.day===6);
    saturday.enabled=true;
    ui.apiPut=vi.fn();
    await ui.botEntregaSalvar();
    expect(ui.botEntregaErro).toContain('Funcionamento da loja');
    expect(ui.apiPut).not.toHaveBeenCalled();
    Object.assign(saturday,{opens_at:'18:00',closes_at:'08:00'});
    expect(ui.botEntregaValidar()).toContain('fechamento depois da abertura');
    saturday.enabled=false;
    expect(ui.botEntregaValidar()).toBe('');
    expect(ui.botEntregaPayload().store_hours).toBeNull();
  });
  it('conflito mantém o rascunho local em vez de anunciar sucesso',async()=>{
    const ui=panel();
    Object.assign(ui.botEntregaForm.store_hours[0],{enabled:true,opens_at:'08:00',closes_at:'18:00'});
    ui.apiPut=vi.fn().mockRejectedValue(new Error('delivery_settings_conflict'));
    await ui.botEntregaSalvar();
    expect(ui.botEntregaDirty).toBe(true);
    expect(ui.botEntregaErro).toContain('Outra pessoa salvou');
    expect(ui.botEntregaMensagem).toBe('');
  });
  it('mostra o domingo cadastrado sem assumir que a loja está fechada',()=>{
    const ui=panel();
    expect(ui.botLojaHorarioDia(0)).toBe('Não cadastrado');
    ui.botLojaDia(1);ui.botLojaAplicarHora('opens_at','08:00');ui.botLojaAplicarHora('closes_at','18:00');
    expect(ui.botLojaHorarioDia(0)).toBe('Fechado');
    ui.botLojaDia(0);
    ui.botEntregaForm.store_hours.find((day:any)=>day.day===0).closes_at='12:00';
    expect(ui.botLojaHorarioDia(0)).toBe('08:00 às 12:00');
  });
});

describe('seletor compacto de pneus da simulação',()=>{
  it('envia todos os produtos e quantidades selecionados sem salvar a configuração',async()=>{
    const ui=panel();
    ui.botEntregaAdicionar({id:'a',product_name:'Pneu A',tire_size:'130/70-13'});
    expect(ui.botEntregaSelecaoLabel).toBe('130/70-13 · 1 pneu');
    ui.botEntregaAdicionar({id:'b',product_name:'Pneu B',tire_size:'90/90-12'});
    ui.botEntregaItems[0].quantity=2;
    expect(ui.botEntregaSelecaoLabel).toBe('2 itens · 3 pneus');
    ui.botEntregaAddress='Endereço de teste';ui.botEntregaSeletorAberto=true;
    ui.apiPost=vi.fn(async()=>({selected:false,diagnostics:[]}));ui.apiPut=vi.fn();ui.$nextTick=vi.fn();
    await ui.botEntregaSimular();
    expect(ui.apiPost).toHaveBeenCalledWith('/admin/api/bot/entrega/simular',expect.objectContaining({
      address:'Endereço de teste',items:[{product_id:'a',quantity:2},{product_id:'b',quantity:1}],
    }));
    expect(ui.apiPut).not.toHaveBeenCalled();
    expect(ui.botEntregaSeletorAberto).toBe(false);
    expect(ui.botEntregaStale).toBe(false);
    ui.botEntregaItems[0].quantity=1;
    expect(ui.botEntregaStale).toBe(true);
  });
  it('reabre o seletor quando uma quantidade inválida foi recolhida',async()=>{
    const ui=panel();ui.apiPost=vi.fn();ui.botEntregaAddress='Endereço de teste';
    ui.botEntregaAdicionar({id:'a',product_name:'Pneu A'});
    for(const quantity of ['',0,-1,1.5,51]){
      ui.botEntregaItems[0].quantity=quantity;ui.botEntregaSeletorAberto=false;
      await ui.botEntregaSimular();
      expect(ui.apiPost).not.toHaveBeenCalled();
      expect(ui.botEntregaSeletorAberto).toBe(true);
      expect(ui.botEntregaErro).toContain('quantidade inteira');
    }
  });
});
