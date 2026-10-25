import {describe,it,expect} from 'vitest';
import {matrizOrderWindow} from '../../../src/atendente-v2/matriz-order-window.js';
import type {DeliverySettings} from '../../../src/atendente-v2/matriz-delivery-settings.js';
const settings={store_hours:[{day:1,opens_at:'10:15',closes_at:'15:00'}],days:[2],opens_at:'09:00',closes_at:'16:00'} as DeliverySettings;
describe('pedidos 24h da Matriz',()=>{
 it('domingo permite reservar para segunda às 10:15 de Brasília, preservando minutos',()=>{
  const result=matrizOrderWindow(settings,'pickup',new Date('2026-11-01T04:00:00Z'));
  expect(result.allowed).toBe(true);expect(result.notBefore?.toISOString()).toBe('2026-11-02T13:15:00.000Z');
  expect(result.status.state).toBe('closed');
 });
 it('entrega respeita sua janela, sem mudar a abertura da retirada ou prometer entrega naquele minuto',()=>{
  const result=matrizOrderWindow(settings,'delivery',new Date('2026-11-01T04:00:00Z'));
  expect(result.notBefore?.toISOString()).toBe('2026-11-02T13:15:00.000Z');
  expect(result.deliveryNotBefore?.toISOString()).toBe('2026-11-03T12:00:00.000Z');
 });
 it('no dia da abertura, antes do expediente usa a abertura daquele dia',()=>{
  expect(matrizOrderWindow(settings,'pickup',new Date('2026-11-02T12:00:00Z')).notBefore?.toISOString()).toBe('2026-11-02T13:15:00.000Z');
 });
 it('durante o expediente preserva o comportamento e prazo anteriores',()=>{
  expect(matrizOrderWindow(settings,'pickup',new Date('2026-11-02T14:00:00Z'))).toMatchObject({allowed:true,notBefore:null,status:{state:'open'}});
 });
 it('depois de fechar encontra a próxima semana e atravessa a virada do ano',()=>{
  expect(matrizOrderWindow(settings,'pickup',new Date('2026-12-28T19:00:00Z')).notBefore?.toISOString()).toBe('2027-01-04T13:15:00.000Z');
 });
 it.each([null,{...settings,store_hours:null},{...settings,store_hours:[]}])('horário ausente ou sem próxima abertura não autoriza pedido (%j)',value=>{
  expect(matrizOrderWindow(value as DeliverySettings|null,'pickup',new Date('2026-11-01T04:00:00Z'))).toMatchObject({allowed:false,notBefore:null});
 });
 it('não agenda entrega em janela que já encerrou antes da abertura da loja',()=>{
  const value={...settings,days:[1,2],opens_at:'08:00',closes_at:'09:00'};
  expect(matrizOrderWindow(value,'delivery',new Date('2026-11-01T04:00:00Z')).deliveryNotBefore?.toISOString()).toBe('2026-11-03T11:00:00.000Z');
 });
});
