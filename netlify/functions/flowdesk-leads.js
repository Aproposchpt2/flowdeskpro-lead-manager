// netlify/functions/flowdesk-leads.js
// FlowDesk Pro — Lead Manager
// Fetches flowdesk_intake_records from Supabase for the dashboard
// Called by: GET /.netlify/functions/flowdesk-leads?limit=150

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Supabase is not configured on this server." }),
    };
  }

  try {
    const qs = event.queryStringParameters || {};
    const limit = Math.min(parseInt(qs.limit || "150", 10), 500);
    const status = qs.status || null;
    const source = qs.source || null;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    let query = supabase
      .from("flowdesk_intake_records")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq("lead_status", status);
    }

    if (source) {
      query = query.ilike("source_page", `%${source}%`);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[flowdesk-leads] Supabase error:", error.message);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: error.message }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        count: data.length,
        records: data,
      }),
    };
  } catch (err) {
    console.error("[flowdesk-leads] fatal error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
