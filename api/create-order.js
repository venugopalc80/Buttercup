const crypto = require('crypto');
function clean(value, max = 200) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

async function stripeCheckout({ secret, origin, order, items }) {
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', `${origin}/confirmation.html?payment=success`);
  form.set('cancel_url', `${origin}/order.html?payment=cancelled`);
  form.set('customer_email', order.customer_email);
  form.set('metadata[order_id]', order.id);
  form.set('metadata[order_number]', order.order_number);
  items.forEach((item, index) => {
    form.set(`line_items[${index}][price_data][currency]`, 'gbp');
    form.set(`line_items[${index}][price_data][product_data][name]`, item.product_name);
    form.set(`line_items[${index}][price_data][unit_amount]`, String(item.unit_price_pence));
    form.set(`line_items[${index}][quantity]`, String(item.quantity));
  });
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const data = await response.json();
  if (!response.ok || !data.id || !data.url) throw new Error(data.error?.message || 'Could not start online payment.');
  return data;
}

async function releaseSlot(base, key, slotId) {
  await fetch(`${base}/rpc/release_collection_slot`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_slot_id: slotId }) });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Ordering service is not configured.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const name = clean(body.name, 120), email = clean(body.email, 160).toLowerCase(), phone = clean(body.phone, 40);
    const date = clean(body.date, 30), slot = clean(body.slot, 40);
    const payment = body.payment === 'online' ? 'online' : body.payment === 'cafe' ? 'cafe' : '';
    const items = Array.isArray(body.items) ? body.items : [];
    if (!name || !phone || !validEmail(email) || !date || !slot || !payment || !items.length) return res.status(400).json({ error: 'Please complete all required order details.' });
    if (payment === 'online' && !process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Online payment is not configured yet. Please choose Pay at café.' });

    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
    const base = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`;

    const productsResponse = await fetch(`${base}/products?active=eq.true&select=name,price_pence`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    const products = await productsResponse.json();
    if (!productsResponse.ok) return res.status(502).json({ error: 'Could not validate the menu.' });
    const productMap = new Map(products.map(p => [p.name.toLowerCase(), p]));
    const safeItems = items.map(item => { const productName = clean(item.name, 120); const product = productMap.get(productName.toLowerCase()); const quantity = Number.isInteger(item.qty) ? item.qty : 0; if (!product || quantity < 1 || quantity > 20) return null; return { product_name: product.name, quantity, unit_price_pence: product.price_pence }; }).filter(Boolean);
    if (!safeItems.length || safeItems.length !== items.length || safeItems.length > 20) return res.status(400).json({ error: 'One or more basket items are no longer available.' });
    const totalPence = safeItems.reduce((sum, item) => sum + item.quantity * item.unit_price_pence, 0);
    if (totalPence <= 0) return res.status(400).json({ error: 'Your basket is empty.' });

    // Reserve the requested slot atomically before creating the order.
    const startTime = slot.split(' - ')[0];
    const slotResponse = await fetch(`${base}/rpc/reserve_collection_slot`, { method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_date: date, p_start_time: startTime }) });
    const slotId = await slotResponse.json();
    if (!slotResponse.ok || !slotId) return res.status(409).json({ error: 'That collection slot is no longer available. Please choose another time.' });

    const orderNumber = `BC-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const orderResponse = await fetch(`${base}/orders`, { method: 'POST', headers, body: JSON.stringify({ order_number: orderNumber, customer_name: name, customer_email: email, customer_phone: phone, collection_slot_id: slotId, collection_date: date, collection_slot: slot, payment_method: payment, payment_status: 'pending', order_status: 'pending', total_pence: totalPence }) });
    const created = await orderResponse.json();
    if (!orderResponse.ok || !created[0]) { await releaseSlot(base, serviceKey, slotId); return res.status(502).json({ error: 'Could not create the order.' }); }
    const order = created[0];

    const itemResponse = await fetch(`${base}/order_items`, { method: 'POST', headers, body: JSON.stringify(safeItems.map(item => ({ ...item, order_id: order.id }))) });
    if (!itemResponse.ok) {
      await fetch(`${base}/orders?id=eq.${encodeURIComponent(order.id)}`, { method: 'DELETE', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      await releaseSlot(base, serviceKey, slotId);
      return res.status(502).json({ error: 'Could not save order items.' });
    }

    let checkoutUrl = null;
    if (payment === 'online') {
      try {
        const origin = req.headers.origin || `https://${req.headers.host}`;
        const session = await stripeCheckout({ secret: process.env.STRIPE_SECRET_KEY, origin, order, items: safeItems });
        checkoutUrl = session.url;
        await fetch(`${base}/orders?id=eq.${encodeURIComponent(order.id)}`, { method: 'PATCH', headers, body: JSON.stringify({ stripe_checkout_session_id: session.id }) });
      } catch (stripeError) {
        await fetch(`${base}/order_items?order_id=eq.${encodeURIComponent(order.id)}`, { method: 'DELETE', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
        await fetch(`${base}/orders?id=eq.${encodeURIComponent(order.id)}`, { method: 'DELETE', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
        await releaseSlot(base, serviceKey, slotId);
        return res.status(502).json({ error: stripeError.message || 'Could not start online payment.' });
      }
    }

    return res.status(201).json({ orderId: order.id, orderNumber, payment, totalPence, paymentStatus: 'pending', checkoutUrl });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unexpected ordering error.' });
  }
};
