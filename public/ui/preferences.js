import { signal } from '@preact/signals';
function read() { try { return localStorage.getItem('bd_show_cli_receipts') === 'true'; } catch { return false; } }
export const showCliReceipts = signal(read());
export function setCliReceipts(value) {
  showCliReceipts.value = !!value;
  try { localStorage.setItem('bd_show_cli_receipts', String(!!value)); } catch {}
}
