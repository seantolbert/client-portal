// Contract smoke test against a running portal (vercel dev or a deployment).
//   HANDOFF_SECRET=... PORTAL_URL=http://localhost:3000 node scripts/handoff-smoke.mjs [fixture.json]
// Uses a unique prospect_id per run so it creates a fresh client each time.
import { readFileSync } from 'node:fs';
import { sign } from '../lib/handoff.js';

const secret = process.env.HANDOFF_SECRET;
const base = process.env.PORTAL_URL ?? 'http://localhost:3000';
if (!secret) throw new Error('HANDOFF_SECRET is required');

const fixture = JSON.parse(readFileSync(process.argv[2] ?? new URL('../test/fixtures/handoff-payload.json', import.meta.url), 'utf8'));
fixture.prospect_id = `smoke_${Date.now()}`;
if (process.env.SMOKE_EMAIL) fixture.email = process.env.SMOKE_EMAIL;
const body = JSON.stringify(fixture);

async function post({ timestamp = String(Math.floor(Date.now() / 1000)), signature } = {}) {
  const res = await fetch(`${base}/api/clients`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-handoff-timestamp': timestamp,
      'x-handoff-signature': signature ?? sign(secret, timestamp, body),
    },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let failed = false;
function expect(name, got, status, check = () => true) {
  const ok = got.status === status && check(got.body);
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got.status} ${JSON.stringify(got.body)}`);
}

const created = await post();
expect('new prospect -> 201', created, 201, (b) => b?.created === true);
const replay = await post();
expect('replay -> 200 same client_id', replay, 200, (b) => b?.created === false && b.client_id === created.body?.client_id);
expect('stale timestamp -> 401', await post({ timestamp: String(Math.floor(Date.now() / 1000) - 301) }), 401);
expect('bad signature -> 401', await post({ signature: 'f'.repeat(64) }), 401);
process.exit(failed ? 1 : 0);
