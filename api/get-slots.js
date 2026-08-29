module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Ordering service is not configured.' });
  const date = typeof req.query?.date === 'string' ? req.query.date : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid collection date is required.' });
  try {
    const base = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`;
    const response = await fetch(`${base}/collection_slots?collection_date=eq.${encodeURIComponent(date)}&select=id,start_time,end_time,capacity,reserved_count&order=start_time.asc`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    const slots = await response.json();
    if (!response.ok) return res.status(502).json({ error: 'Could not load collection times.' });
    const available = slots.filter(s => Number(s.reserved_count) < Number(s.capacity)).map(s => ({ id: s.id, startTime: s.start_time, endTime: s.end_time, label: `${String(s.start_time).slice(0,5)} - ${String(s.end_time).slice(0,5)}` }));
    return res.status(200).json({ date, slots: available });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unexpected slot lookup error.' });
  }
};
