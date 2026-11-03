// FlowTower 資料存取層：Supabase REST（PostgREST），不依賴外部套件
const C = window.FT_CONFIG;
const H = { apikey: C.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + C.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
const base = C.SUPABASE_URL + '/rest/v1/';

async function req(method, path, body, extra = {}) {
  const r = await fetch(base + path, { method, headers: { ...H, ...extra }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const t = await r.text(); throw new Error(`${r.status} ${t}`); }
  if (r.status === 204) return null;
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

export const api = {
  get: (table, q = 'select=*') => req('GET', `${table}?${q}`),
  insert: (table, rows) => req('POST', table, rows, { Prefer: 'return=representation' }),
  update: (table, filter, patch) => req('PATCH', `${table}?${filter}`, patch, { Prefer: 'return=representation' }),
  del: (table, filter) => req('DELETE', `${table}?${filter}`),
  rpc: (fn, args = {}) => req('POST', `rpc/${fn}`, args),
};

// ---- 共用：主檔快取 ----
let cache = null;
export async function master(force) {
  if (cache && !force) return cache;
  const [sites, customers, locations, products, vtypes] = await Promise.all([
    api.get('sites', 'select=*&order=id'),
    api.get('customers', 'select=*&order=code'),
    api.get('locations', 'select=*&order=name'),
    api.get('products', 'select=*&order=sku'),
    api.get('vehicle_types', 'select=*&order=rank'),
  ]);
  cache = { sites, customers, locations, products, vtypes,
    site: Object.fromEntries(sites.map(s => [s.id, s])),
    cust: Object.fromEntries(customers.map(c => [c.id, c])),
    loc: Object.fromEntries(locations.map(l => [l.id, l])) };
  return cache;
}

// ---- 檢查點燈號（與資料庫 v_order_checkpoints 同規則） ----
export function flagOf(o, now = Date.now()) {
  const dep = new Date(o.req_depart_at).getTime(), eta = new Date(o.req_arrive_at).getTime(), m = 60000;
  const s = o.status;
  if (s === 'delivered' || s === 'cancelled') return ['g', '完成'];
  if (s === 'exception') return ['r', '異常'];
  if (['created', 'released', 'picking'].includes(s)) {
    if (now > dep - 5 * m) return ['r', 'T−5 未備妥'];
    if (now > dep - 15 * m) return ['y', 'T−15 未備妥'];
  }
  if (['picked', 'loaded'].includes(s) && now > dep) return ['r', 'T0 未出車'];
  if (s === 'in_transit') {
    if (now > eta + 30 * m) return ['r', 'ETA+30 未送達'];
    if (now > eta) return ['y', '超過 ETA'];
  }
  return ['g', '正常'];
}

export const STATUS = {
  created: '已建單', released: '已釋出', picking: '撿貨中', picked: '已撿貨', loaded: '已交車',
  in_transit: '配送中', delivered: '已送達', exception: '異常', cancelled: '已取消'
};
export const fmtT = d => d ? new Date(d).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
export const fmtHM = d => d ? new Date(d).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const inList = ids => `(${ids.map(i => `"${i}"`).join(',')})`;
