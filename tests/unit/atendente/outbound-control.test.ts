import { beforeEach,describe,expect,it,vi } from 'vitest';
const syncHuman = vi.hoisted(() => vi.fn());
vi.mock('../../../src/atendente-v2/conversation-control.js',() => ({ syncHumanIntervention:syncHuman }));
import { prepareControlledOutbound } from '../../../src/atendente-v2/outbound-control.js';
const row={ id:'out',environment:'test' as const,conversation_id:'a',turn_id:null,
  chatwoot_conversation_id:12,echo_id:'echo',kind:'agent_text',body:'oi',attempts:1 };
function database(allowed=true) {
  return { query:vi.fn().mockImplementation(async (sql:string) =>
    ({ rows:sql.includes('AS allowed') ? [{ allowed }] : [] })) };
}
beforeEach(() => { syncHuman.mockReset().mockResolvedValue({ mode:'auto',resumed_at:null }); });
describe('última trava de envio',() => {
  it.each(['agent_text','survey_text','photo_text','photo_attachment'])('barra %s durante atendimento humano',async kind => {
    syncHuman.mockResolvedValue({ mode:'human',resumed_at:null });
    const db=database();
    expect(await prepareControlledOutbound(db as never,{ ...row,kind })).toBe(false);
    expect(db.query.mock.calls.some(c=>String(c[0]).includes("status='superseded'"))).toBe(true);
  });
  it('não reenvia rascunho antigo depois da retomada nem linha já cancelada',async () => {
    const db=database(false);
    expect(await prepareControlledOutbound(db as never,row)).toBe(false);
    const sql=String(db.query.mock.calls.find(c=>String(c[0]).includes('AS allowed'))?.[0]);
    expect(sql).toContain("o.status='sending'");
    expect(sql).toContain('COALESCE(m.sent_at,o.created_at)>$4');
    expect(sql).toContain("CASE WHEN o.kind='photo_attachment'");
    expect(sql).toContain('p.created_at>$4');
  });
  it('permite envio atual com conversa automática',async () => {
    const db=database();
    expect(await prepareControlledOutbound(db as never,row)).toBe(true);
    expect(db.query.mock.calls.some(c=>String(c[0]).startsWith('UPDATE'))).toBe(false);
  });
  it('interrompe o envio em erro de banco',async () => {
    syncHuman.mockRejectedValue(new Error('database_unavailable'));
    const db=database();
    await expect(prepareControlledOutbound(db as never,row)).rejects.toThrow('database_unavailable');
    expect(db.query).not.toHaveBeenCalled(); // Transação e rollback pertencem ao sender.
  });
});
