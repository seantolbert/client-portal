import { log } from './http.js';

const DEFAULT_FROM = 'Berner Systems Billing <billing@mail.bernersystems.com>';

// Transactional email via Resend. Best-effort: failures are logged, never thrown,
// so email trouble cannot fail a handoff or a webhook.
export async function sendEmail({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log({ msg: 'email_skipped', reason: 'no_api_key', subject });
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || DEFAULT_FROM, to: [to], subject, text }),
    });
    if (!res.ok) log({ msg: 'email_failed', status: res.status, subject });
  } catch (err) {
    log({ msg: 'email_failed', reason: err.message, subject });
  }
}
