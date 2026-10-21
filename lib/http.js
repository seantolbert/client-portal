export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

// Exact request bytes. Signature checks must run on these, never on re-serialized JSON.
export async function readRawBody(request) {
  return Buffer.from(await request.arrayBuffer());
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing env var ${name}`);
  return value;
}

export function log(fields) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}
