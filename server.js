require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);


const BACKEND_URL = process.env.BACKEND_URL || 'https://web-production-85fd6.up.railway.app';
const JOB_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

// ─── Email Transporter ────────────────────────────────────────────────────────
// Works with any email provider — custom domain, Zoho, Outlook, Gmail, etc.
// Set EMAIL_HOST, EMAIL_USER, EMAIL_PASS in Railway env vars
const mailer = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',  // e.g. mail.prtechno.in
  port: parseInt(process.env.EMAIL_PORT || '465'),
  secure: process.env.EMAIL_PORT !== '587',           // true for 465, false for 587
  auth: {
    user: process.env.EMAIL_USER,   // e.g. aquiq@prtechno.in
    pass: process.env.EMAIL_PASS,   // email account password
  },
});

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOTPEmail(toEmail, otp, name) {
  const year = new Date().getFullYear();
  const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>AQUIQ Password Reset OTP</title>
</head>
<body style="margin:0;padding:0;background:#0a0d12;font-family:'Segoe UI',Arial,sans-serif;">

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0d12;padding:32px 0;">
    <tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#0f1623;border-radius:20px;overflow:hidden;border:1px solid #1a2540;">

      <!-- ── HEADER ── -->
      <tr>
        <td style="background:linear-gradient(135deg,#050810 0%,#0a1628 100%);padding:36px 40px 28px;text-align:center;border-bottom:1px solid #0d1e33;">
          <!-- Water drop SVG -->
          <div style="margin-bottom:16px;">
            <svg width="44" height="56" viewBox="0 0 44 56" xmlns="http://www.w3.org/2000/svg">
              <path d="M22 2 C22 2 2 28 2 38 C2 49 11 54 22 54 C33 54 42 49 42 38 C42 28 22 2 22 2Z" fill="#00d4ff" opacity="0.15"/>
              <path d="M22 6 C22 6 5 30 5 39 C5 48.4 12.8 53 22 53 C31.2 53 39 48.4 39 39 C39 30 22 6 22 6Z" fill="none" stroke="#00d4ff" stroke-width="1.5"/>
              <ellipse cx="16" cy="34" rx="4" ry="7" fill="#00d4ff" opacity="0.3" transform="rotate(-25 16 34)"/>
            </svg>
          </div>
          <!-- Wordmark -->
          <div style="font-size:36px;font-weight:900;letter-spacing:10px;color:#ffffff;line-height:1;">AQUIQ</div>
          <div style="font-size:10px;color:#00d4ff;letter-spacing:3px;margin-top:6px;text-transform:uppercase;">Smart RO Monitoring</div>
          <div style="font-size:10px;color:#334466;letter-spacing:2px;margin-top:3px;text-transform:uppercase;">by PR TECHNO</div>
        </td>
      </tr>

      <!-- ── TITLE BAND ── -->
      <tr>
        <td style="background:#00d4ff;padding:10px 40px;text-align:center;">
          <span style="font-size:12px;font-weight:800;color:#000;letter-spacing:2px;text-transform:uppercase;">🔐 Password Reset Request</span>
        </td>
      </tr>

      <!-- ── BODY ── -->
      <tr>
        <td style="padding:36px 40px 28px;">

          <!-- Greeting -->
          <p style="margin:0 0 6px;font-size:22px;font-weight:800;color:#ffffff;">Hello, ${name || 'there'} 👋</p>
          <p style="margin:0 0 28px;font-size:14px;color:#7a8fa8;line-height:1.7;">
            We received a request to reset the password for your <strong style="color:#00d4ff;">AQUIQ UHAD account</strong>.
            Use the one-time password below to proceed.
          </p>

          <!-- OTP Box -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
              <td style="background:#050e1c;border:1.5px solid #00d4ff;border-radius:14px;padding:30px 20px;text-align:center;">
                <div style="font-size:11px;color:#445566;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px;">Your One-Time Password</div>
                <div style="font-size:52px;font-weight:900;letter-spacing:14px;color:#00d4ff;line-height:1;font-variant-numeric:tabular-nums;">${otp}</div>
                <div style="margin-top:16px;display:inline-block;background:#0d2040;border:1px solid #003366;border-radius:20px;padding:5px 16px;">
                  <span style="font-size:12px;color:#4488aa;">⏱ Expires in </span>
                  <strong style="color:#00d4ff;font-size:12px;">10 minutes</strong>
                </div>
              </td>
            </tr>
          </table>

          <!-- Steps -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
            <tr>
              <td style="background:#0a1628;border-radius:12px;padding:20px 22px;">
                <div style="font-size:11px;color:#445566;letter-spacing:2px;text-transform:uppercase;margin-bottom:14px;">How to use</div>
                ${[
                  ['1', 'Go back to the AQUIQ app on your phone'],
                  ['2', 'Enter this 6-digit OTP in the verification field'],
                  ['3', 'Set your new password and confirm it'],
                ].map(([n, text]) => `
                <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
                  <tr>
                    <td width="28" valign="top">
                      <div style="width:24px;height:24px;border-radius:50%;background:#00d4ff22;border:1px solid #00d4ff44;text-align:center;line-height:24px;font-size:11px;font-weight:800;color:#00d4ff;">${n}</div>
                    </td>
                    <td style="padding-left:10px;font-size:13px;color:#8899aa;line-height:20px;">${text}</td>
                  </tr>
                </table>`).join('')}
              </td>
            </tr>
          </table>

          <!-- Security notice -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="background:#1a0a00;border:1px solid #331500;border-radius:10px;padding:14px 16px;">
                <p style="margin:0;font-size:12px;color:#aa6633;line-height:1.6;">
                  ⚠️ <strong style="color:#cc8844;">Did not request this?</strong><br/>
                  If you did not request a password reset, please ignore this email. Your account remains secure and no changes have been made.
                </p>
              </td>
            </tr>
          </table>

        </td>
      </tr>

      <!-- ── DIVIDER ── -->
      <tr><td style="padding:0 40px;"><div style="height:1px;background:#1a2540;"></div></td></tr>

      <!-- ── FOOTER ── -->
      <tr>
        <td style="padding:24px 40px;text-align:center;">
          <div style="font-size:16px;font-weight:900;letter-spacing:5px;color:#334455;margin-bottom:4px;">AQUIQ™</div>
          <div style="font-size:11px;color:#223344;margin-bottom:14px;">Smart RO Monitoring Platform · by PR TECHNO</div>

          <div style="height:1px;background:#151f2e;margin-bottom:14px;"></div>

          <div style="font-size:10px;color:#1e2d3d;line-height:1.8;">
            This email was sent to <span style="color:#2a4060;">${toEmail}</span><br/>
            Sent at ${time} IST · noreply@prtechno.in<br/>
            © ${year} PR TECHNO. All rights reserved.
          </div>
        </td>
      </tr>

    </table>
    </td></tr>
  </table>

</body>
</html>`;

  await mailer.sendMail({
    from: '"AQUIQ™ by PR TECHNO" <noreply@prtechno.in>',
    to: toEmail,
    subject: `${otp} — Your AQUIQ Password Reset OTP (valid 10 min)`,
    html,
  });
}

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

// Send OTP for forgot password
app.post('/auth/uhad/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const { data: uhad } = await supabase.from('uhads').select('id, name, email').eq('email', email.toLowerCase()).single();
    if (!uhad) return res.status(404).json({ error: 'No account found with this email.' });

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    await supabase.from('uhads').update({ otp_code: otp, otp_expires_at: expiresAt }).eq('id', uhad.id);
    await sendOTPEmail(uhad.email, otp, uhad.name);

    res.json({ success: true, message: 'OTP sent to your email.' });
  } catch (err) {
    console.error('[AQUIQ] OTP error:', err.message);
    res.status(500).json({ error: 'Failed to send OTP. Check email configuration.' });
  }
});

// Verify OTP + reset password
app.post('/auth/uhad/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) return res.status(400).json({ error: 'All fields required.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const { data: uhad } = await supabase.from('uhads')
      .select('id, otp_code, otp_expires_at').eq('email', email.toLowerCase()).single();

    if (!uhad) return res.status(404).json({ error: 'Account not found.' });
    if (!uhad.otp_code || uhad.otp_code !== otp) return res.status(400).json({ error: 'Invalid OTP.' });
    if (new Date() > new Date(uhad.otp_expires_at)) return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });

    await supabase.from('uhads').update({ password: newPassword, otp_code: null, otp_expires_at: null }).eq('id', uhad.id);
    res.json({ success: true, message: 'Password reset successfully.' });
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

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AQUIQ Backend running on port ${PORT}`);
  // Run once on startup so prediction is available immediately
  runPredictiveMaintenance();
});
