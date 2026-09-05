import { describe,expect,it,vi } from 'vitest';
import { botMayProcessTrigger,lockBotConversation,syncHumanIntervention } from '../../../src/atendente-v2/conversation-control.js';

function database(mode='auto', human: unknown=null, allowed=true) {
  const state = { mode,version:0,resumed_at:null,last_human_at:null,last_human_message_id:null };
  const query=vi.fn().mockImplementation(async (sql:string) => {
    if (sql.startsWith('SELECT mode,version')) return { rows:[state] };
    if (sql.includes('SELECT m.chatwoot_message_id,m.sent_at')) return { rows:human ? [human] : [] };
    if (sql.startsWith('UPDATE ops.conversation_bot_control')) {
      state.mode='human'; state.version++; return { rows:[state] };
    }
    if (sql.includes('AS allowed')) return { rows:[{ allowed }] };
    return { rows:[] };
  });
  return { query,state };
}

describe('pausa silenciosa por conversa',() => {
  it('bloqueia gatilhos enquanto a conversa está em atendimento humano',async () => {
    const db=database('human');
    expect(await botMayProcessTrigger(db as never,'test','a','trigger')).toBe(false);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });
  it('libera somente gatilhos novos de clientes públicos da mesma conversa e ambiente',async () => {
    const db=database();
    expect(await botMayProcessTrigger(db as never,'test','a','trigger')).toBe(true);
    const sql=String(db.query.mock.calls.find(c=>String(c[0]).includes('AS allowed'))?.[0]);
    expect(sql).toContain('environment=$1 AND conversation_id=$2 AND id=$3');
    expect(sql).toContain("sender_type='contact' AND is_private=false");
    expect(sql).toContain('sent_at>$4');
    expect(await botMayProcessTrigger(database('auto',null,false) as never,'test','a','old-trigger')).toBe(false);
  });
  it('registra intervenção, audita e cancela filas somente da conversa afetada',async () => {
    const db=database('auto',{ chatwoot_message_id:'123',sent_at:new Date() });
    expect((await syncHumanIntervention(db as never,'prod','a')).mode).toBe('human');
    for (const [sql,values] of db.query.mock.calls.filter(c=>String(c[0]).startsWith('UPDATE ops.'))) {
      expect(sql).toContain('environment=$1 AND conversation_id=$2');
      expect(values.slice(0,2)).toEqual(['prod','a']);
    }
    expect(db.query.mock.calls.some(c=>String(c[0]).includes('conversation_bot_control_events'))).toBe(true);
  });
  it('ignora notas, atividades e bot correlacionado; não usa o nome ou texto como autoria',async () => {
    const db=database();
    await syncHumanIntervention(db as never,'prod','a');
    const sql=String(db.query.mock.calls.find(c=>String(c[0]).includes('SELECT m.chatwoot_message_id'))?.[0]);
    expect(sql).toContain("m.sender_type='user'");
    expect(sql).toContain('m.message_type=1 AND m.is_private=false');
    expect(sql).toContain('o.environment=m.environment AND o.conversation_id=m.conversation_id');
    expect(sql).toContain('o.provider_message_id=m.chatwoot_message_id');
    expect(sql).toContain('farejador_echo_id');
    expect(sql).toContain('o.attempts>0');
    expect(db.query.mock.calls.some(c=>String(c[0]).startsWith('UPDATE'))).toBe(false);
  });
  it('falha fechada com rollback se o controle não puder ser lido',async () => {
    const db={ query:vi.fn().mockImplementation(async (sql:string) => {
      if (sql.includes('INSERT INTO ops.conversation_bot_control')) throw new Error('database_unavailable');
      return { rows:[] };
    }) };
    await expect(botMayProcessTrigger(db as never,'test','a','trigger')).rejects.toThrow('database_unavailable');
    expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it('envio e intervenção compartilham chave de lock escopada',async () => {
    const db=database();
    await lockBotConversation(db as never,'test','a');
    expect(db.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(db.query.mock.calls[0][1]).toEqual(['bot-control:test:a']);
  });
});
