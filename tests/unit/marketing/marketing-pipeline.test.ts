import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let extractAdReferral: typeof import('../../../src/marketing/referrals.js').extractAdReferral;
let captureAdReferralAfterMessageUpsert:
  typeof import('../../../src/marketing/referrals.js').captureAdReferralAfterMessageUpsert;
let buildCapiPayload: typeof import('../../../src/marketing/capi.js').buildCapiPayload;
let enqueueCapiPurchases: typeof import('../../../src/marketing/capi.js').enqueueCapiPurchases;
let pollCapiOutbox: typeof import('../../../src/marketing/capi.js').pollCapiOutbox;
let sendLatestCapiTestPurchase:
  typeof import('../../../src/marketing/capi-test.js').sendLatestCapiTestPurchase;
let sendCapiPayload: typeof import('../../../src/marketing/capi-transport.js').sendCapiPayload;
let syncMetaInsights: typeof import('../../../src/marketing/meta-sync.js').syncMetaInsights;
let reconcileMarketingAttributions:
  typeof import('../../../src/marketing/attribution.js').reconcileMarketingAttributions;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'test-admin-token',
    META_WHATSAPP_BUSINESS_ACCOUNT_ID: '123456789',
    META_CAPI_DATASET_ID: '987654321',
    META_CAPI_ACCESS_TOKEN: 'capi-test-token',
    META_CAPI_TEST_EVENT_CODE: 'TEST42',
  });
  ({ extractAdReferral, captureAdReferralAfterMessageUpsert } = await import(
    '../../../src/marketing/referrals.js'
  ));
  ({ buildCapiPayload, enqueueCapiPurchases, pollCapiOutbox } = await import(
    '../../../src/marketing/capi.js'
  ));
  ({ sendLatestCapiTestPurchase } = await import('../../../src/marketing/capi-test.js'));
  ({ sendCapiPayload } = await import('../../../src/marketing/capi-transport.js'));
  ({ syncMetaInsights } = await import('../../../src/marketing/meta-sync.js'));
  ({ reconcileMarketingAttributions } = await import('../../../src/marketing/attribution.js'));
});

describe('pipeline determinístico de Marketing', () => {
  it('normaliza referral snake/camel case e isola falha da migration', async () => {
    expect(extractAdReferral({
      referral: {
        ctwa_clid: 'clid-real',
        source_id: 'ad-42',
        source_url: 'https://example.test/ad',
        headline: 'Pneu',
      },
    })).toMatchObject({ ctwaClid: 'clid-real', sourceId: 'ad-42' });
    expect(extractAdReferral({ referral: { ctwaClid: 'camel', sourceId: 'ad-2' } }))
      .toMatchObject({ ctwaClid: 'camel', sourceId: 'ad-2' });
    expect(extractAdReferral({ referral: { source_id: 'sem-clid' } })).toBeNull();

    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO marketing.ad_referrals')) throw new Error('relation_missing');
      return { rows: [], rowCount: 0 };
    });
    await expect(captureAdReferralAfterMessageUpsert(
      { query } as unknown as PoolClient,
      'test',
      {
        sentAt: new Date('2026-07-26T12:00:00Z'),
        senderType: 'contact',
        isPrivate: false,
        contentAttributes: { referral: { ctwa_clid: 'clid-real' } },
        chatwootMessageId: 42,
      },
      { conversationId: 'conv-1', messageId: 'msg-1' },
    )).resolves.toBeUndefined();
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'SAVEPOINT marketing_referral_capture',
      expect.stringContaining('INSERT INTO marketing.ad_referrals'),
      'ROLLBACK TO SAVEPOINT marketing_referral_capture',
    ]);
  });

  it('monta Purchase mínimo, com hashes somente quando autorizados', () => {
    const row = {
      attribution_id: 'attr-1',
      order_number: 'PED-0042',
      total_amount: '799.90',
      realized_at: '2026-07-26T12:00:00.000Z',
      phone_e164: '+55 (21) 99999-0000',
      channel: 'whatsapp' as const,
      ctwa_clid: 'clid-real',
      user_scoped_id: null,
      business_account_id: null,
      ad_account_id: 'act_123',
      campaign_id: 'camp-1',
      campaign_scope_id: 'scope-1',
      city_name: 'São Gonçalo',
      state_code: 'RJ',
      postal_code_prefix: '24400',
    };
    const minimal = buildCapiPayload(row, {
      whatsappBusinessAccountId: 'waba-1',
      pageId: 'page-1',
      testEventCode: 'TEST42',
    }) as {
      data: Array<{ user_data: Record<string, unknown>; event_id: string }>;
      test_event_code: string;
    };
    expect(minimal.data[0]?.event_id).toBe('PED-0042');
    expect(minimal.data[0]?.user_data).toEqual({
      ctwa_clid: 'clid-real',
      whatsapp_business_account_id: 'waba-1',
      page_id: 'page-1',
      ph: [createHash('sha256').update('5521999990000').digest('hex')],
    });
    expect(minimal.test_event_code).toBe('TEST42');

    const extended = buildCapiPayload(row, {
      whatsappBusinessAccountId: 'waba-1',
      extendedMatching: true,
    }) as { data: Array<{ user_data: Record<string, unknown> }> };
    expect(extended.data[0]?.user_data).toMatchObject({
      ct: [expect.stringMatching(/^[a-f0-9]{64}$/)],
      st: [expect.stringMatching(/^[a-f0-9]{64}$/)],
      zp: [expect.stringMatching(/^[a-f0-9]{64}$/)],
      country: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });

    const messenger = buildCapiPayload({
      ...row,
      channel: 'messenger',
      ctwa_clid: null,
      user_scoped_id: 'psid-123',
      business_account_id: 'page-456',
    }, {}) as { data: Array<{ messaging_channel: string; user_data: Record<string, unknown> }> };
    expect(messenger.data[0]).toMatchObject({
      messaging_channel: 'messenger',
      user_data: { page_id: 'page-456', page_scoped_user_id: 'psid-123' },
    });

    const instagram = buildCapiPayload({
      ...row,
      channel: 'instagram',
      ctwa_clid: null,
      user_scoped_id: 'igsid-123',
      business_account_id: 'ig-456',
    }, {}) as { data: Array<{ messaging_channel: string; user_data: Record<string, unknown> }> };
    expect(instagram.data[0]).toMatchObject({
      messaging_channel: 'instagram',
      user_data: { ig_account_id: 'ig-456', ig_sid: 'igsid-123' },
    });
  });

  it('enfileira somente compras recentes e nunca leva o código de teste para produção', async () => {
    const source = {
      attribution_id: 'attr-1',
      order_number: 'PED-0042',
      total_amount: '799.90',
      realized_at: '2026-07-26T12:00:00.000Z',
      phone_e164: '+5521999990000',
      channel: 'whatsapp',
      ctwa_clid: 'clid-real',
      user_scoped_id: null,
      business_account_id: null,
      city_name: null,
      state_code: null,
      postal_code_prefix: null,
    };
    const query = vi.fn(async (sql: string, _params?: unknown[]) => (
      sql.includes('FROM marketing.order_attributions')
        ? { rows: [source], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    ));
    const dbPool = { query } as unknown as Pool;

    await expect(enqueueCapiPurchases({
      dbPool,
      enabled: true,
      whatsappEnabled: true,
    })).resolves.toBe(1);

    expect(query.mock.calls[0]?.[0]).toContain("interval '6 days 23 hours'");
    expect(query.mock.calls[0]?.[0]).toContain('NOT EXISTS');
    const persistedPayload = JSON.parse(String(query.mock.calls[1]?.[1]?.[4])) as {
      test_event_code?: string;
    };
    expect(persistedPayload.test_event_code).toBeUndefined();
  });

  it('não enfileira WhatsApp quando somente outro canal está habilitado', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        attribution_id: 'attr-whatsapp-off',
        order_number: 'PED-WHATSAPP-OFF',
        total_amount: '100.00',
        realized_at: '2026-07-26T12:00:00.000Z',
        phone_e164: '+5521999990000',
        channel: 'whatsapp',
        ctwa_clid: 'clid-real',
        user_scoped_id: null,
        business_account_id: null,
        ad_account_id: 'act_123',
        campaign_id: 'camp-1',
        campaign_scope_id: 'scope-1',
        city_name: null,
        state_code: null,
        postal_code_prefix: null,
      }],
      rowCount: 1,
    }));

    await expect(enqueueCapiPurchases({
      dbPool: { query } as unknown as Pool,
      enabled: true,
      whatsappEnabled: false,
      messengerEnabled: true,
      instagramEnabled: false,
    })).resolves.toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('envia Test Events diretamente sem inserir nem consumir a outbox', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        attribution_id: 'attr-2',
        order_number: 'PED-0043',
        total_amount: '450.00',
        realized_at: '2026-07-26T13:00:00.000Z',
        phone_e164: '+5521988880000',
        channel: 'whatsapp',
        ctwa_clid: 'clid-test',
        user_scoped_id: null,
        business_account_id: null,
        ad_account_id: 'act_123',
        campaign_id: 'camp-1',
        campaign_scope_id: 'scope-1',
        city_name: null,
        state_code: null,
        postal_code_prefix: null,
      }],
      rowCount: 1,
    }));
    const dbPool = { query } as unknown as Pool;
    const fetcher = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => (
      new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ));

    const result = await sendLatestCapiTestPurchase({
      dbPool,
      fetcher: fetcher as typeof fetch,
      config: {
        whatsappBusinessAccountId: 'waba-test',
        testEventCode: 'TEST42',
        datasetId: 'dataset-test',
        accessToken: 'token-test',
        apiVersion: 'v21.0',
      },
    });

    expect(result).toEqual({
      processed: true,
      events_received: 1,
      fbtrace_id: 'trace-test',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("interval '6 days 23 hours'");
    expect(query.mock.calls[0]?.[0]).not.toContain('capi_outbox');
    const requestBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      test_event_code?: string;
    };
    expect(requestBody.test_event_code).toBe('TEST42');
  });

  it('preserva o diagnóstico sanitizado da Meta sem vazar dados sensíveis', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 100,
        message: 'Invalid parameter:\nuser_data access_token=segredo +5521988880000',
        error_user_msg: 'Use a supported field',
      },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(sendCapiPayload({ data: [] }, {
      fetcher: fetcher as typeof fetch,
      datasetId: 'dataset-test',
      accessToken: 'token-test',
      apiVersion: 'v21.0',
    })).rejects.toThrow(
      'meta_capi_100:Invalid parameter: user_data access_token=[redacted] [redacted] - Use a supported field',
    );
  });

  it('manda evento vencido para dead-letter sem chamar a Meta', async () => {
    const eventTime = Math.floor(new Date('2026-07-01T12:00:00.000Z').getTime() / 1000);
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-old',
          environment: 'test',
          payload: { data: [{ event_time: eventTime }] },
          attempts: 1,
          attribution_id: 'attr-old',
          campaign_scope_id: 'scope-1',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ scope: 'matrix' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const dbPool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const fetcher = vi.fn();

    await expect(pollCapiOutbox({
      dbPool,
      fetcher: fetcher as typeof fetch,
      now: new Date('2026-07-26T12:00:00.000Z'),
      scopeEnforcement: true,
    })).resolves.toBe(true);

    expect(fetcher).not.toHaveBeenCalled();
    const deadLetterQuery = clientQuery.mock.calls.find(([sql]) => (
      String(sql).includes("status='dead_letter'")
    ));
    expect(deadLetterQuery?.[0]).toContain("last_error_code='event_time_expired'");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('suprime Purchase se a campanha sair do escopo antes do envio', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-external',
          environment: 'test',
          payload: { data: [{ event_time: 1785528000 }] },
          attempts: 1,
          attribution_id: 'attr-external',
          campaign_scope_id: 'scope-external',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ scope: 'external' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const dbPool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const fetcher = vi.fn();

    await expect(pollCapiOutbox({
      dbPool,
      fetcher: fetcher as typeof fetch,
      now: new Date('2026-07-31T20:00:00Z'),
      scopeEnforcement: true,
    })).resolves.toBe(true);

    expect(fetcher).not.toHaveBeenCalled();
    const suppression = clientQuery.mock.calls.find(([sql]) => (
      String(sql).includes("status='suppressed'")
    ));
    expect(suppression?.[1]?.[2]).toBe('campaign_scope_external');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('preserva o envio legado enquanto o enforcement de escopo está desligado', async () => {
    const eventTime = Math.floor(new Date('2026-07-31T19:00:00Z').getTime() / 1000);
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-legacy', environment: 'test', attempts: 1,
          attribution_id: 'attr-legacy', campaign_scope_id: null,
          payload: { data: [{ event_time: eventTime }] },
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const dbPool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      events_received: 1,
      fbtrace_id: 'legacy-trace',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(pollCapiOutbox({
      dbPool,
      fetcher: fetcher as typeof fetch,
      now: new Date('2026-07-31T20:00:00Z'),
      scopeEnforcement: false,
    })).resolves.toBe(true);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(clientQuery.mock.calls.some(([sql]) => (
      String(sql).includes('FROM marketing.campaign_scopes')
    ))).toBe(false);
  });

  it('persiste campanha e anúncio por dia, substituindo a recoleta', async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO marketing.campaign_scopes')) {
        return {
          rows: [{
            id: 'scope-1', environment: 'test', ad_account_id: 'act_123',
            campaign_id: 'camp-1', campaign_name: 'WhatsApp', scope: 'pending',
            classification_reason: null, classified_by: null, classified_at: null,
            updated_at: '2026-07-26T18:00:00Z',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO marketing.meta_insights_daily')) {
        return { rows: [{ id: sql.includes("$6,$7") ? 'insight-1' : 'insight-2' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const poolQuery = vi.fn(async (sql: string) => (
      sql.includes('INSERT INTO marketing.meta_sync_runs')
        ? { rows: [{ id: 'run-1' }], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    ));
    const dbPool = { query: poolQuery, connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const level = url.searchParams.get('level');
      return new Response(JSON.stringify({
        data: [{
          campaign_id: 'camp-1',
          campaign_name: 'WhatsApp',
          ...(level === 'ad' ? { ad_id: 'ad-1', ad_name: 'Criativo 1' } : {}),
          date_start: '2026-07-26',
          spend: '10.50',
          impressions: '1000',
          clicks: '30',
          reach: '800',
          actions: [{
            action_type: 'onsite_conversion.messaging_conversation_started_7d',
            value: '4',
          }],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await syncMetaInsights({
      dbPool,
      fetcher: fetcher as typeof fetch,
      now: new Date('2026-07-26T18:00:00Z'),
      lookbackDays: 7,
      config: {
        adAccountId: 'act_123',
        accessToken: 'server-only',
        apiVersion: 'v21.0',
      },
    });

    expect(result).toMatchObject({
      run_id: 'run-1',
      rows_upserted: 2,
      since: '2026-07-20',
      until: '2026-07-26',
      levels: ['campaign', 'ad'],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(clientQuery.mock.calls.filter(([sql]) => (
      String(sql).includes('INSERT INTO marketing.meta_insights_daily')
    ))).toHaveLength(2);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('ON CONFLICT'))).toBe(true);
    expect(clientQuery.mock.calls.at(-2)?.[0]).toContain("status='succeeded'");
  });

  it('atribui last-click em 7 dias uma única vez e é idempotente', async () => {
    let active = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO marketing.ad_referrals')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT a.id,a.order_id')) return { rows: [], rowCount: 0 };
      if (sql.includes('WITH realized AS')) {
        return {
          rows: [{
            id: 'order-1',
            conversation_id: 'conv-1',
            realized_at: '2026-07-26T12:00:00Z',
            total_realized: 1,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT count(*)::int AS total')) {
        return { rows: [{ total: 1 }], rowCount: 1 };
      }
      if (sql.includes('SELECT referral_id,order_id')) {
        return {
          rows: active ? [{ referral_id: 'ref-1', order_id: 'order-1' }] : [],
          rowCount: active ? 1 : 0,
        };
      }
      if (sql.includes('SELECT r.id,r.captured_at')) {
        return {
          rows: [{ id: 'ref-1', captured_at: '2026-07-25T12:00:00Z' }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO marketing.order_attributions')) {
        active = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const dbPool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;

    const first = await reconcileMarketingAttributions({ dbPool, enabled: true });
    const second = await reconcileMarketingAttributions({ dbPool, enabled: true });

    expect(first).toMatchObject({ created: 1, realized_orders: 1, orders_with_conversation: 1 });
    expect(second.created).toBe(0);
    expect(query.mock.calls.some(([sql]) => (
      String(sql).includes("interval '7 days'")
    ))).toBe(true);
    const attributionInsert = query.mock.calls.find(([sql]) => (
      String(sql).includes('INSERT INTO marketing.order_attributions')
      && String(sql).includes("'active'")
    ))?.[0];
    expect(String(attributionInsert)).toContain("'ad_referral_id',$3::uuid");
    expect(String(attributionInsert)).toContain("'order_id',$2::uuid");
    expect(String(attributionInsert)).toContain("'channel',$7::text");
  });
});
