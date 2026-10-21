// Shared browser helpers. The Supabase client uses the anon key; every read
// goes through RLS as the signed-in user.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

let supabase;

export async function getSupabase() {
  if (supabase) return supabase;
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('Portal is not configured.');
  const { supabaseUrl, supabaseAnonKey } = await res.json();
  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true },
  });
  return supabase;
}

export async function requireSession() {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    location.replace('/');
    return null;
  }
  return data.session;
}

export async function api(path, body) {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
}

export const money = (cents, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);

export const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '—');

// Build DOM without innerHTML so database text is never parsed as markup.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

export async function signOut() {
  const sb = await getSupabase();
  await sb.auth.signOut();
  location.replace('/');
}
