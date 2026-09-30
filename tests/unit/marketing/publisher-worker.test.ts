import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {} }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/marketing/publisher/queue.js', () => ({ claimDelivery: vi.fn(), setDelivery: vi.fn() }));
import { claimDelivery, setDelivery, type Task } from '../../../src/marketing/publisher/queue.js';
import { publishTick } from '../../../src/marketing/publisher/worker.js';
import { MetaCommentError } from '../../../src/social-comments/graph.js';
import { PublisherError } from '../../../src/marketing/publisher/model.js';
import type { PublisherStorage } from '../../../src/marketing/publisher/storage.js';

const pool = {} as Pool;
const graph = { prepare: vi.fn(), ready: vi.fn(), publish: vi.fn(), verify: vi.fn(),
  assertPermissions: vi.fn(), reconcile: vi.fn() };
const storage = { signedUrl: vi.fn(), assertPrivateBucket: vi.fn() };
const task = (extra: Partial<Task> = {}): Task => ({
  post_id: 'post', platform: 'instagram', account_id: 'account', format: 'reel', media_kind: 'video',
  status: 'preparing', lease_id: 'lease', container_id: '301', provider_id: '302',
  publish_path: 'test/media/original.mp4', original_path: 'test/media/original.mp4',
  started_at: new Date(), public_started_at: null, retry_attempts: 0,
  kind: 'video', width: 1080, height: 1920, duration: 50,
  inspection: { verified: true, video_codec: 'h264', fps: 30, bit_rate: 1_000_000 }, ...extra,
});
async function tick(data = task()) {
  vi.mocked(claimDelivery).mockResolvedValueOnce(data);
  return publishTick(pool, 'test', graph, storage as unknown as PublisherStorage);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(setDelivery).mockResolvedValue(true);
  storage.signedUrl.mockResolvedValue('https://storage.test/signed');
  storage.assertPrivateBucket.mockResolvedValue(undefined);
  graph.assertPermissions.mockResolvedValue(undefined);
  graph.prepare.mockResolvedValue('301');
  graph.ready.mockResolvedValue(true);
  graph.publish.mockResolvedValue('302');
  graph.verify.mockResolvedValue({ confirmed: true, url: null });
});

describe('Repetições seguras na fila', () => {
  it('confere privacidade antes de fornecer a URL ao provedor', async () => {
    await tick();
    expect(storage.assertPrivateBucket.mock.invocationCallOrder[0])
      .toBeLessThan(storage.signedUrl.mock.invocationCallOrder[0]!);
    expect(storage.signedUrl.mock.invocationCallOrder[0]).toBeLessThan(graph.prepare.mock.invocationCallOrder[0]!);
    expect(setDelivery).toHaveBeenCalledWith(pool, 'test', expect.anything(), 'processing', { container: '301' });
  });
  it('reagenda falha transitória antes da publicação com limite e backoff', async () => {
    graph.prepare.mockRejectedValue(new MetaCommentError('meta_connection_unknown', true));
    await tick(task({ retry_attempts: 2 }));
    expect(setDelivery).toHaveBeenCalledWith(pool, 'test', expect.anything(), 'preparing', {
      error: 'meta_connection_unknown', retryAttempts: 3, delaySeconds: 60,
    });
    await tick(task({ retry_attempts: 5 }));
    expect(vi.mocked(setDelivery).mock.calls.at(-1)?.[3]).toBe('failed');
    expect(graph.publish).not.toHaveBeenCalled();
  });
  it('consulta temporariamente indisponível do processamento é repetida sem envio público', async () => {
    graph.ready.mockRejectedValue(new MetaCommentError('meta_http_503_code_2'));
    await tick(task({ status: 'processing' }));
    expect(setDelivery).toHaveBeenCalledWith(pool, 'test', expect.anything(), 'processing', {
      error: 'meta_http_503_code_2', retryAttempts: 1, delaySeconds: 15,
    });
    expect(graph.publish).not.toHaveBeenCalled();
  });
  it('permissão negada é definitiva e bucket público nunca chega à publicação', async () => {
    graph.assertPermissions.mockRejectedValueOnce(new MetaCommentError('publisher_permissions_missing'));
    await tick(task({ status: 'processing' }));
    expect(vi.mocked(setDelivery).mock.calls.at(-1)?.[3]).toBe('failed');
    storage.assertPrivateBucket.mockRejectedValueOnce(new PublisherError('publisher_private_bucket_required', 400));
    await tick(task({ status: 'processing' }));
    expect(graph.publish).not.toHaveBeenCalled();
    expect(vi.mocked(setDelivery).mock.calls.at(-1)?.[4]?.error).toBe('publisher_private_bucket_required');
  });
  it('agendamento legado com vídeo não inspecionado não contorna a validação nova', async () => {
    await tick(task({ inspection: { verified: false } }));
    expect(graph.prepare).not.toHaveBeenCalled();
    expect(vi.mocked(setDelivery).mock.calls.at(-1)?.[3]).toBe('failed');
    expect(vi.mocked(setDelivery).mock.calls.at(-1)?.[4]?.error).toBe('publisher_media_inspection_required');
  });
  it('persiste a fronteira pública depois das verificações e impede envio com lease perdido', async () => {
    await tick(task({ status: 'processing' }));
    expect(graph.assertPermissions.mock.invocationCallOrder[0]).toBeLessThan(graph.publish.mock.invocationCallOrder[0]!);
    const publishing = vi.mocked(setDelivery).mock.calls.findIndex(call => call[3] === 'publishing');
    expect(publishing).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(setDelivery).mock.invocationCallOrder[publishing]).toBeLessThan(graph.publish.mock.invocationCallOrder[0]!);
    vi.mocked(setDelivery).mockResolvedValueOnce(false);
    await tick(task({ status: 'processing' }));
    expect(graph.publish).toHaveBeenCalledTimes(1);
  });
  it('timeout na escrita pública fica incerto e não entra em repetição automática', async () => {
    graph.publish.mockRejectedValueOnce(new MetaCommentError('meta_connection_unknown', true));
    await tick(task({ status: 'processing' }));
    expect(vi.mocked(setDelivery).mock.calls.at(-1)?.[3]).toBe('uncertain');
    await tick(task({ status: 'publishing' }));
    expect(graph.publish).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setDelivery).mock.calls.at(-1)?.[3]).toBe('uncertain');
  });
  it('verificação usa o horário do envio público e não o início da preparação', async () => {
    graph.verify.mockResolvedValue({ confirmed: false, url: null });
    const old = new Date(Date.now() - 3 * 3_600_000);
    await tick(task({ status: 'verifying', started_at: old, public_started_at: new Date() }));
    expect(vi.mocked(setDelivery).mock.calls.at(-1)?.[3]).toBe('verifying');
    await tick(task({ status: 'verifying', started_at: old, public_started_at: old }));
    expect(vi.mocked(setDelivery).mock.calls.at(-1)?.[3]).toBe('uncertain');
  });
});
