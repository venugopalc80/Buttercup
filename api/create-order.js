const crypto = require('crypto');

function json(status, body) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function clean(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Ordering service is not configured.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const name = clean(body.name, 120);
    const email = clean(body.email, 160).toLowerCase();
    const phone = clean(body.phone, 40);
    const date = clean(body.date, 30);
    const slot = clean(body.slot, 40);
    const payment = body.payment === 'online' ? 'online' : body.payment === 'cafe' ? 'cafe' : '';
    const items = Array.isArray(body.items) ? body.items : [];

    if (!name || !phone || !validEmail(email) || !date || !slot || !payment || !items.length) {
      return res.status(400).json({ error: 'Please complete all required order details.' });
    }

    const safeItems = items.map((item) => ({
      product_name: clean(item.name, 120),
      quantity: Number.isInteger(item.qty) ? item.qty : 0,
      unit_price_pence: Math.round(Number(item.price) * 100)
    })).filter(item => item.product_name && item.quantity > 0 && item.quantity <= 20 && item.unit_price_pence >= 0 && item.unit_price_pence <= 100000);

    if (!safeItems.length || safeItems.length > 20) return res.status(400).json({ error: 'Invalid basket.' });

    const totalPence = safeItems.reduce((sum, item) => sum + item.quantity * item.unit_price_pence, 0);
    if (totalPence <= 0) return res.status(400).json({ error: 'Your basket is empty.' });

    const orderNumber = `BC-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
    const base = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`;

    // Create the order server-side. Never trust a browser-supplied total for payment.
    const orderResponse = await fetch(`${base}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ order_number: orderNumber, customer_name: name, customer_email: email, customer_phone: phone, collection_date: date, collection_slot: slot, payment_method: payment, payment_status: 'pending', order_status: 'pending', total_pence: totalPence })
    });
    const created = await orderResponse.json();
    if (!orderResponse.ok || !created[0]) return res.status(502).json({ error: 'Could not create the order.' });
    const order = created[0];

    const itemResponse = await fetch(`${base}/order_items`, {
      method: 'POST', headers,
      body: JSON.stringify(safeItems.map(item => ({ ...item, order_id: order.id })))
    });
    if (!itemResponse.ok) {
      await fetch(`${base}/orders?id=eq.${encodeURIComponent(order.id)}`, { method: 'DELETE', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      return res.status(502).json({ error: 'Could not save order items.' });
    }

    // Online payment is intentionally not charged here until Stripe is configured.
    // The next production step is creating a Stripe Checkout Session server-side and
    // storing its session ID against this order before returning the checkout URL.
    return res.status(201).json({ orderId: order.id, orderNumber, payment, totalPence, paymentStatus: 'pending', checkoutUrl: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unexpected ordering error.' });
  }
};
