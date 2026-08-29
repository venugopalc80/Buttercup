const crypto = require('crypto');

module.exports.config = { api: { bodyParser: false } };

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function verifyStripeSignature(payload, signature, secret) {
  const parts = String(signature || '').split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return signatures.some(value => {
    try { return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(value, 'utf8')); }
    catch { return false; }
  });
}

async function updateOrder(orderId, values) {
  const base = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(`${base}/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(values)
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.STRIPE_WEBHOOK_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Webhook is not configured.' });

  try {
    const payload = await rawBody(req);
    if (!verifyStripeSignature(payload, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) return res.status(400).json({ error: 'Invalid signature' });
    const event = JSON.parse(payload);
    const session = event.data?.object;
    const orderId = session?.metadata?.order_id;
    if (!orderId) return res.status(200).json({ received: true });

    if (event.type === 'checkout.session.completed' && session.payment_status === 'paid') {
      await updateOrder(orderId, { payment_status: 'paid', order_status: 'confirmed', stripe_payment_intent_id: session.payment_intent || null });
    } else if (event.type === 'checkout.session.async_payment_succeeded') {
      await updateOrder(orderId, { payment_status: 'paid', order_status: 'confirmed', stripe_payment_intent_id: session.payment_intent || null });
    } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
      await updateOrder(orderId, { payment_status: 'failed', order_status: 'cancelled' });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }
};
