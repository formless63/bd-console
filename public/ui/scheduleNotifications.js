import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { apiGetRaw } from './api.js';
import { scheduleRevision } from './events.js';
const PREF_KEY = 'bd_schedule_alerts_since';
const SEEN_KEY = 'bd_schedule_alerts_seen';
function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
export const alertsSince = signal(Number(read(PREF_KEY, 0)) || 0);
export const alertError = signal('');
export function notificationsSupported() { return typeof Notification !== 'undefined' && globalThis.isSecureContext; }
export async function toggleScheduleAlerts() {
  alertError.value = '';
  if (alertsSince.value) {
    alertsSince.value = 0;
    try { localStorage.removeItem(PREF_KEY); } catch {}
    return;
  }
  if (!notificationsSupported()) { alertError.value = 'Browser notifications require HTTPS or localhost and a supported browser.'; return; }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { alertError.value = 'Notifications are blocked. Allow them in your browser site settings to enable alerts.'; return; }
  const since = Date.now();
  try { localStorage.setItem(PREF_KEY, JSON.stringify(since)); alertsSince.value = since; }
  catch { alertError.value = 'This browser cannot save the notification preference.'; }
}
// App-lifetime and opt-in. Hidden tabs can receive alerts; a closed/suspended
// browser cannot. No prompts or terminal errors are copied to OS notifications.
export function useScheduleNotifications() {
  const since = alertsSince.value;
  const revision = scheduleRevision.value;
  const pollRef = useRef(null);
  useEffect(() => {
    if (!since || !notificationsSupported() || Notification.permission !== 'granted') return;
    let live = true, busy = false;
    const stored = read(SEEN_KEY, []);
    const seen = new Set(Array.isArray(stored) ? stored : []);
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const { jobs } = await apiGetRaw('/api/schedule', { signal: AbortSignal.timeout(20000) });
        if (!live) return;
        for (const job of jobs || []) {
          const key = `${job.id}:${job.retry_count || 0}:${job.fired_at}`;
          if (job.status !== 'failed' || !(job.fired_at >= since) || seen.has(key)) continue;
          const notification = new Notification('Scheduled prompt failed', { body: `Prompt #${job.id} could not be delivered. Open Schedule for details.`, tag: `bd-schedule-${key}` });
          notification.onclick = () => { window.focus(); location.hash = '#/schedule'; notification.close(); };
          seen.add(key);
        }
        try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-1000))); } catch {}
        alertError.value = '';
      } catch { if (live) alertError.value = 'Failure alerts could not refresh. Check the server connection and access token.'; }
      finally { busy = false; }
    };
    pollRef.current = poll;
    poll();
    const timer = setInterval(poll, 15000);
    const wake = () => { if (!document.hidden) poll(); };
    document.addEventListener('visibilitychange', wake);
    return () => { live = false; clearInterval(timer); pollRef.current = null; document.removeEventListener('visibilitychange', wake); };
  }, [since]);
  useEffect(() => { if (revision) pollRef.current?.(); }, [revision]);
}
