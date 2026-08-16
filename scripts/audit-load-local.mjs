import { createHmac, randomUUID } from 'node:crypto';

const partnerBaseUrl = process.env.AUDIT_PARTNER_URL ?? 'http://127.0.0.1:4100';
const adminBaseUrl = process.env.AUDIT_ADMIN_URL ?? 'http://127.0.0.1:4200';
const fullBaseUrl = process.env.AUDIT_FULL_URL ?? 'http://127.0.0.1:4300';
const hmacSecret = process.env.AUDIT_HMAC_SECRET ?? 'audit-local-hmac-secret';
const soakMs = Number(process.env.AUDIT_SOAK_MS ?? 90_000);

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(name, samples) {
  const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const statuses = {};
  for (const sample of samples) statuses[sample.status] = (statuses[sample.status] ?? 0) + 1;
  return {
    name,
    requests: samples.length,
    ok: samples.filter((sample) => sample.status >= 200 && sample.status < 400).length,
    errors: samples.filter((sample) => sample.status < 200 || sample.status >= 400).length,
    statuses,
    latency_ms: {
      min: Number((latencies[0] ?? 0).toFixed(2)),
      p50: Number(percentile(latencies, 0.50).toFixed(2)),
      p95: Number(percentile(latencies, 0.95).toFixed(2)),
      p99: Number(percentile(latencies, 0.99).toFixed(2)),
      max: Number((latencies.at(-1) ?? 0).toFixed(2)),
    },
  };
}

async function timedFetch(url, options = {}) {
  const started = performance.now();
  try {
    const response = await fetch(url, options);
    await response.arrayBuffer();
    return { status: response.status, ms: performance.now() - started };
  } catch {
    return { status: 0, ms: performance.now() - started };
  }
}

async function runFixed(total, concurrency, requestAt) {
  const samples = new Array(total);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= total) return;
      samples[index] = await requestAt(index);
    }
  }));
  return samples;
}

async function jsonRequest(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${url} respondeu ${response.status}: ${JSON.stringify(json)}`);
  return { response, json };
}

async function partnerLogin() {
  const { json } = await jsonRequest(`${partnerBaseUrl}/api/login`, {
    username: 'audit.parceiro',
    password: 'AuditLocal#2026',
  });
  if (json.mode !== 'direct' || !json.session_token) throw new Error('login parceiro nao retornou sessao direta');
  return json.session_token;
}

async function adminLoginCookie() {
  const { response } = await jsonRequest(`${adminBaseUrl}/admin/api/auth/login`, {
    username: 'audit.matriz',
    password: 'AuditLocal#2026',
  });
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('login admin nao retornou cookie');
  return setCookie.split(';', 1)[0];
}

function webhookRequest(index, deliveryId = `load-${randomUUID()}`) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    event: 'contact_created',
    account: { id: 1 },
    id: 8_000_000 + index,
    account_id: 1,
    name: `Carga Local ${index}`,
    email: `carga-${index}@example.invalid`,
    phone_number: `+552190${String(index).padStart(7, '0')}`,
    identifier: null,
    additional_attributes: {},
    custom_attributes: {},
  });
  const signature = createHmac('sha256', hmacSecret).update(`${timestamp}.${body}`).digest('hex');
  return timedFetch(`${fullBaseUrl}/webhooks/chatwoot`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-chatwoot-timestamp': timestamp,
      'x-chatwoot-signature': `sha256=${signature}`,
      'x-chatwoot-delivery': deliveryId,
    },
    body,
  });
}

async function sseCapacity(partnerToken) {
  const tickets = [];
  for (let index = 0; index < 7; index += 1) {
    const response = await fetch(`${partnerBaseUrl}/parceiro/pf-browser/api/chat/stream-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${partnerToken}` },
    });
    const json = await response.json();
    if (response.status !== 201) throw new Error(`ticket SSE respondeu ${response.status}`);
    tickets.push(json.ticket);
  }

  const controllers = tickets.map(() => new AbortController());
  const responses = await Promise.all(tickets.map((ticket, index) =>
    fetch(`${partnerBaseUrl}/parceiro/pf-browser/api/chat/stream?ticket=${encodeURIComponent(ticket)}`, {
      signal: controllers[index].signal,
    }),
  ));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  controllers.forEach((controller) => controller.abort());
  await Promise.all(responses.map((response) => response.body?.cancel().catch(() => undefined)));
  return {
    attempted: responses.length,
    opened: responses.filter((response) => response.status === 200).length,
    rejected_by_limit: responses.filter((response) => response.status === 429).length,
    statuses: responses.map((response) => response.status),
  };
}

async function runSoak(partnerToken) {
  const endpoints = [
    '/parceiro/pf-browser/api/me',
    '/parceiro/pf-browser/api/resumo',
    '/parceiro/pf-browser/api/estoque',
    '/parceiro/pf-browser/api/vendas',
    '/parceiro/pf-browser/api/fluxo-caixa',
  ];
  const deadline = performance.now() + soakMs;
  const samples = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (performance.now() < deadline) {
      const endpoint = endpoints[cursor++ % endpoints.length];
      samples.push(await timedFetch(`${partnerBaseUrl}${endpoint}`, {
        headers: { authorization: `Bearer ${partnerToken}` },
      }));
    }
  }));
  return summarize(`soak_${Math.round(soakMs / 1000)}s`, samples);
}

const partnerToken = await partnerLogin();
const adminCookie = await adminLoginCookie();
const partnerEndpoints = [
  '/parceiro/pf-browser/api/me',
  '/parceiro/pf-browser/api/resumo',
  '/parceiro/pf-browser/api/estoque',
  '/parceiro/pf-browser/api/vendas',
  '/parceiro/pf-browser/api/fluxo-caixa',
  '/parceiro/pf-browser/api/clientes',
  '/parceiro/pf-browser/api/contas-a-pagar',
];

const staticSamples = await runFixed(500, 50, (index) => {
  const paths = ['/login', '/login.css', '/login.js', '/operacao', '/parceiro/pf-browser/vendor/alpine-3.14.9.min.js'];
  return timedFetch(`${partnerBaseUrl}${paths[index % paths.length]}`);
});
const partnerSamples = await runFixed(700, 35, (index) =>
  timedFetch(`${partnerBaseUrl}${partnerEndpoints[index % partnerEndpoints.length]}`, {
    headers: { authorization: `Bearer ${partnerToken}` },
  }),
);
const adminSamples = await runFixed(400, 25, () =>
  timedFetch(`${adminBaseUrl}/admin/api/auth/me`, { headers: { cookie: adminCookie } }),
);
const webhookSamples = await runFixed(200, 25, (index) => webhookRequest(index));
const duplicateDelivery = `load-duplicate-${randomUUID()}`;
const duplicateSamples = await runFixed(60, 30, (index) => webhookRequest(999_999, duplicateDelivery));
const sse = await sseCapacity(partnerToken);
const soak = await runSoak(partnerToken);

const result = {
  generated_at: new Date().toISOString(),
  phases: [
    summarize('static_burst', staticSamples),
    summarize('partner_authenticated_db', partnerSamples),
    summarize('admin_authenticated', adminSamples),
    summarize('webhook_unique_burst', webhookSamples),
    summarize('webhook_duplicate_race', duplicateSamples),
    soak,
  ],
  sse,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
