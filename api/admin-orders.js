const crypto = require('crypto');

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}
function sign(value, secret) { return crypto.createHmac('sha256', secret).update(value).digest('hex'); }
function authenticated(req) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) return false;
  const token = cookieValue(req, 'buttercup_admin');
  const [value, signature] = token.split('.');
  if (!value || !signature) return false;
  const expected = sign(value, secret);
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function supabase(path, options = {}) {
  const base = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(`${base}/${path}`, { ...options, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
}

module.exports = async function handler(req, res) {
  if (!authenticated(req)) return res.status(401).json({ error: 'Unauthorised.' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Database is not configured.' });

  try {
    if (req.method === 'GET') {
      const status = typeof req.query?.status === 'string' && req.query.status !== 'all' ? `&order_status=eq.${encodeURIComponent(req.query.status)}` : '';
      const response = await supabase(`orders?select=id,order_number,customer_name,customer_email,customer_phone,collection_date,collection_slot,payment_method,payment_status,order_status,total_pence,created_at,order_items(product_name,quantity,unit_price_pence)&order=created_at.desc${status}`);
      const data = await response.json();
      if (!response.ok) return res.status(502).json({ error: 'Could not load orders.' });
      return res.status(200).json({ orders: data });
    }

    if (req.method === 'PATCH') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const allowed = ['pending', 'confirmed', 'ready', 'collected', 'cancelled'];
      if (!allowed.includes(body.status) || typeof body.id !== 'string') return res.status(400).json({ error: 'Invalid order update.' });
      const response = await supabase(`orders?id=eq.${encodeURIComponent(body.id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ order_status: body.status }) });
      const data = await response.json();
      if (!response.ok || !data[0]) return res.status(404).json({ error: 'Order not found.' });
      return res.status(200).json({ order: data[0] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Admin request failed.' });
  }
};
