import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
};

const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const queryMock = vi.fn();

describe('cli parseArgs', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, baseEnv);
  });

  afterEach(() => {
    vi.doUnmock('../../../src/shared/config/env.js');
    vi.resetModules();
  });

  async function loadParseArgs() {
    const mod = await import('../../../src/enrichment/cli.js');
    return mod.parseArgs;
  }

  it('parses --conversation-id', async () => {
    const parseArgs = await loadParseArgs();
    const options = parseArgs(['node', 'cli.js', '--conversation-id=uuid-123']);
    expect(options.conversationId).toBe('uuid-123');
  });

  it('parses --segment', async () => {
    const parseArgs = await loadParseArgs();
    const options = parseArgs(['node', 'cli.js', '--conversation-id=uuid-123', '--segment=generic']);
    expect(options.conversationId).toBe('uuid-123');
    expect(options.segment).toBe('generic');
  });

  it('throws when --conversation-id is missing', async () => {
    const parseArgs = await loadParseArgs();
    expect(() => parseArgs(['node', 'cli.js'])).toThrow('Missing required argument: --conversation-id=<uuid>');
  });
});

describe('cli runCli', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, baseEnv);
  });

  afterEach(() => {
    vi.doUnmock('pg');
    vi.doUnmock('pino');
    vi.doUnmock('../../../src/shared/config/env.js');
    vi.resetModules();
  });

  async function loadCli() {
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rowCount: 1, rows: [{ conversation_id: 'conv-uuid' }] });

    vi.doMock('pino', () => ({
      default: vi.fn(() => loggerMock),
    }));

    vi.doMock('pg', () => ({
      Pool: vi.fn(function Pool() {
        return {
          connect: vi.fn().mockResolvedValue({ query: queryMock, release: vi.fn() }),
          on: vi.fn(),
          end: vi.fn(),
        };
      }),
    }));

    vi.doMock('../../../src/shared/config/env.js', () => ({
      env: {
        NODE_ENV: 'test',
        FAREJADOR_ENV: 'test',
        DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
        DATABASE_POOL_MAX: 10,
        DATABASE_SSL: false,
        CHATWOOT_HMAC_SECRET: 'test-secret',
        CHATWOOT_WEBHOOK_MAX_AGE_SECONDS: 300,
        ADMIN_AUTH_TOKEN: 'test-admin-token',
        LOG_LEVEL: 'info',
        SKIP_EVENT_TYPES: [],
        SIGNAL_TIMEZONE: 'America/Sao_Paulo',
      },
    }));

    const mod = await import('../../../src/enrichment/cli.js');
    return mod;
  }

  it('accepts --conversation-id and calls enrichment', async () => {
    const cli = await loadCli();
    await expect(cli.runCli(['node', 'cli.js', '--conversation-id=conv-uuid'])).resolves.not.toThrow();
    expect(queryMock).toHaveBeenCalledWith(expect.any(String), ['conv-uuid', 'test', 'America/Sao_Paulo']);
  });

  it('throws when conversation does not exist in the selected environment', async () => {
    const cli = await loadCli();
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(cli.runCli(['node', 'cli.js', '--conversation-id=missing-conv'])).rejects.toThrow(
      'Conversation not found in environment test: missing-conv',
    );
  });

  it('uses --segment for rules engine and classification', async () => {
    const cli = await loadCli();
    await expect(cli.runCli(['node', 'cli.js', '--conversation-id=conv-uuid', '--segment=generic'])).resolves.not.toThrow();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ segment: 'generic', conversation_id: 'conv-uuid' }),
      'starting enrichment',
    );
  });
});
