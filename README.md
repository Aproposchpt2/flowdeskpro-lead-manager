# FlowDesk Pro Lead Manager V1 — Platinum Command Center

Client / Case Use #001: Apropos Group LLC / AI4 Businesses  
Product: AI4 Businesses Lead Manager — Powered by FlowDesk Pro

## Package contents

```text
/
├── index.html
├── intake.html
├── dashboard.html
├── thankyou.html
├── netlify.toml
├── package.json
└── netlify/
    └── functions/
        ├── config.js
        ├── submit-lead.js
        ├── get-leads.js
        ├── update-lead.js
        ├── email-lead.js
        ├── lead-manager.js
        └── lead-manager-status.js
```

## What this package does

- Captures public lead submissions through `/intake`
- Writes records to Supabase table `lead_manager_records`
- Loads records into `/dashboard`
- Supports search, source, urgency, status, and follow-up filters
- Supports internal notes, next actions, follow-up flags, status updates, callback tasks, and customer status messages
- Sends internal lead alerts and customer confirmations through Resend when configured
- Includes updated Twilio voice intake functions that write to `lead_manager_records`
- Uses Netlify Functions only from browser pages
- Keeps Supabase, Resend, Twilio, and OpenAI secrets out of frontend code

## Required Netlify environment variables

Already configured per execution command:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_SERVICE_KEY=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
RESEND_TO_EMAIL=
LEAD_MANAGER_TABLE=lead_manager_records
LEAD_MANAGER_SITE_URL=
CLIENT_NAME=
CLIENT_BRAND_NAME=
CLIENT_NOTIFICATION_EMAIL=
CLIENT_TENANT_ID=
SMS_ENABLED=
VOICE_ENABLED=
APPOINTMENTS_ENABLED=
BILLING_ENABLED=
AI_SUMMARY_ENABLED=
TWILIO_ACCOUNT_SID=
TWILIO_ALERT_PHONE=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
OPENAI_API_KEY=
```

All functions use this service-key fallback:

```js
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;
```

The actual shared config uses the same pattern without exposing the key.

## Deployment steps

1. Upload the package files to the Netlify-connected GitHub repository root.
2. Confirm Netlify uses:
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
3. Deploy.
4. Test:
   - `/` loads access page
   - `/intake` submits a lead
   - `/thankyou` confirms submission
   - `/dashboard` loads the submitted lead
5. For Twilio voice intake, point the Twilio phone webhook to:
   - `https://YOUR_SITE_DOMAIN/.netlify/functions/lead-manager`
   - Method: `POST`

## Important

This is a standalone Lead Manager package, not a patch to the older demo. The old `flowdesk-*` frontend function paths and old `flowdesk_intake_records` table references have been replaced with V1 paths and the `lead_manager_records` table.
