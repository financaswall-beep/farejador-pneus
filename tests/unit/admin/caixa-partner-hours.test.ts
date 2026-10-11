import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe,expect,it } from 'vitest';
import { weeklyStoreHoursStatus } from '../../../src/shared/weekly-store-hours.js';

const script=readFileSync(new URL('../../../painel/public/caixa-partner-hours.js',import.meta.url),'utf8');
const monday=[{day:1,opens_at:'08:00',closes_at:'18:00'}];
function frontend(hours:unknown,date:string) {
  const NativeDate=Date;
  class FixedDate extends NativeDate { constructor(){super(date);} }
  const Caixa:{partnerUI:object;partnerHours?:{preview:(value:unknown)=>{state:string;text:string}}}={partnerUI:{}};
  vm.runInNewContext(script,{window:{Caixa},Intl,Date:FixedDate});
  return Caixa.partnerHours!.preview(hours);
}
describe('prévia do app e cálculo do bot concordam',()=>{
  it.each(['2026-10-05T10:59:00Z','2026-10-05T11:00:00Z','2026-10-05T20:59:59Z',
    '2026-10-05T21:00:00Z','2026-10-05T01:00:00Z','2026-10-04T21:00:00Z',
    '2026-10-06T12:00:00Z'])('mesmo estado e horário em %s',date=>{
    const backend=weeklyStoreHoursStatus(monday,new Date(date)),app=frontend(monday,date);
    expect(app.state).toBe(backend.state);
    expect(app.text.match(/\d{2}:\d{2}/)?.[0]).toBe(backend.text.match(/\d{2}:\d{2}/)?.[0]);
    if(backend.next_opening?.days_ahead===0)expect(app.text).toContain('hoje');
    if(backend.next_opening?.days_ahead===1)expect(app.text).toContain('amanhã');
  });
  it.each([null,[]])('cadastro ausente ou todos os dias fechados: %j',hours=>{
    expect(frontend(hours,'2026-10-05T12:00:00Z').state).toBe(weeklyStoreHoursStatus(hours as null|[],new Date('2026-10-05T12:00:00Z')).state);
  });
});
