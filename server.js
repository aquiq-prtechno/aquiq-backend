require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const BACKEND_URL = process.env.BACKEND_URL || 'https://web-production-85fd6.up.railway.app';
const JOB_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

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
      device_id,
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
      temperature,
      total_volume_today,
    } = req.body;

    const tds_value = tds_value_raw ?? tds ?? null;

    if (!device_id) return res.status(400).json({ error: 'device_id required' });

    console.log(`[AQUIQ] Data from ${device_id}: TDS=${tds_value}`);

    const sensor_data = {
      feed_tds: feed_tds ?? null,
      membrane_health: membrane_health ?? null,
      rejection_rate: rejection_rate ?? null,
      output_flow: output_flow ?? null,
      reject_flow: reject_flow ?? null,
      reject_ratio: reject_ratio ?? null,
      pump_health: pump_health ?? null,
      pump_current: pump_current ?? null,
      temperature: temperature ?? null,
      total_volume_today: total_volume_today ?? null,
    };

    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .update({
        last_tds: tds_value ?? null,
        sensor_data,
        last_seen: new Date().toISOString(),
      })
      .eq('device_id', device_id)
      .select()
      .single();

    if (custErr || !customer) {
      console.error(`[AQUIQ] DB error for ${device_id}:`, JSON.stringify(custErr));
      return res.status(404).json({ error: 'Device not found' });
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

    res.json({ success: true, device_id, tds: tds_value });
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

    // 4. Notify customer we are searching
    await sendWhatsApp(
      customer.phone,
      `🚨 *AQUIQ Alert*\n\nYour RO water TDS is *${tds_value} ppm* (your limit: ${customer.tds_threshold} ppm).\n\n🔍 Finding nearest technician for you...\n\n— AQUIQ™ by PR TECHNO`
    );

    // 5. Start technician search
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
    await sendWhatsApp(
      customer.phone,
      `😔 *AQUIQ Update*\n\nSorry, no technician is available right now for pincode ${customer.pincode}.\n\nWe will notify you as soon as one is available.\n\n— AQUIQ™ by PR TECHNO`
    );
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

  // Send WhatsApp to technician
  await sendWhatsApp(
    technician.phone,
    `🔧 *New AQUIQ Job!*\n\n👤 Customer: ${customer.name}\n🏠 Address: ${customer.address || 'Pincode: ' + customer.pincode}\n📮 Pincode: ${customer.pincode}\n💧 TDS Level: *${tdsValue} ppm* (HIGH! Limit: ${customer.tds_threshold} ppm)\n\n⏰ *You have 3 minutes to accept!*\n\n✅ Accept Job:\n${acceptUrl}\n\n💰 You will earn: ₹400 after AQUIQ commission\n\n— AQUIQ™ by PR TECHNO`
  );

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

      // Notify customer
      await sendWhatsApp(
        customer.phone,
        `🔄 *AQUIQ Update*\n\nTechnician ${technician.name} did not respond.\n\nSearching next available technician...\n\n— AQUIQ™ by PR TECHNO`
      );

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

    // Send customer the map + payment
    await sendWhatsApp(
      customer.phone,
      `✅ *AQUIQ — Technician Confirmed!*\n\n🔧 Technician *${technician?.name}* has accepted your job and is on the way!\n\n🗺 Your location shared with technician:\n${mapsUrl}\n\n💳 Please pay service charge:\n${paymentLink}\n\n— AQUIQ™ by PR TECHNO`
    );

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
async function sendWhatsApp(to, message) {
  try {
    const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:+91${to.replace(/^0/, '')}`;
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: toFormatted,
      body: message
    });
    console.log(`[AQUIQ] WhatsApp sent to ${toFormatted}`);
  } catch (err) {
    console.error(`[AQUIQ] WhatsApp failed to ${to}:`, err.message);
  }
}

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

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AQUIQ Backend running on port ${PORT}`);
  // Run once on startup so prediction is available immediately
  runPredictiveMaintenance();
});
