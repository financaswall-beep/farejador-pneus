import { describe, expect, it, vi } from 'vitest';
import { isAllowedPushEndpoint, isPublicNetworkAddress } from '../../../src/parceiro/push-endpoint.js';

describe('push endpoint security', () => {
  it('accepts HTTPS endpoints that resolve only to public addresses', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '142.250.79.78', family: 4 }]);

    await expect(isAllowedPushEndpoint('https://push.example.com/send/abc', lookup)).resolves.toBe(true);
  });

  it.each([
    'http://push.example.com/send',
    'https://user:password@push.example.com/send',
    'https://push.example.com:8443/send',
    'https://localhost/send',
    'https://127.0.0.1/send',
    'https://10.0.0.8/send',
    'https://[::1]/send',
  ])('rejects unsafe URL %s', async (endpoint) => {
    await expect(isAllowedPushEndpoint(endpoint)).resolves.toBe(false);
  });

  it('rejects DNS rebinding candidates when any resolved address is private', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '142.250.79.78', family: 4 },
      { address: '192.168.1.20', family: 4 },
    ]);

    await expect(isAllowedPushEndpoint('https://push.example.com/send', lookup)).resolves.toBe(false);
  });

  it('classifies private, reserved and public network addresses', () => {
    expect(isPublicNetworkAddress('169.254.169.254')).toBe(false);
    expect(isPublicNetworkAddress('100.64.0.1')).toBe(false);
    expect(isPublicNetworkAddress('2001:db8::1')).toBe(false);
    expect(isPublicNetworkAddress('8.8.8.8')).toBe(true);
    expect(isPublicNetworkAddress('2607:f8b0:4004:810::200e')).toBe(true);
  });
});
