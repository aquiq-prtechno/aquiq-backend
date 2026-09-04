require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cron = require('node-cron');


const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);


const BACKEND_URL = process.env.BACKEND_URL || 'https://web-production-85fd6.up.railway.app';
const JOB_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes


// ─── UHAD Auth Routes ─────────────────────────────────────────────────────────

// Register new UHAD
app.post('/auth/uhad/register', async (req, res) => {
  try {
    const { name, company, email, phone, password } = req.body;
    if (!name || !company || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (phone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ error: 'Enter a valid 10-digit phone number.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    // Check duplicate email
    const { data: existingEmail } = await supabase.from('uhads').select('id').eq('email', email.toLowerCase()).single();
    if (existingEmail) return res.status(409).json({ error: 'An account with this email already exists.' });
    // Check duplicate phone
    const { data: existingPhone } = await supabase.from('uhads').select('id').eq('phone', phone.replace(/\D/g, '')).single();
    if (existingPhone) return res.status(409).json({ error: 'An account with this phone number already exists.' });

    const { data, error } = await supabase.from('uhads').insert([{
      name: name.trim(),
      company: company.trim(),
      email: email.trim().toLowerCase(),
      phone: phone.replace(/\D/g, ''),
      password,
    }]).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, uhad: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'AQUIQ backend is running', timestamp: new Date().toISOString() });
});

// ─── Register Technician ─────────────────────────────────────────────────────
app.post('/technician/register', async (req, res) => {
  const { name, phone, pincode, address } = req.body;
  if (!name || !phone || !pincode) {
    return res.status(400).json({ error: 'name, phone, pincode are required' });
  }

  const { data, error } = await supabase
    .from('technicians')
    .insert([{ name, phone, pincode, address: address || '', is_available: true }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, technician: data });
});

// ─── Register Customer ───────────────────────────────────────────────────────
app.post('/customer/register', async (req, res) => {
  const { name, phone, pincode, address, device_id, tds_threshold } = req.body;
  if (!name || !phone || !pincode || !device_id) {
    return res.status(400).json({ error: 'name, phone, pincode, device_id are required' });
  }

  const { data, error } = await supabase
    .from('customers')
    .insert([{ name, phone, pincode, address: address || '', device_id, tds_threshold: tds_threshold || 150 }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, customer: data });
});

// ─── ESP32 Data Ingestion ─────────────────────────────────────────────────────
// ESP32 sends: { device_id, tds_value, feed_tds, membrane_health, rejection_rate,
//               output_flow, reject_flow, reject_ratio, pump_health, pump_current,
//               temperature, total_volume_today }
app.post('/data', async (req, res) => {
  try {
    const {
      device_id,        // Primary ID: AQ-PR51916-32-001001
      wifi_device_id,   // WiFi/MAC ID: 51916-AQ-PR-XX:XX:XX (only when WiFi connected)
      tds_value: tds_value_raw,
      tds,
      feed_tds,
      membrane_health,
      rejection_rate,
      output_flow,
      reject_flow,
      reject_ratio,
      pump_health,
      pump_current,
      pump_peak,
      pump_status,      // "healthy" / "overload" / "weak" / "off" / "calibrating"
      pump_baseline,    // Learned normal current for this pump (A)
      pump_size,        // "small" / "big" / "micro" / "industrial"
      temperature,
      total_volume_today,
    } = req.body;

    const tds_value = tds_value_raw ?? tds ?? null;

    if (!device_id) return res.status(400).json({ error: 'device_id required' });

    console.log(`[AQUIQ] Data from ${device_id} | WiFi ID: ${wifi_device_id ?? 'N/A'} | TDS=${tds_value}`);

    const sensor_data = {
      feed_tds: feed_tds ?? null,
      membrane_health: membrane_health ?? null,
      rejection_rate: rejection_rate ?? null,
      output_flow: output_flow ?? null,
      reject_flow: reject_flow ?? null,
      reject_ratio: reject_ratio ?? null,
      pump_health: pump_health ?? null,
      pump_current: pump_current ?? null,
      pump_peak: pump_peak ?? null,
      pump_status: pump_status ?? null,
      pump_baseline: pump_baseline ?? null,
      pump_size: pump_size ?? null,
      temperature: temperature ?? null,
      total_volume_today: total_volume_today ?? null,
    };

    // Update by Primary ID — also save WiFi ID as proof of connection
    const updatePayload = {
      last_tds: tds_value ?? null,
      sensor_data,
      last_seen: new Date().toISOString(),
    };
    if (wifi_device_id) updatePayload.wifi_device_id = wifi_device_id;
    // Save pump size + baseline when ESP32 sends them (after calibration)
    if (pump_size && pump_size !== 'unknown')  updatePayload.pump_size     = pump_size;
    if (pump_baseline && pump_baseline > 0)    updatePayload.pump_baseline = pump_baseline;
    if (pump_status)                           updatePayload.pump_status   = pump_status;

    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .update(updatePayload)
      .eq('device_id', device_id)
      .select()
      .single();

    if (custErr || !customer) {
      console.error(`[AQUIQ] DB error for ${device_id}:`, JSON.stringify(custErr));
      return res.status(404).json({ error: 'Device not found. Register device in admin first.' });
    }

    // ── Remote Suspension Check ──────────────────────────────────────────────
    // If admin suspended this device — return suspended status immediately
    // ESP32 will show solid red LED and stop sending data
    if (customer.account_status === 'suspended') {
      console.log(`[AQUIQ] ⛔ Device ${device_id} is suspended — blocking data`);
      return res.json({ success: false, device_status: 'suspended', message: 'Device suspended by admin' });
    }

    // Insert into sensor_history for reports & anomaly detection
    supabase.from('sensor_history').insert([{
      device_id: customer.id,
      output_tds: tds_value ?? null,
      feed_tds: feed_tds ?? null,
      membrane_health: membrane_health ?? null,
      rejection_rate: rejection_rate ?? null,
      output_flow: output_flow ?? null,
      pump_health: pump_health ?? null,
      pump_current: pump_current ?? null,
      temperature: temperature ?? null,
      total_volume_today: total_volume_today ?? null,
    }]).then(({ error: histErr }) => {
      if (histErr) console.error('[AQUIQ] History insert error:', histErr.message);
    });

    // Trigger alert if TDS exceeded
    if (tds_value && parseInt(tds_value) > customer.tds_threshold) {
      console.log(`[AQUIQ] TDS exceeded on ${device_id}: ${tds_value} > ${customer.tds_threshold}`);
      // Check no active job already exists for this device
      const { data: existingJobs } = await supabase
        .from('jobs')
        .select('id')
        .eq('customer_id', customer.id)
        .in('status', ['searching', 'pending', 'accepted'])
        .limit(1);

      if (!existingJobs || existingJobs.length === 0) {
        // Create job and dispatch (fire-and-forget)
        supabase.from('jobs').insert([{
          customer_id: customer.id,
          location_id: customer.location_id,
          company_id: customer.company_id,
          tds_value: parseInt(tds_value),
          status: 'searching',
          expires_at: new Date(Date.now() + JOB_TIMEOUT_MS).toISOString(),
        }]).select().single().then(({ data: job }) => {
          if (job) dispatchTechnician(job.id, customer, parseInt(tds_value));
        });
      }
    }

    // Anomaly detection — run asynchronously after sending response
    detectAnomalies(customer, {
      output_tds: tds_value, feed_tds, membrane_health, rejection_rate,
      output_flow, pump_health, pump_current, temperature,
    });

    // Hardware event detection — only logs on threshold breach, not every cycle
    detectHardwareEvents(customer, { pump_current, pump_status, pump_baseline, pump_peak, output_flow, membrane_health });

    // Check for pending remote command (calibrate / restart)
    const pendingCommand = customer.pending_command || null;
    if (pendingCommand) {
      // Clear the command after sending — one-time execution
      await supabase.from('customers').update({ pending_command: null }).eq('id', customer.id);
      console.log(`[AQUIQ] 📡 Sending command "${pendingCommand}" to ${device_id}`);
    }

    res.json({ success: true, device_id, tds: tds_value, device_status: 'active', command: pendingCommand || '' });
  } catch (err) {
    console.error('[AQUIQ] /data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Anomaly Detection ────────────────────────────────────────────────────────
async function detectAnomalies(customer, current) {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: history } = await supabase
      .from('sensor_history')
      .select('output_tds, membrane_health, output_flow, pump_health')
      .eq('device_id', customer.id)
      .gte('recorded_at', sevenDaysAgo);

    if (!history || history.length < 6) return;

    const checks = [
      { key: 'output_tds',      label: 'TDS',             unit: 'ppm' },
      { key: 'membrane_health', label: 'Membrane Health',  unit: '%'   },
      { key: 'output_flow',     label: 'Output Flow',      unit: 'L/min' },
      { key: 'pump_health',     label: 'Pump Health',      unit: '%'   },
    ];

    const anomalies = [];

    for (const check of checks) {
      const currentVal = current[check.key];
      if (currentVal == null) continue;

      const vals = history.map(r => r[check.key]).filter(v => v != null);
      if (vals.length < 4) continue;

      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length);
      const normalMin = mean - 2.5 * std;
      const normalMax = mean + 2.5 * std;

      let isAnomaly = false;
      let severity = 'warning';
      let message = '';

      if (currentVal > normalMax) {
        isAnomaly = true;
        severity = currentVal > mean + 4 * std ? 'critical' : 'warning';
        message = `${check.label} spike: ${currentVal}${check.unit} (normal max: ${Math.round(normalMax)}${check.unit})`;
      } else if (currentVal < normalMin) {
        isAnomaly = true;
        severity = currentVal < mean - 4 * std ? 'critical' : 'warning';
        message = `${check.label} drop: ${currentVal}${check.unit} (normal min: ${Math.round(normalMin)}${check.unit})`;
      }

      // TDS above customer threshold is always critical
      if (check.key === 'output_tds' && currentVal > customer.tds_threshold) {
        isAnomaly = true;
        severity = 'critical';
        message = `TDS exceeded limit: ${currentVal}ppm (your limit: ${customer.tds_threshold}ppm)`;
      }

      // Sudden >30% shift from last snapshot
      const lastVal = vals[vals.length - 1];
      if (lastVal && Math.abs(currentVal - lastVal) / lastVal > 0.3) {
        isAnomaly = true;
        severity = 'warning';
        message = `Sudden ${check.label} change: ${lastVal}→${currentVal}${check.unit} (${Math.round(Math.abs(currentVal - lastVal) / lastVal * 100)}% shift)`;
      }

      if (!isAnomaly) continue;

      // Avoid duplicates — skip if same sensor anomaly exists in last 2 hours
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data: existing } = await supabase
        .from('anomalies')
        .select('id')
        .eq('device_id', customer.id)
        .eq('sensor', check.key)
        .gte('detected_at', twoHoursAgo)
        .limit(1);

      if (!existing?.length) {
        anomalies.push({
          device_id: customer.id,
          sensor: check.key,
          current_value: currentVal,
          normal_min: Math.round(normalMin * 10) / 10,
          normal_max: Math.round(normalMax * 10) / 10,
          severity,
          message,
        });
      }
    }

    if (!anomalies.length) return;

    await supabase.from('anomalies').insert(anomalies);
    console.log(`[AQUIQ] ${anomalies.length} anomaly(s) detected for device ${customer.device_id}`);

    if (customer.push_token) {
      for (const anomaly of anomalies) {
        await sendPushNotification(
          customer.push_token,
          anomaly.severity === 'critical' ? '🚨 AQUIQ Critical Alert' : '⚠️ AQUIQ Warning',
          anomaly.message,
          anomaly.severity
        );
      }
    }
  } catch (err) {
    console.error('[AQUIQ] Anomaly detection error:', err.message);
  }
}

async function sendPushNotification(token, title, body, severity = 'warning') {
  try {
    const channelId = severity === 'critical' ? 'aquiq-critical'
      : severity === 'warning' ? 'aquiq-warning'
      : 'aquiq-info';

    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: token,
      title,
      body,
      sound: 'aquiq_alert',        // custom AQUIQ sound on iOS
      channelId,                   // Android channel (has custom sound embedded)
      priority: severity === 'critical' ? 'high' : 'normal',
      badge: 1,
      data: { type: 'anomaly', severity },
    }, { headers: { 'Content-Type': 'application/json' } });
    console.log(`[AQUIQ] Push sent — channel: ${channelId}`);
  } catch (err) {
    console.error('[AQUIQ] Push notification failed:', err.message);
  }
}

// ─── Blynk Webhook — TDS Alert ───────────────────────────────────────────────
app.post('/webhook/blynk', async (req, res) => {
  try {
    const { device_id, tds_value } = req.body;
    console.log(`[AQUIQ] TDS Alert — device: ${device_id}, TDS: ${tds_value} ppm`);

    // 1. Find customer
    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('*')
      .eq('device_id', device_id)
      .single();

    if (custErr || !customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // 2. Check threshold
    if (parseInt(tds_value) <= customer.tds_threshold) {
      return res.json({ status: 'TDS within threshold, no action needed' });
    }

    // 3. Create job first
    const { data: job, error: jobErr } = await supabase
      .from('jobs')
      .insert([{
        customer_id: customer.id,
        tds_value: parseInt(tds_value),
        status: 'searching',
        expires_at: new Date(Date.now() + JOB_TIMEOUT_MS).toISOString()
      }])
      .select()
      .single();

    if (jobErr) throw new Error(jobErr.message);

    // 4. Start technician search
    res.json({ success: true, job_id: job.id, status: 'searching' });

    // Run dispatch asynchronously
    dispatchTechnician(job.id, customer, parseInt(tds_value));

  } catch (err) {
    console.error('[AQUIQ] Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Dispatch Technician (with timeout & retry) ───────────────────────────────
async function dispatchTechnician(jobId, customer, tdsValue, excludeIds = []) {
  console.log(`[AQUIQ] Searching technician for job ${jobId}, excluding: ${excludeIds}`);

  // Find available technician — same pincode first
  let query = supabase
    .from('technicians')
    .select('*')
    .eq('is_available', true);

  if (excludeIds.length > 0) {
    query = query.not('id', 'in', `(${excludeIds.join(',')})`);
  }

  // Try same pincode first
  let { data: technician } = await query
    .eq('pincode', customer.pincode)
    .limit(1)
    .single();

  // Fallback: any available technician
  if (!technician) {
    let fallbackQuery = supabase
      .from('technicians')
      .select('*')
      .eq('is_available', true);

    if (excludeIds.length > 0) {
      fallbackQuery = fallbackQuery.not('id', 'in', `(${excludeIds.join(',')})`);
    }

    const { data: anyTech } = await fallbackQuery.limit(1).single();
    technician = anyTech;
  }

  if (!technician) {
    console.log('[AQUIQ] No technician available for job', jobId);
    await supabase.from('jobs').update({ status: 'no_technician' }).eq('id', jobId);
    return;
  }

  // Assign technician to job
  await supabase
    .from('jobs')
    .update({ technician_id: technician.id, status: 'pending' })
    .eq('id', jobId);

  // Mark technician unavailable
  await supabase
    .from('technicians')
    .update({ is_available: false })
    .eq('id', technician.id);

  const acceptUrl = `${BACKEND_URL}/technician/accept/${jobId}`;
  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(customer.address || customer.pincode + ', India')}`;

  console.log(`[AQUIQ] Job ${jobId} — Technician ${technician.name} dispatched, waiting 3 min`);

  // Wait 3 minutes then check if accepted
  setTimeout(async () => {
    const { data: updatedJob } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (updatedJob && updatedJob.status === 'pending') {
      console.log(`[AQUIQ] Job ${jobId} — Technician ${technician.name} did not respond. Searching next...`);

      // Free technician back
      await supabase
        .from('technicians')
        .update({ is_available: true })
        .eq('id', technician.id);

      // Try next technician
      dispatchTechnician(jobId, customer, tdsValue, [...excludeIds, technician.id]);
    }
  }, JOB_TIMEOUT_MS);
}

// ─── Technician Accepts Job (GET — from WhatsApp link click) ─────────────────
app.get('/technician/accept/:jobId', async (req, res) => {
  return acceptJob(req, res);
});

app.post('/technician/accept/:jobId', async (req, res) => {
  return acceptJob(req, res);
});

async function acceptJob(req, res) {
  const { jobId } = req.params;

  // Check job is still pending
  const { data: currentJob } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (!currentJob || currentJob.status !== 'pending') {
    return res.send(`<h2>Sorry, this job is no longer available.</h2>`);
  }

  const { data: job, error } = await supabase
    .from('jobs')
    .update({ status: 'accepted' })
    .eq('id', jobId)
    .select('*, customers(*), technicians(*)')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const customer = job.customers;
  const technician = job.technicians;

  if (customer) {
    const paymentLink = await createCashfreePaymentLink(jobId, customer);
    const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(customer.address || customer.pincode + ', India')}`;

    // Update job with payment link
    await supabase.from('jobs').update({ payment_link: paymentLink }).eq('id', jobId);
  }

  res.send(`<h2 style="font-family:sans-serif;color:green;">✅ Job Accepted! Head to customer location.</h2><p style="font-family:sans-serif;">Customer: ${customer?.name} | Pincode: ${customer?.pincode}</p>`);
}

// ─── List All Jobs (Admin) ───────────────────────────────────────────────────
app.get('/jobs', async (req, res) => {
  const { data, error } = await supabase
    .from('jobs')
    .select('*, customers(*), technicians(*)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ jobs: data });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createCashfreePaymentLink(jobId, customer) {
  try {
    const response = await axios.post(
      'https://api.cashfree.com/pg/links',
      {
        link_id: `aquiq-${jobId}`,
        link_amount: 500,
        link_currency: 'INR',
        link_purpose: 'AQUIQ RO Service',
        customer_details: {
          customer_phone: customer.phone,
          customer_name: customer.name
        },
        link_expiry_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        link_notify: { send_sms: false, send_email: false }
      },
      {
        headers: {
          'x-client-id': process.env.CASHFREE_APP_ID,
          'x-client-secret': process.env.CASHFREE_SECRET_KEY,
          'x-api-version': '2023-08-01',
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data.link_url;
  } catch (err) {
    console.error('[AQUIQ] Cashfree payment link failed:', err.message);
    return `${BACKEND_URL}/pay/${jobId}`;
  }
}

// ─── Predictive Maintenance ───────────────────────────────────────────────────

// Linear regression: returns { slope, intercept, r2 }
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  const ssTot = points.reduce((a, p) => a + Math.pow(p.y - meanY, 2), 0);
  const ssRes = points.reduce((a, p) => a + Math.pow(p.y - (slope * p.x + intercept), 2), 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

async function runPredictiveMaintenance() {
  console.log('[AQUIQ] Running predictive maintenance analysis...');
  try {
    const { data: customers } = await supabase
      .from('customers')
      .select('id, device_id, name, tds_threshold, push_token');

    if (!customers?.length) return;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    for (const customer of customers) {
      try {
        const { data: history } = await supabase
          .from('sensor_history')
          .select('recorded_at, output_tds, membrane_health, pump_health')
          .eq('device_id', customer.id)
          .gte('recorded_at', thirtyDaysAgo)
          .order('recorded_at', { ascending: true });

        if (!history || history.length < 7) continue; // need at least 7 data points

        const threshold = customer.tds_threshold || 150;
        const now = Date.now();

        // Convert timestamps to days-from-first-reading for regression
        const t0 = new Date(history[0].recorded_at).getTime();
        const tdsPoints = history
          .filter(r => r.output_tds != null)
          .map(r => ({ x: (new Date(r.recorded_at).getTime() - t0) / (24 * 60 * 60 * 1000), y: r.output_tds }));

        const memPoints = history
          .filter(r => r.membrane_health != null)
          .map(r => ({ x: (new Date(r.recorded_at).getTime() - t0) / (24 * 60 * 60 * 1000), y: r.membrane_health }));

        const tdsTrend = linearRegression(tdsPoints);
        const memTrend = linearRegression(memPoints);

        // Days since first reading
        const daysSinceFirst = (now - t0) / (24 * 60 * 60 * 1000);
        const currentTds = tdsPoints[tdsPoints.length - 1]?.y ?? null;
        const currentMem = memPoints[memPoints.length - 1]?.y ?? null;

        let prediction = null;

        // TDS prediction: when will TDS hit the threshold?
        if (tdsTrend && tdsTrend.slope > 0 && tdsTrend.r2 > 0.3 && currentTds != null) {
          const daysToThreshold = (threshold - tdsTrend.intercept - tdsTrend.slope * daysSinceFirst) / tdsTrend.slope;
          if (daysToThreshold > 0 && daysToThreshold < 90) {
            const predictedDate = new Date(now + daysToThreshold * 24 * 60 * 60 * 1000);
            const urgency = daysToThreshold <= 7 ? 'critical' : daysToThreshold <= 21 ? 'warning' : 'info';
            prediction = {
              type: 'tds_rising',
              predicted_failure_date: predictedDate.toISOString(),
              days_remaining: Math.round(daysToThreshold),
              current_tds: Math.round(currentTds),
              tds_threshold: threshold,
              tds_slope_per_day: Math.round(tdsTrend.slope * 10) / 10,
              r2: Math.round(tdsTrend.r2 * 100) / 100,
              urgency,
              message: `TDS rising ${tdsTrend.slope.toFixed(1)} ppm/day. Predicted to exceed ${threshold}ppm in ${Math.round(daysToThreshold)} days (${predictedDate.toLocaleDateString('en-IN')}).`,
            };
          }
        }

        // Membrane prediction: if health declining steeply
        if (!prediction && memTrend && memTrend.slope < -0.3 && memTrend.r2 > 0.3 && currentMem != null) {
          const daysTo40 = (40 - (memTrend.intercept + memTrend.slope * daysSinceFirst)) / memTrend.slope;
          if (daysTo40 > 0 && daysTo40 < 90) {
            const predictedDate = new Date(now + daysTo40 * 24 * 60 * 60 * 1000);
            const urgency = daysTo40 <= 7 ? 'critical' : daysTo40 <= 21 ? 'warning' : 'info';
            prediction = {
              type: 'membrane_degrading',
              predicted_failure_date: predictedDate.toISOString(),
              days_remaining: Math.round(daysTo40),
              current_membrane: Math.round(currentMem),
              membrane_slope_per_day: Math.round(memTrend.slope * 10) / 10,
              r2: Math.round(memTrend.r2 * 100) / 100,
              urgency,
              message: `Membrane degrading ${Math.abs(memTrend.slope).toFixed(1)}%/day. Predicted to reach critical level in ${Math.round(daysTo40)} days (${predictedDate.toLocaleDateString('en-IN')}).`,
            };
          }
        }

        // System healthy — no prediction needed
        if (!prediction) {
          prediction = {
            type: 'healthy',
            urgency: 'good',
            message: 'System trending stable. No service predicted in next 90 days.',
            analyzed_at: new Date().toISOString(),
          };
        } else {
          prediction.analyzed_at = new Date().toISOString();
        }

        // Save prediction to customers table
        await supabase
          .from('customers')
          .update({ maintenance_prediction: prediction })
          .eq('id', customer.id);

        console.log(`[AQUIQ] Prediction for ${customer.device_id}: ${prediction.urgency} — ${prediction.message}`);

        // Send push alert if urgent or critical
        if (customer.push_token && (prediction.urgency === 'critical' || prediction.urgency === 'warning')) {
          await sendPushNotification(
            customer.push_token,
            prediction.urgency === 'critical' ? '🚨 Service Required Soon' : '🔧 Maintenance Alert',
            prediction.message,
            prediction.urgency
          );
        }
      } catch (err) {
        console.error(`[AQUIQ] Prediction error for ${customer.device_id}:`, err.message);
      }
    }
    console.log('[AQUIQ] Predictive maintenance analysis complete.');
  } catch (err) {
    console.error('[AQUIQ] Predictive maintenance failed:', err.message);
  }
}

// Manual trigger endpoint (for testing)
app.get('/admin/predict', async (req, res) => {
  await runPredictiveMaintenance();
  res.json({ success: true, message: 'Prediction run complete' });
});

// Run every Monday at 6 AM IST (00:30 UTC)
cron.schedule('30 0 * * 1', runPredictiveMaintenance);

// ─── Monthly Report Auto-Generation ──────────────────────────────────────────
async function generateMonthlyReports() {
  console.log('[REPORTS] Starting monthly report generation...');
  const now = new Date();
  // Previous month
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth(); // 1-indexed
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const monthLabel = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const start = new Date(year, month - 1, 1).toISOString();
  const end = new Date(year, month, 0, 23, 59, 59).toISOString();

  // Get all active UHSA stores
  const { data: stores, error: storeErr } = await supabase
    .from('customers')
    .select('id, tds_threshold, account_status')
    .eq('role', 'uhsa')
    .or('account_status.eq.active,account_status.is.null');

  if (storeErr || !stores) {
    console.error('[REPORTS] Failed to fetch stores:', storeErr?.message);
    return;
  }

  let count = 0;
  for (const store of stores) {
    const { data: rows } = await supabase
      .from('sensor_history').select('*')
      .eq('device_id', store.id)
      .gte('recorded_at', start).lte('recorded_at', end);

    if (!rows || rows.length === 0) continue;

    const tds  = rows.map(r => r.output_tds).filter(v => v != null);
    const mem  = rows.map(r => r.membrane_health).filter(v => v != null);
    const pump = rows.map(r => r.pump_health).filter(v => v != null);
    const flow = rows.map(r => r.output_flow).filter(v => v != null);
    const temp = rows.map(r => r.temperature).filter(v => v != null);
    const vol  = rows.map(r => r.total_volume_today).filter(v => v != null);
    const avg  = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
    const threshold = store.tds_threshold || 150;
    const avgTds = avg(tds);
    const overall = avgTds > threshold ? 'critical' : avgTds > threshold * 0.85 ? 'warning' : 'good';

    const summary = {
      avg_tds: avgTds,
      min_tds: tds.length ? Math.min(...tds) : null,
      max_tds: tds.length ? Math.max(...tds) : null,
      tds_exceed: tds.filter(v => v > threshold).length,
      avg_membrane: avg(mem),
      avg_pump: avg(pump),
      avg_flow: avg(flow),
      avg_temp: avg(temp),
      total_volume: vol.length ? Math.round(vol.reduce((a, b) => a + b, 0) * 10) / 10 : null,
      tds_threshold: threshold,
      overall_status: overall,
    };

    await supabase.from('reports').upsert({
      device_id: store.id,
      month: monthKey,
      month_label: monthLabel,
      summary,
      row_count: rows.length,
      generated_at: new Date().toISOString(),
    }, { onConflict: 'device_id,month' });

    count++;
  }
  console.log(`[REPORTS] Done — ${count} reports generated for ${monthLabel}`);
}

// Run on 1st of every month at 12:05 AM IST (18:35 UTC previous day)
// IST = UTC + 5:30, so 12:05 AM IST = 18:35 UTC of previous day
cron.schedule('35 18 28-31 * *', () => {
  // Only run on actual last-day-of-month transitions
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (tomorrow.getDate() === 1) generateMonthlyReports();
});
// Also run on 1st at 12:05 AM IST as backup
cron.schedule('35 18 1 * *', generateMonthlyReports);

// Manual trigger endpoint (for admin panel "Generate" button)
app.post('/reports/generate', async (req, res) => {
  const { month, store_id } = req.body; // month: 'YYYY-MM', store_id: optional
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });

  const [year, mon] = month.split('-').map(Number);
  const monthLabel = new Date(year, mon - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const start = new Date(year, mon - 1, 1).toISOString();
  const end = new Date(year, mon, 0, 23, 59, 59).toISOString();

  let query = supabase.from('customers').select('id, tds_threshold').eq('role', 'uhsa');
  if (store_id) query = query.eq('id', store_id);
  const { data: stores } = await query;
  if (!stores) return res.status(500).json({ error: 'Failed to fetch stores' });

  let count = 0;
  for (const store of stores) {
    const { data: rows } = await supabase
      .from('sensor_history').select('*')
      .eq('device_id', store.id)
      .gte('recorded_at', start).lte('recorded_at', end);

    if (!rows || rows.length === 0) continue;

    const tds  = rows.map(r => r.output_tds).filter(v => v != null);
    const mem  = rows.map(r => r.membrane_health).filter(v => v != null);
    const pump = rows.map(r => r.pump_health).filter(v => v != null);
    const flow = rows.map(r => r.output_flow).filter(v => v != null);
    const temp = rows.map(r => r.temperature).filter(v => v != null);
    const vol  = rows.map(r => r.total_volume_today).filter(v => v != null);
    const avg  = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
    const threshold = store.tds_threshold || 150;
    const avgTds = avg(tds);

    await supabase.from('reports').upsert({
      device_id: store.id, month, month_label: monthLabel,
      summary: {
        avg_tds: avgTds, min_tds: tds.length ? Math.min(...tds) : null,
        max_tds: tds.length ? Math.max(...tds) : null,
        tds_exceed: tds.filter(v => v > threshold).length,
        avg_membrane: avg(mem), avg_pump: avg(pump),
        avg_flow: avg(flow), avg_temp: avg(temp),
        total_volume: vol.length ? Math.round(vol.reduce((a, b) => a + b, 0) * 10) / 10 : null,
        tds_threshold: threshold,
        overall_status: avgTds > threshold ? 'critical' : avgTds > threshold * 0.85 ? 'warning' : 'good',
      },
      row_count: rows.length,
      generated_at: new Date().toISOString(),
    }, { onConflict: 'device_id,month' });
    count++;
  }
  res.json({ success: true, count, month, monthLabel });
});

// ─── Hardware Event Detection ─────────────────────────────────────────────────
// Only fires when something bad happens — not every 30 sec cycle
async function detectHardwareEvents(customer, data) {
  try {
    const { pump_current, pump_status, pump_baseline, pump_peak, output_flow, membrane_health } = data;
    const events = [];
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    async function alreadyLogged(event_type) {
      const { data: existing } = await supabase
        .from('hardware_events')
        .select('id')
        .eq('device_id', customer.device_id)
        .eq('event_type', event_type)
        .gte('created_at', oneHourAgo)
        .limit(1);
      return existing && existing.length > 0;
    }

    // 1. Pump overload — current spike way above baseline
    if (pump_current && pump_baseline && pump_baseline > 1 && pump_current > pump_baseline * 1.5) {
      if (!(await alreadyLogged('pump_overload'))) {
        events.push({
          device_id: customer.device_id,
          customer_id: customer.id,
          event_type: 'pump_overload',
          value: pump_current,
          unit: 'A',
          message: `Pump overload: ${pump_current.toFixed(1)}A (baseline: ${pump_baseline.toFixed(1)}A — ${Math.round((pump_current/pump_baseline-1)*100)}% over)`,
          severity: 'critical',
        });
      }
    }

    // 2. Pump weak — current dropped far below baseline (clog or failing motor)
    if (pump_current && pump_baseline && pump_baseline > 1 && pump_current < pump_baseline * 0.5 && pump_current > 0.5) {
      if (!(await alreadyLogged('pump_weak'))) {
        events.push({
          device_id: customer.device_id,
          customer_id: customer.id,
          event_type: 'pump_weak',
          value: pump_current,
          unit: 'A',
          message: `Pump running weak: ${pump_current.toFixed(1)}A (expected ~${pump_baseline.toFixed(1)}A — possible clog or motor issue)`,
          severity: 'warning',
        });
      }
    }

    // 3. Pump off unexpectedly — near zero current but was calibrated
    if (pump_status === 'off' && pump_baseline && pump_baseline > 1) {
      if (!(await alreadyLogged('pump_off'))) {
        events.push({
          device_id: customer.device_id,
          customer_id: customer.id,
          event_type: 'pump_off',
          value: pump_current ?? 0,
          unit: 'A',
          message: `Pump stopped unexpectedly: ${(pump_current||0).toFixed(1)}A detected (baseline: ${pump_baseline.toFixed(1)}A)`,
          severity: 'critical',
        });
      }
    }

    // 4. Current spike (peak way above average — voltage surge)
    if (pump_peak && pump_current && pump_peak > pump_current * 2.5 && pump_peak > 5) {
      if (!(await alreadyLogged('current_spike'))) {
        events.push({
          device_id: customer.device_id,
          customer_id: customer.id,
          event_type: 'current_spike',
          value: pump_peak,
          unit: 'A',
          message: `High current spike detected: peak ${pump_peak.toFixed(1)}A vs avg ${pump_current.toFixed(1)}A — possible voltage surge`,
          severity: 'warning',
        });
      }
    }

    // 5. No flow but pump running
    if (output_flow === 0 && pump_status === 'healthy') {
      if (!(await alreadyLogged('no_flow'))) {
        events.push({
          device_id: customer.device_id,
          customer_id: customer.id,
          event_type: 'no_flow',
          value: 0,
          unit: 'L/min',
          message: `Zero flow while pump running — possible pipe blockage or membrane failure`,
          severity: 'critical',
        });
      }
    }

    // 6. Membrane health critical drop
    if (membrane_health != null && membrane_health < 30) {
      if (!(await alreadyLogged('membrane_critical'))) {
        events.push({
          device_id: customer.device_id,
          customer_id: customer.id,
          event_type: 'membrane_critical',
          value: membrane_health,
          unit: '%',
          message: `Membrane health critically low: ${membrane_health}% — replacement needed soon`,
          severity: 'critical',
        });
      }
    }

    if (!events.length) return;
    await supabase.from('hardware_events').insert(events);
    console.log(`[AQUIQ] ⚠️ ${events.length} hardware event(s) logged for ${customer.device_id}`);
  } catch (err) {
    console.error('[AQUIQ] Hardware event detection error:', err.message);
  }
}

// ─── GET Hardware Events for a device ────────────────────────────────────────
// ─── Remote Command — admin triggers calibrate/restart on ESP32 ──────────────
app.post('/device/command/:device_id', async (req, res) => {
  try {
    const { device_id } = req.params;
    const { command } = req.body; // "calibrate" or "restart"
    if (!['calibrate', 'restart'].includes(command)) return res.status(400).json({ error: 'Invalid command' });
    const { error } = await supabase.from('customers').update({ pending_command: command }).eq('device_id', device_id);
    if (error) return res.status(500).json({ error: error.message });
    console.log(`[AQUIQ] 📡 Command "${command}" queued for ${device_id}`);
    res.json({ success: true, message: `Command "${command}" will execute on next ESP32 ping (within 30 sec)` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST a manual hardware event (e.g. hardware swap from admin panel)
app.post('/hardware-events/:device_id', async (req, res) => {
  try {
    const { device_id } = req.params;
    const { customer_id, event_type, message, severity = 'info', value, unit } = req.body;
    const { error } = await supabase.from('hardware_events').insert([{
      device_id, customer_id, event_type, message, severity, value, unit,
    }]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/hardware-events/:device_id', async (req, res) => {
  try {
    const { device_id } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    const { data, error } = await supabase
      .from('hardware_events')
      .select('*')
      .eq('device_id', device_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ events: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AQUIQ Backend running on port ${PORT}`);
  // Run once on startup so prediction is available immediately
  runPredictiveMaintenance();
});

// ─── Raw TCP Listener (for A7670C / 4G devices that can't do HTTPS on-device) ──
// Device opens a plain TCP socket (AT+CIPSTART / AT+CIPSEND — no SSL needed),
// sends the same JSON body used by POST /data, and closes the connection.
// We forward it internally to the existing /data logic and write back the reply.
const net = require('net');
const TCP_PORT = process.env.TCP_PORT || 4000;

const tcpServer = net.createServer((socket) => {
  let buffer = '';
  socket.setTimeout(15000); // give slow cellular connections time

  socket.on('data', (chunk) => {
    buffer += chunk.toString();
  });

  socket.on('timeout', () => {
    console.log('[TCP] Socket timed out, closing');
    socket.end();
  });

  socket.on('error', (err) => {
    console.error('[TCP] Socket error:', err.message);
  });

  socket.on('end', async () => {
    console.log(`[TCP] Received ${buffer.length} bytes`);
    try {
      const payload = JSON.parse(buffer.trim());
      const response = await axios.post(`http://localhost:${PORT}/data`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log('[TCP] Forwarded to /data, response:', JSON.stringify(response.data));
      socket.write(JSON.stringify(response.data));
    } catch (err) {
      console.error('[TCP] Error processing payload:', err.message);
      socket.write(JSON.stringify({ success: false, error: err.message }));
    } finally {
      socket.end();
    }
  });
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`AQUIQ TCP listener (for 4G devices) running on port ${TCP_PORT}`);
});
