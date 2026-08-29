module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const sessionId = typeof req.query?.session_id === 'string' ? req.query.session_id : '';
  if (!sessionId || !sessionId.startsWith('cs_')) return res.status(400).json({ error: 'Missing payment session.' });
  const secret = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !supabaseUrl || !serviceKey) return res.status(503).json({ error: 'Order service is not configured.' });
  try {
    const stripeResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { headers: { Authorization: `Bearer ${secret}` } });
    const session = await stripeResponse.json();
    if (!stripeResponse.ok || !session.id) return res.status(404).json({ error: 'Payment session not found.' });
    const orderId = session.metadata?.order_id;
    if (!orderId) return res.status(404).json({ error: 'Order not found.' });
    const base = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`;
    const orderResponse = await fetch(`${base}/orders?id=eq.${encodeURIComponent(orderId)}&select=order_number,payment_status,order_status,total_pence`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    const orders = await orderResponse.json();
    if (!orderResponse.ok || !orders[0]) return res.status(404).json({ error: 'Order not found.' });
    return res.status(200).json({ orderNumber: orders[0].order_number, paymentStatus: orders[0].payment_status, orderStatus: orders[0].order_status, totalPence: orders[0].total_pence, checkoutPaymentStatus: session.payment_status });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not verify payment status.' });
  }
};
