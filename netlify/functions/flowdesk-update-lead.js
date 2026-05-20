// netlify/functions/flowdesk-update-lead.js
// FlowDesk Pro — Lead Manager
// Called by the dashboard to update a lead record in flowdesk_intake_records

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const VALID_STATUSES = [
  "New / Needs Review",
  "New / Priority Review",
  "In Progress",
  "Closed / Resolved",
];

const VALID_URGENCIES = ["Low", "Normal", "Time-sensitive", "Urgent"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const { id, intake_id, ...updates } = payload;

    if (!id && !intake_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Record id or intake_id is required." }),
      };
    }

    // Validate status if provided
    if (updates.lead_status && !VALID_STATUSES.includes(updates.lead_status)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Invalid lead_status: ${updates.lead_status}` }),
      };
    }

    // Validate urgency if provided
    if (updates.urgency && !VALID_URGENCIES.includes(updates.urgency)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Invalid urgency: ${updates.urgency}` }),
      };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Always update updated_at
    updates.updated_at = new Date().toISOString();

    // If status is Closed, set closed_at
    if (updates.lead_status === "Closed / Resolved") {
      updates.closed_at = new Date().toISOString();
    }

    // Build query — prefer id, fall back to intake_id
    let query = supabase
      .from("flowdesk_intake_records")
      .update(updates)
      .select()
      .single();

    if (id) {
      query = supabase
        .from("flowdesk_intake_records")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
    } else {
      query = supabase
        .from("flowdesk_intake_records")
        .update(updates)
        .eq("intake_id", intake_id)
        .select()
        .single();
    }

    const { data, error } = await query;

    if (error) {
      console.error("[flowdesk-update-lead] Supabase error:", error.message);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, record: data }),
    };
  } catch (err) {
    console.error("[flowdesk-update-lead] fatal error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
