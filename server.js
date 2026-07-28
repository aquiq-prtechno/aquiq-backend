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

// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'AQUIQ backend is running', timestamp: new Date().toISOString() });
});

// ─── Register Technician ─────────────────────────────────────────────────────
app.post('/technician/register', async (req, res) => {
  const { name, phone, pincode } = req.body;
  if (!name || !phone || !pincode) {
    return res.status(400).json({ error: 'name, phone, pincode are required' });
  }

  const { data, error } = await supabase
    .from('technicians')
    .insert([{ name, phone, pincode, is_available: true }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, technician: data });
});

// ─── Register Customer ───────────────────────────────────────────────────────
app.post('/customer/register', async (req, res) => {
  const { name, phone, pincode, device_id, tds_threshold } = req.body;
  if (!name || !phone || !pincode || !device_id) {
    return res.status(400).json({ error: 'name, phone, pincode, device_id are required' });
  }

  const { data, error } = await supabase
    .from('customers')
    .insert([{ name, phone, pincode, device_id, tds_threshold: tds_threshold || 150 }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, customer: data });
});

// ─── Blynk Webhook — TDS Alert ───────────────────────────────────────────────
app.post('/webhook/blynk', async (req, res) => {
  try {
    const { device_id, tds_value } = req.body;
    console.log(`[AQUIQ] TDS Alert received — device: ${device_id}, TDS: ${tds_value} ppm`);

    // 1. Find customer by device_id
    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('*')
      .eq('device_id', device_id)
      .single();

    if (custErr || !customer) {
      console.log('[AQUIQ] Customer not found for device:', device_id);
      return res.status(404).json({ error: 'Customer not found' });
    }

    // 2. Check if TDS exceeds threshold
    if (parseInt(tds_value) <= customer.tds_threshold) {
      console.log(`[AQUIQ] TDS ${tds_value} is within threshold ${customer.tds_threshold} — no action`);
      return res.json({ status: 'TDS within threshold, no action needed' });
    }

    // 3. Find nearest available technician — same pincode first
    let { data: technician } = await supabase
      .from('technicians')
      .select('*')
      .eq('pincode', customer.pincode)
      .eq('is_available', true)
      .limit(1)
      .single();

    // Fallback: any available technician
    if (!technician) {
      const { data: anyTech } = await supabase
        .from('technicians')
        .select('*')
        .eq('is_available', true)
        .limit(1)
        .single();
      technician = anyTech;
    }

    if (!technician) {
      console.log('[AQUIQ] No technician available right now');
      // Still notify customer
      await sendWhatsApp(
        customer.phone,
        `🚨 AQUIQ Alert: Your RO water TDS is ${tds_value} ppm (your limit: ${customer.tds_threshold} ppm). We are finding a technician for you. Please wait.`
      );
      return res.json({ status: 'No technician available, customer notified' });
    }

    // 4. Create job record
    const { data: job, error: jobErr } = await supabase
      .from('jobs')
      .insert([{
        customer_id: customer.id,
        technician_id: technician.id,
        tds_value: parseInt(tds_value),
        status: 'pending'
      }])
      .select()
      .single();

    if (jobErr) throw new Error(jobErr.message);

    // 5. Generate Cashfree payment link
    const paymentLink = await createCashfreePaymentLink(job.id, customer);

    // 6. Update job with payment link
    await supabase
      .from('jobs')
      .update({ payment_link: paymentLink })
      .eq('id', job.id);

    // 7. Mark technician as unavailable
    await supabase
      .from('technicians')
      .update({ is_available: false })
      .eq('id', technician.id);

    // 8. WhatsApp to technician
    const acceptUrl = `${process.env.BACKEND_URL || 'https://aquiq-backend.up.railway.app'}/technician/accept/${job.id}`;
    await sendWhatsApp(
      technician.phone,
      `🔧 *New AQUIQ Job!*\n\nCustomer: ${customer.name}\nLocation Pincode: ${customer.pincode}\nTDS Level: *${tds_value} ppm* (High!)\n\nReply YES or click to accept:\n${acceptUrl}\n\n— AQUIQ by PR TECHNO`
    );

    // 9. WhatsApp to customer
    await sendWhatsApp(
      customer.phone,
      `✅ *AQUIQ Alert*\n\nYour RO TDS is *${tds_value} ppm* (limit: ${customer.tds_threshold} ppm).\n\nTechnician *${technician.name}* is on the way!\n\nPlease pay the service charge:\n${paymentLink}\n\n— AQUIQ by PR TECHNO`
    );

    console.log(`[AQUIQ] Job ${job.id} created — Technician ${technician.name} dispatched`);
    res.json({ success: true, job_id: job.id, technician: technician.name });

  } catch (err) {
    console.error('[AQUIQ] Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Technician Accepts Job ──────────────────────────────────────────────────
app.post('/technician/accept/:jobId', async (req, res) => {
  const { jobId } = req.params;

  const { data: job, error } = await supabase
    .from('jobs')
    .update({ status: 'accepted' })
    .eq('id', jobId)
    .select('*, customers(*), technicians(*)')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Notify customer that technician confirmed
  if (job.customers) {
    await sendWhatsApp(
      job.customers.phone,
      `✅ *AQUIQ Update*\n\nTechnician *${job.technicians?.name}* has accepted your job and is coming.\n\nDon't forget to make the payment:\n${job.payment_link}\n\n— AQUIQ by PR TECHNO`
    );
  }

  res.json({ success: true, message: 'Job accepted', job });
});

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
    return 'https://aquiq.in/pay/' + jobId;
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AQUIQ Backend running on port ${PORT}`);
});
