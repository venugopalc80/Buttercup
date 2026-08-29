const crypto = require('crypto');

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

    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    };
    const base = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`;

    // Prices are resolved from the database. Never trust a browser-supplied price or total.
    const productsResponse = await fetch(`${base}/products?active=eq.true&select=name,price_pence`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
    });
    const products = await productsResponse.json();
    if (!productsResponse.ok) return res.status(502).json({ error: 'Could not validate the menu.' });
    const productMap = new Map(products.map(p => [p.name.toLowerCase(), p]));

    const safeItems = items.map(item => {
      const productName = clean(item.name, 120);
      const product = productMap.get(productName.toLowerCase());
      const quantity = Number.isInteger(item.qty) ? item.qty : 0;
      if (!product || quantity < 1 || quantity > 20) return null;
      return { product_name: product.name, quantity, unit_price_pence: product.price_pence };
    }).filter(Boolean);

    if (!safeItems.length || safeItems.length !== items.length || safeItems.length > 20) {
      return res.status(400).json({ error: 'One or more basket items are no longer available.' });
    }

    const totalPence = safeItems.reduce((sum, item) => sum + item.quantity * item.unit_price_pence, 0);
    if (totalPence <= 0) return res.status(400).json({ error: 'Your basket is empty.' });

    const orderNumber = `BC-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const orderResponse = await fetch(`${base}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({
        order_number: orderNumber,
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
        collection_date: date,
        collection_slot: slot,
        payment_method: payment,
        payment_status: 'pending',
        order_status: 'pending',
        total_pence: totalPence
      })
    });
    const created = await orderResponse.json();
    if (!orderResponse.ok || !created[0]) return res.status(502).json({ error: 'Could not create the order.' });
    const order = created[0];

    const itemResponse = await fetch(`${base}/order_items`, {
      method: 'POST', headers,
      body: JSON.stringify(safeItems.map(item => ({ ...item, order_id: order.id })))
    });
    if (!itemResponse.ok) {
      await fetch(`${base}/orders?id=eq.${encodeURIComponent(order.id)}`, {
        method: 'DELETE',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
      });
      return res.status(502).json({ error: 'Could not save order items.' });
    }

    return res.status(201).json({
      orderId: order.id,
      orderNumber,
      payment,
      totalPence,
      paymentStatus: 'pending',
      checkoutUrl: null
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unexpected ordering error.' });
  }
};
