const crypto = require('crypto');

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

module.exports = async function handler(req, res) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  const password = process.env.ADMIN_DASHBOARD_PASSWORD;
  if (!secret || !password) return res.status(500).json({ error: 'Admin authentication is not configured.' });

  if (req.method === 'GET') {
    const token = cookieValue(req, 'buttercup_admin');
    if (!token) return res.status(401).json({ authenticated: false });
    const [value, signature] = token.split('.');
    const valid = value && signature && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(sign(value, secret)));
    return res.status(valid ? 200 : 401).json({ authenticated: valid });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  if (typeof body.password !== 'string' || !crypto.timingSafeEqual(Buffer.from(body.password), Buffer.from(password))) return res.status(401).json({ error: 'Incorrect password.' });

  const value = `${Date.now()}.${crypto.randomBytes(16).toString('hex')}`;
  const token = `${value}.${sign(value, secret)}`;
  res.setHeader('Set-Cookie', `buttercup_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);
  return res.status(200).json({ authenticated: true });
};
