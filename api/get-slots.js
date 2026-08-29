module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) return res.status(500).json({ error: 'Ordering service is not configured.', missing });

  const date = typeof req.query?.date === 'string' ? req.query.date : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid collection date is required.' });

  try {
    const base = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`;
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const response = await fetch(`${base}/collection_slots?collection_date=eq.${encodeURIComponent(date)}&select=id,start_time,end_time,capacity,reserved&order=start_time.asc`, { headers });
    const raw = await response.text();
    let slots;
    try { slots = JSON.parse(raw); } catch { slots = null; }

    if (!response.ok) {
      console.error('Supabase collection_slots error:', response.status, raw.slice(0, 500));
      return res.status(502).json({ error: 'Could not load collection times from Supabase.' });
    }
    if (!Array.isArray(slots)) return res.status(502).json({ error: 'Invalid availability response.' });

    const available = slots
      .filter(s => Number(s.reserved ?? 0) < Number(s.capacity ?? 0))
      .map(s => ({
        id: s.id,
        startTime: s.start_time,
        endTime: s.end_time,
        label: `${String(s.start_time).slice(0, 5)} - ${String(s.end_time).slice(0, 5)}`
      }));

    return res.status(200).json({ date, slots: available });
  } catch (error) {
    console.error('get-slots error:', error);
    return res.status(500).json({ error: 'Unexpected slot lookup error.' });
  }
};
