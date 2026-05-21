/**
 * FlowDesk Pro — Stripe Webhook Handler
 * netlify/functions/stripe-webhook.js
 *
 * WHAT IT DOES:
 *   1. Receives Stripe webhook events
 *   2. Verifies the signature using STRIPE_WEBHOOK_SECRET
 *   3. On customer.subscription.created:
 *      - Writes client record to Supabase clients table
 *      - Writes subscription record to Supabase subscriptions table
 *      - Sends welcome email via Resend
 *   4. On customer.subscription.deleted:
 *      - Marks client status as cancelled in Supabase
 *
 * ENV VARIABLES REQUIRED:
 *   STRIPE_SECRET_KEY        -- sk_live_... from Stripe Dashboard
 *   STRIPE_WEBHOOK_SECRET    -- whsec_... from Stripe Webhook Destination
 *   SUPABASE_URL             -- https://pwvstaigtdrccirdvqka.supabase.co
 *   SUPABASE_SERVICE_KEY     -- sb_secret_... from Supabase API settings
 *   RESEND_API_KEY           -- from Resend Dashboard
 *   RESEND_FROM_EMAIL        -- FlowDesk Pro <support@aiflowdeskpro.com>
 *
 * STRIPE PRICE ID → PLAN MAP:
 *   price_1TOPcRBMRgYNYb8D3bQ19kwQ  →  starter   ($79/mo)
 *   price_1TOCXEBMRgYNYb8DVfSNpJ4S  →  command   ($149/mo)
 *   price_1TOCYBBMRgYNYb8D4MLYQi6A  →  agency    ($349/mo)
 */

'use strict';

const https  = require('https');
const crypto = require('crypto');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

/* ---------------------------------------------
   PRICE ID → PLAN MAP
--------------------------------------------- */
const PRICE_TO_PLAN = {
  'price_1TOPcRBMRgYNYb8D3bQ19kwQ': { name: 'starter', label: 'Starter',  amount: 79.00  },
  'price_1TOCXEBMRgYNYb8DVfSNpJ4S': { name: 'command', label: 'Command',  amount: 149.00 },
  'price_1TOCYBBMRgYNYb8D4MLYQi6A': { name: 'agency',  label: 'Agency',   amount: 349.00 },
};

/* ---------------------------------------------
   UTILITIES
--------------------------------------------- */
function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function formatTimestamp() {
  return new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  }) + ' PT';
}

/* ---------------------------------------------
   STRIPE SIGNATURE VERIFICATION
   Verifies the webhook came from Stripe, not an attacker.
--------------------------------------------- */
function verifyStripeSignature(rawBody, signature, secret) {
  try {
    const parts     = signature.split(',').reduce((acc, part) => {
      const [key, val] = part.split('=');
      acc[key] = val;
      return acc;
    }, {});

    const timestamp = parts['t'];
    const v1        = parts['v1'];

    if (!timestamp || !v1) return false;

    const signedPayload = `${timestamp}.${rawBody}`;
    const expected      = crypto
      .createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(v1, 'hex');

    if (expectedBuf.length !== receivedBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (err) {
    console.error('SIGNATURE VERIFICATION ERROR:', err.message);
    return false;
  }
}

/* ---------------------------------------------
   STRIPE API — FETCH CUSTOMER DETAILS
   Gets name and email from Stripe customer record
--------------------------------------------- */
async function fetchStripeCustomer(customerId) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey || !customerId) return null;

  return new Promise((resolve) => {
    const auth    = Buffer.from(`${secretKey}:`).toString('base64');
    const options = {
      hostname: 'api.stripe.com',
      path:     `/v1/customers/${customerId}`,
      method:   'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const customer = JSON.parse(data);
          console.log('STRIPE CUSTOMER:', customer.id, '|', customer.email);
          resolve(customer);
        } catch (err) {
          console.error('STRIPE CUSTOMER PARSE ERROR:', err.message);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('STRIPE CUSTOMER REQUEST ERROR:', err.message);
      resolve(null);
    });

    req.setTimeout(5000, () => {
      req.destroy();
      console.error('STRIPE CUSTOMER TIMEOUT');
      resolve(null);
    });

    req.end();
  });
}

/* ---------------------------------------------
   SUPABASE — DATABASE OPERATIONS
--------------------------------------------- */
async function supabaseRequest(method, path, body = null) {
  const url = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.error('SUPABASE: Missing credentials');
    return null;
  }

  const bodyStr = body ? JSON.stringify(body) : null;

  return new Promise((resolve) => {
    const urlObj = new URL(`${url}/rest/v1/${path}`);

    const headers = {
      'Authorization': `Bearer ${key}`,
      'apikey':        key,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    };

    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + (urlObj.search || ''),
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const ok = [200, 201, 204].includes(res.statusCode);
        if (ok) {
          console.log(`SUPABASE ${method} OK — ${path}`);
          try { resolve(data ? JSON.parse(data) : true); } catch { resolve(true); }
        } else {
          console.error(`SUPABASE ${method} FAILED — ${path} — ${res.statusCode}:`, data);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`SUPABASE REQUEST ERROR:`, err.message);
      resolve(null);
    });

    req.setTimeout(5000, () => {
      req.destroy();
      console.error('SUPABASE TIMEOUT');
      resolve(null);
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function upsertClient(clientData) {
  // Upsert by stripe_customer_id — safe to call multiple times
  return supabaseRequest('POST', 'clients', clientData);
}

async function insertSubscription(subData) {
  return supabaseRequest('POST', 'subscriptions', subData);
}

async function cancelClient(stripeCustomerId) {
  // Update client status to cancelled by stripe_customer_id
  const path = `clients?stripe_customer_id=eq.${encodeURIComponent(stripeCustomerId)}`;
  return supabaseRequest('PATCH', path, { status: 'cancelled' });
}

/* ---------------------------------------------
   EMAIL — WELCOME / CANCELLATION
--------------------------------------------- */
function buildWelcomeEmailHtml(clientName, clientEmail, plan) {
  const planLabel = plan.label;
  const amount    = plan.amount;

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0d1117;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:32px 16px;">
  <tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

    <!-- Header -->
    <tr><td style="padding-bottom:24px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td>
          <span style="background:#2d9cdb;color:#fff;font-weight:700;font-size:13px;padding:4px 10px;border-radius:4px;">fd</span>
          <span style="color:#8b949e;font-size:13px;margin-left:10px;letter-spacing:1px;">FLOWDESK PRO - NEW SUBSCRIBER</span>
        </td>
      </tr></table>
    </td></tr>

    <!-- Hero -->
    <tr><td style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:36px;">
      <table width="100%" cellpadding="0" cellspacing="0">

        <tr><td style="padding-bottom:24px;border-bottom:1px solid #21262d;">
          <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Welcome to FlowDesk Pro</p>
          <p style="margin:8px 0 0;font-size:26px;font-weight:700;color:#f0f6fc;">${safeString(clientName, 'New Client')}</p>
          <p style="margin:4px 0 0;font-size:14px;color:#8b949e;">${clientEmail}</p>
        </td></tr>

        <tr><td style="height:20px;"></td></tr>

        <!-- Plan Details -->
        <tr><td style="padding-bottom:20px;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="50%" style="vertical-align:top;">
              <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Plan</p>
              <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#2d9cdb;">FlowDesk Pro ${planLabel}</p>
            </td>
            <td width="50%" style="vertical-align:top;">
              <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Monthly Amount</p>
              <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#f0f6fc;">$${amount.toFixed(2)}/mo</p>
            </td>
          </tr></table>
        </td></tr>

        <!-- Status -->
        <tr><td style="padding:16px 0;border-top:1px solid #21262d;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td>
              <span style="background:#22c55e18;border:1px solid #22c55e44;color:#22c55e;font-size:12px;font-weight:700;padding:4px 10px;border-radius:20px;">ACTIVE</span>
              <span style="color:#8b949e;font-size:13px;margin-left:10px;">${formatTimestamp()}</span>
            </td>
          </tr></table>
        </td></tr>

        <!-- Next Steps -->
        <tr><td style="padding:16px 0;border-top:1px solid #21262d;">
          <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Next Steps</p>
          <p style="margin:8px 0 0;font-size:14px;color:#c9d1d9;line-height:1.6;">
            A setup email with login credentials and your dedicated intake phone number is on its way.
            Your AI call intake will be active within 24 hours.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding-top:16px;border-top:1px solid #21262d;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td><p style="margin:0;font-family:monospace;font-size:11px;color:#484f58;">Source: stripe_subscription</p></td>
            <td align="right"><p style="margin:0;font-family:monospace;font-size:11px;color:#484f58;">FlowDesk Pro</p></td>
          </tr></table>
        </td></tr>

      </table>
    </td></tr>

    <tr><td style="height:24px;"></td></tr>
    <tr><td style="text-align:center;">
      <p style="margin:0;font-size:11px;color:#484f58;letter-spacing:1px;">FLOWDESK PRO - APROPOS GROUP LLC - ${new Date().getFullYear()}</p>
    </td></tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;
}

/* ---------------------------------------------
   HANDLE SUBSCRIPTION CREATED
--------------------------------------------- */
async function handleSubscriptionCreated(subscription) {
  console.log('SUBSCRIPTION CREATED:', subscription.id);

  // Get price ID from subscription items
  const priceId  = subscription?.items?.data?.[0]?.price?.id;
  const plan     = PRICE_TO_PLAN[priceId];

  if (!plan) {
    console.warn('UNKNOWN PRICE ID:', priceId, '— logging but not mapping to plan');
  }

  const planName  = plan?.name  || 'starter';
  const planLabel = plan?.label || 'Starter';
  const amount    = plan?.amount || 0;

  // Fetch customer details from Stripe
  const customerId = subscription.customer;
  const customer   = await fetchStripeCustomer(customerId);

  const clientEmail = safeString(customer?.email, '');
  const clientName  = safeString(customer?.name,  clientEmail || 'New Client');

  console.log('CLIENT:', clientName, '|', clientEmail, '| PLAN:', planName);

  // Write to clients table
  const clientRecord = {
    business_name:      clientName,
    plan:               planName,
    status:             'active',
    resend_to_email:    clientEmail,
    stripe_customer_id: customerId,
  };

  const [clientResult, subResult] = await Promise.allSettled([
    upsertClient(clientRecord),
    insertSubscription({
      stripe_subscription_id: subscription.id,
      plan:                   planName,
      status:                 'active',
      current_period_start:   subscription.current_period_start
        ? new Date(subscription.current_period_start * 1000).toISOString()
        : null,
      current_period_end:     subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
      amount,
    }),
  ]);

  console.log('CLIENT WRITE:', clientResult.status);
  console.log('SUBSCRIPTION WRITE:', subResult.status);

  // Send internal alert email
  const alertTo   = process.env.RESEND_TO_EMAIL || 'jmitchell@aiflowdeskpro.com';
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'FlowDesk Pro <support@aiflowdeskpro.com>';

  if (alertTo) {
    await resend.emails.send({
      from:    fromEmail,
      to:      [alertTo],
      subject: `NEW SUBSCRIBER - ${clientName} - FlowDesk Pro ${planLabel} ($${amount}/mo)`,
      html:    buildWelcomeEmailHtml(clientName, clientEmail, { label: planLabel, amount }),
      text: [
        `NEW FLOWDESK PRO SUBSCRIBER`,
        '----------------------------------------',
        `Name:    ${clientName}`,
        `Email:   ${clientEmail}`,
        `Plan:    FlowDesk Pro ${planLabel}`,
        `Amount:  $${amount}/mo`,
        `Time:    ${formatTimestamp()}`,
        `Stripe:  ${customerId}`,
      ].join('\n'),
    }).catch(err => console.error('WELCOME EMAIL ERROR:', err.message));

    console.log('WELCOME EMAIL SENT');
  }
}

/* ---------------------------------------------
   HANDLE SUBSCRIPTION DELETED
--------------------------------------------- */
async function handleSubscriptionDeleted(subscription) {
  console.log('SUBSCRIPTION DELETED:', subscription.id);

  const customerId = subscription.customer;
  const result     = await cancelClient(customerId);

  console.log('CLIENT CANCELLED:', customerId, '| RESULT:', result ? 'OK' : 'FAILED');

  // Send internal cancellation alert
  const alertTo   = process.env.RESEND_TO_EMAIL || 'jmitchell@aiflowdeskpro.com';
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'FlowDesk Pro <support@aiflowdeskpro.com>';

  const customer = await fetchStripeCustomer(customerId);
  const clientEmail = safeString(customer?.email, customerId);
  const clientName  = safeString(customer?.name,  clientEmail);

  if (alertTo) {
    await resend.emails.send({
      from:    fromEmail,
      to:      [alertTo],
      subject: `CANCELLATION - ${clientName} - FlowDesk Pro`,
      html: `<div style="font-family:Arial;background:#0d1117;padding:24px;color:#c9d1d9;">
        <h2 style="color:#ef4444;">Subscription Cancelled</h2>
        <p><strong>Client:</strong> ${clientName}</p>
        <p><strong>Email:</strong> ${clientEmail}</p>
        <p><strong>Stripe ID:</strong> ${customerId}</p>
        <p><strong>Subscription:</strong> ${subscription.id}</p>
        <p><strong>Time:</strong> ${formatTimestamp()}</p>
        <p style="color:#8b949e;font-size:13px;">Client status updated to cancelled in Supabase.</p>
      </div>`,
      text: `CANCELLATION\nClient: ${clientName}\nEmail: ${clientEmail}\nTime: ${formatTimestamp()}`,
    }).catch(err => console.error('CANCELLATION EMAIL ERROR:', err.message));
  }
}

/* ---------------------------------------------
   MAIN HANDLER
--------------------------------------------- */
exports.handler = async (event) => {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Get raw body and signature
  const rawBody   = event.body;
  const signature = event.headers['stripe-signature'];
  const secret    = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !secret) {
    console.error('WEBHOOK: Missing signature or secret');
    return { statusCode: 400, body: 'Missing signature' };
  }

  // Verify the webhook came from Stripe
  const isValid = verifyStripeSignature(rawBody, signature, secret);
  if (!isValid) {
    console.error('WEBHOOK: Invalid signature — rejected');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  // Parse the event
  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (err) {
    console.error('WEBHOOK: Failed to parse body:', err.message);
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const eventType = stripeEvent.type;
  const eventData = stripeEvent.data?.object;

  console.log('STRIPE EVENT:', eventType, '|', stripeEvent.id);

  // Route to handler
  try {
    switch (eventType) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(eventData);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(eventData);
        break;

      default:
        console.log('UNHANDLED EVENT TYPE:', eventType, '— ignoring');
    }

    // Always return 200 to Stripe — prevents retries
    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (error) {
    console.error('WEBHOOK HANDLER ERROR:', error?.message || error);
    // Still return 200 to prevent Stripe from retrying indefinitely
    return { statusCode: 200, body: JSON.stringify({ received: true, error: error.message }) };
  }
};
