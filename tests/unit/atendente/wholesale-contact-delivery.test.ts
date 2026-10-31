import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboundRow } from '../../../src/atendente-v2/outbound-worker.js';

const config = vi.hoisted(() => ({
  BOT_OUTBOX: true, CHATWOOT_API_BASE_URL: 'https://chatwoot.example.test/api/v1',
  CHATWOOT_API_TOKEN: 'chatwoot-fixture-only', CHATWOOT_ACCOUNT_ID: 2,
}));
vi.mock('../../../src/shared/config/env.js', () => ({ env: config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
const sends = vi.hoisted(() => ({ text: vi.fn() }));
vi.mock('../../../src/atendente-v2/sender.js', () => ({
  sendMessageOnce: sends.text, sendAttachmentOnce: vi.fn(), resolveConversationOnce: vi.fn(),
}));
import { tryDeliverWholesaleContact, WHOLESALE_CONTACT } from '../../../src/atendente-v2/wholesale-contact-delivery.js';
import { deliverOutboundRow } from '../../../src/atendente-v2/outbound-delivery.js';
import { ChatwootApiError } from '../../../src/admin/chatwoot-api.client.js';

const row: OutboundRow = {
  id: 'outbound-1', environment: 'test', conversation_id: 'conversation-1', turn_id: 'turn-1',
  chatwoot_conversation_id: 555, kind: 'agent_text', attempts: 1, echo_id: 'turn:turn-1',
  body: 'Pra comprar no atacado, fala com a gente nesse WhatsApp, amigo: (21) 97667-4264.\nhttps://wa.me/5521976674264',
};
const local = { chatwoot_account_id: 2, chatwoot_inbox_id: 39, channel_type: 'whatsapp' };
const conversation = {
  id: 555, account_id: 2, inbox_id: 39, can_reply: true,
  contact_inbox: { source_id: '5521999990001' },
};
const inbox = {
  id: 39, channel_type: 'Channel::Whatsapp', provider: 'whatsapp_cloud',
  provider_config: { api_key: 'meta-fixture-only', phone_number_id: '123456789012345' },
};
const nativeId = 'wamid.fixture-contact-1';
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetcher = vi.fn<typeof fetch>();
const database = () => ({ query: vi.fn().mockResolvedValue({ rows: [local] }) });
const bodyAt = (index: number) => JSON.parse(String(fetcher.mock.calls[index]?.[1]?.body));

beforeEach(() => {
  vi.clearAllMocks(); fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); config.BOT_OUTBOX = true;
  fetcher.mockResolvedValueOnce(response(conversation)).mockResolvedValueOnce(response(inbox))
    .mockResolvedValueOnce(response({ messages: [{ id: nativeId }] }))
    .mockResolvedValueOnce(response({ id: 777, source_id: nativeId }));
  sends.text.mockResolvedValue({ chatwootMessageId: 888 });
});
afterEach(() => vi.unstubAllGlobals());

describe('contato nativo do atacado na outbox', () => {
  it('envia um único cartão ao cliente da conversa e registra o ID real no Chatwoot sem novo envio', async () => {
    const db = database();
    await expect(deliverOutboundRow(db as never, row)).resolves.toEqual({ chatwootMessageId: 777 });
    expect(db.query.mock.calls[0]?.[1]).toEqual(['test', 'conversation-1', 555]);
    expect(fetcher).toHaveBeenCalledTimes(4); expect(sends.text).not.toHaveBeenCalled();
    const [url, options] = fetcher.mock.calls[2]!;
    expect(url).toBe('https://graph.facebook.com/v24.0/123456789012345/messages');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer meta-fixture-only' } });
    const sent = bodyAt(2);
    expect(sent.type).toBe('contacts'); expect(sent.to).toBe(conversation.contact_inbox.source_id);
    expect(sent.to).not.toBe(WHOLESALE_CONTACT.phone);
    expect(sent.contacts).toHaveLength(1);
    expect(sent.contacts[0].name.formatted_name).toBe('2W Pneus — Atacado');
    expect(sent.contacts[0].phones).toEqual([{ phone: '+5521976674264', wa_id: '5521976674264', type: 'WORK' }]);
    expect(bodyAt(3)).toMatchObject({
      source_id: nativeId, message_type: 'outgoing', private: false, echo_id: row.echo_id,
      content_attributes: { farejador_echo_id: row.echo_id },
    });
    expect(bodyAt(3).content_attributes).not.toHaveProperty('external_echo');
    expect(bodyAt(3).content).not.toContain('https://');
    expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(2);
  });

  it.each(['instagram', 'facebook', 'web', null])('mantém o link em %s sem consultar credenciais Meta', async channel_type => {
    const db = database(); db.query.mockResolvedValue({ rows: [{ ...local, channel_type }] });
    await expect(deliverOutboundRow(db as never, row)).resolves.toEqual({ chatwootMessageId: 888 });
    expect(fetcher).not.toHaveBeenCalled(); expect(sends.text).toHaveBeenCalledWith(555, row.body, row.echo_id);
  });

  it.each(['operator_text', 'survey_text', 'photo_text', 'stock_text'])('não converte %s em contato', async kind => {
    const db = database();
    expect(await tryDeliverWholesaleContact(db as never, { ...row, kind })).toBeNull();
    expect(db.query).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['oi', 'https://wa.me/55219766742649', 'https://wa.me/5521976674264/errado',
    'https://other.example/?link=https://wa.me/5521976674264', 'https://wa.me/5521976674264.evil.example'])
  ('não converte texto comum nem URL diferente: %s', async body => {
    const db = database(); expect(await tryDeliverWholesaleContact(db as never, { ...row, body })).toBeNull();
    expect(db.query).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('bloqueia o cartão com a outbox desligada', async () => {
    config.BOT_OUTBOX = false;
    await expect(tryDeliverWholesaleContact(database() as never, row)).rejects.toThrow('outbox delivery is disabled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('barra conversa apagada e erro de banco antes de qualquer envio', async () => {
    const db = database(); db.query.mockResolvedValue({ rows: [] });
    await expect(deliverOutboundRow(db as never, row)).rejects.toThrow('conversation_unavailable');
    db.query.mockRejectedValue(new Error('database_unavailable'));
    await expect(deliverOutboundRow(db as never, row)).rejects.toThrow('database_unavailable');
    expect(fetcher).not.toHaveBeenCalled(); expect(sends.text).not.toHaveBeenCalled();
  });

  it('não usa a credencial em uma conta diferente', async () => {
    const db = database(); db.query.mockResolvedValue({ rows: [{ ...local, chatwoot_account_id: 3 }] });
    await expect(deliverOutboundRow(db as never, row)).rejects.toThrow('account_mismatch');
    expect(fetcher).not.toHaveBeenCalled(); expect(sends.text).not.toHaveBeenCalled();
  });

  it.each([{ id: 666 }, { inbox_id: 40 }, { account_id: 3 }])('barra identidade remota divergente %j', async change => {
    fetcher.mockReset().mockResolvedValueOnce(response({ ...conversation, ...change }));
    await expect(deliverOutboundRow(database() as never, row)).rejects.toThrow('conversation_mismatch');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(sends.text).not.toHaveBeenCalled();
  });

  it('não manda cartão ou texto fora da janela confirmada do WhatsApp', async () => {
    fetcher.mockReset().mockResolvedValueOnce(response({ ...conversation, can_reply: false }));
    await expect(deliverOutboundRow(database() as never, row)).rejects.toThrow('outside confirmed messaging window');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(sends.text).not.toHaveBeenCalled();
  });

  it('não entrega credenciais nem mensagem a caixa divergente', async () => {
    fetcher.mockReset().mockResolvedValueOnce(response(conversation))
      .mockResolvedValueOnce(response({ ...inbox, id: 40 }));
    await expect(deliverOutboundRow(database() as never, row)).rejects.toThrow('inbox_mismatch');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(sends.text).not.toHaveBeenCalled();
  });

  it('usa texto quando o provedor não é Cloud API', async () => {
    fetcher.mockReset().mockResolvedValueOnce(response(conversation))
      .mockResolvedValueOnce(response({ ...inbox, provider: 'baileys' }));
    await deliverOutboundRow(database() as never, row);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(sends.text).toHaveBeenCalledTimes(1);
  });

  it('usa texto se a configuração privada não estiver disponível', async () => {
    fetcher.mockReset().mockResolvedValueOnce(response(conversation))
      .mockResolvedValueOnce(response({ ...inbox, provider_config: {} }));
    await deliverOutboundRow(database() as never, row);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(sends.text).toHaveBeenCalledTimes(1);
  });

  it('não inventa telefone a partir de BSUID nem usa o número do atacado como destinatário', async () => {
    fetcher.mockReset().mockResolvedValueOnce(response({ ...conversation, contact_inbox: { source_id: 'BSUID-only' } }))
      .mockResolvedValueOnce(response(inbox));
    await deliverOutboundRow(database() as never, row);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(sends.text).toHaveBeenCalledTimes(1);
  });

  it('conserva o link quando a consulta falha antes de qualquer POST externo', async () => {
    fetcher.mockReset().mockRejectedValueOnce(new Error('lookup_timeout'));
    await deliverOutboundRow(database() as never, row);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(sends.text).toHaveBeenCalledTimes(1);
  });

  it('permite fallback somente após rejeição explícita do cartão pela Meta', async () => {
    fetcher.mockReset().mockResolvedValueOnce(response(conversation)).mockResolvedValueOnce(response(inbox))
      .mockResolvedValueOnce(response({ error: { code: 100 } }, 400));
    await deliverOutboundRow(database() as never, row);
    expect(fetcher).toHaveBeenCalledTimes(3); expect(sends.text).toHaveBeenCalledTimes(1);
  });

  it('deixa 429 para o retry persistente, sem repetir em memória nem mandar texto', async () => {
    fetcher.mockReset().mockResolvedValueOnce(response(conversation)).mockResolvedValueOnce(response(inbox))
      .mockResolvedValueOnce(response({}, 429));
    await expect(deliverOutboundRow(database() as never, row)).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(3); expect(sends.text).not.toHaveBeenCalled();
  });

  it.each(['network', '5xx', 'invalid_json', 'missing_id'])('não reenvia nem faz fallback com resultado ambíguo: %s', async kind => {
    fetcher.mockReset().mockResolvedValueOnce(response(conversation)).mockResolvedValueOnce(response(inbox));
    if (kind === 'network') fetcher.mockRejectedValueOnce(new Error('timeout_secret_fixture'));
    else if (kind === '5xx') fetcher.mockResolvedValueOnce(response({}, 503));
    else if (kind === 'invalid_json') fetcher.mockResolvedValueOnce(new Response('invalid JSON'));
    else fetcher.mockResolvedValueOnce(response({ messages: [] }));
    await expect(deliverOutboundRow(database() as never, row)).rejects.toMatchObject({ status: null });
    expect(fetcher).toHaveBeenCalledTimes(3); expect(sends.text).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'network', 'wrong_id'])('cartão já aceito exige conciliação se o registro falhar: %s', async kind => {
    fetcher.mockReset().mockResolvedValueOnce(response(conversation)).mockResolvedValueOnce(response(inbox))
      .mockResolvedValueOnce(response({ messages: [{ id: nativeId }] }));
    if (kind === 'rejected') fetcher.mockResolvedValueOnce(response({}, 422));
    else if (kind === 'network') fetcher.mockRejectedValueOnce(new Error('mirror_timeout'));
    else fetcher.mockResolvedValueOnce(response({ id: 777, source_id: 'different' }));
    await expect(deliverOutboundRow(database() as never, row)).rejects.toMatchObject({
      status: null, message: 'WhatsApp contact accepted; Chatwoot record requires reconciliation',
    });
    expect(fetcher).toHaveBeenCalledTimes(4); expect(sends.text).not.toHaveBeenCalled();
  });

  it('usa a classe de erro que a outbox trata como resultado desconhecido sem retry cego', async () => {
    fetcher.mockReset().mockResolvedValueOnce(response(conversation)).mockResolvedValueOnce(response(inbox))
      .mockRejectedValueOnce(new Error('timeout'));
    await expect(deliverOutboundRow(database() as never, row)).rejects.toBeInstanceOf(ChatwootApiError);
  });
});
