require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
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
      tds_value,
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
      return res.status(404).json({ error: 'Device not found' });
    }

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

    res.json({ success: true, device_id, tds: tds_value });
  } catch (err) {
    console.error('[AQUIQ] /data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AQUIQ Backend running on port ${PORT}`);
});
