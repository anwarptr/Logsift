import { describe, expect, it } from 'vitest';
import { notifyDesktop, playAlertChime, requestNotificationPermission } from '../../src/utils/sound';

describe('sound and notifications', () => {
  it('safely handles playAlertChime when Web Audio is missing or throws', () => {
    expect(() => playAlertChime()).not.toThrow();
  });

  it('safely handles notifyDesktop when Notification is missing', () => {
    expect(() => notifyDesktop('test', 'body')).not.toThrow();
  });

  it('requests permission or returns false if unsupported', async () => {
    const res = await requestNotificationPermission();
    expect(typeof res).toBe('boolean');
  });
});
