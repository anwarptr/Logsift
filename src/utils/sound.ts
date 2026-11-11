/**
 * Synthesizes a gentle two-tone alert chime using the browser's Web Audio API
 * (no external audio assets or network requests required).
 */
let audioCtx: AudioContext | null = null;
let lastAlertAt = 0;
const ALERT_THROTTLE_MS = 2500;

export function playAlertChime(): void {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_THROTTLE_MS) return;
  lastAlertAt = now;

  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioCtx) audioCtx = new AudioCtx();
    if (audioCtx.state === 'suspended') void audioCtx.resume();

    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    // Pleasant two-tone chime: D5 (587.33 Hz) jumping to A5 (880 Hz)
    osc.frequency.setValueAtTime(587.33, t);
    osc.frequency.setValueAtTime(880, t + 0.08);

    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(t);
    osc.stop(t + 0.35);
  } catch {
    // AudioContext blocked by browser autoplay policy or unsupported
  }
}

/** Display a desktop notification if permitted. */
export function notifyDesktop(title: string, body: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: '/favicon.ico' });
  } catch {
    // Notifications unavailable or blocked
  }
}

/** Ask the user for desktop notification permission if not yet decided. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission !== 'denied') {
    const p = await Notification.requestPermission();
    return p === 'granted';
  }
  return false;
}
