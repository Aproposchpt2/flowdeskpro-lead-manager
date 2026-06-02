-- FlowDesk Pro — Full CRM Schema
-- Migration 002
-- Applied: 2026-06-02

-- Note: 'leads' and 'clients' tables already exist for subscription management.
-- CRM pipeline leads use 'crm_leads' to avoid conflict.

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  client_id uuid,
  caller_id text,
  first_name text,
  last_name text,
  email text,
  phone_primary text,
  phone_secondary text,
  company_name text,
  contact_type text DEFAULT 'lead',
  lead_source text DEFAULT 'phone_call',
  lead_status text DEFAULT 'new',
  lead_score integer DEFAULT 0,
  priority text DEFAULT 'warm',
  assigned_to text,
  industry text,
  company_size text,
  budget_range text,
  decision_maker boolean DEFAULT false,
  decision_timeline text,
  preferred_contact text DEFAULT 'phone',
  best_time_to_call text,
  do_not_call boolean DEFAULT false,
  sms_consent boolean DEFAULT false,
  email_consent boolean DEFAULT false,
  timezone text,
  tags text[],
  custom_field_1 text,
  custom_field_2 text,
  custom_field_3 text,
  custom_field_4 text,
  custom_field_5 text,
  notes text
);

CREATE TABLE IF NOT EXISTS call_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  client_id uuid,
  contact_id uuid REFERENCES contacts(id),
  conversation_id text UNIQUE,
  caller_id text,
  caller_phone_normalized text,
  call_direction text DEFAULT 'inbound',
  call_status text DEFAULT 'completed',
  call_start_time timestamptz,
  call_end_time timestamptz,
  call_duration_seconds integer,
  call_duration_display text,
  time_to_answer_seconds integer,
  after_hours boolean DEFAULT false,
  agent_name text DEFAULT 'Alex',
  agent_id text,
  caller_first_name text,
  caller_last_name text,
  reason_for_call text,
  caller_message text,
  callback_number text,
  urgency_level text DEFAULT 'Normal',
  call_summary text,
  call_transcript text,
  sentiment_score text,
  lead_created boolean DEFAULT false,
  lead_id uuid,
  follow_up_required boolean DEFAULT false,
  follow_up_date date,
  recording_url text,
  recording_consent boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS crm_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  client_id uuid,
  contact_id uuid REFERENCES contacts(id),
  call_record_id uuid REFERENCES call_records(id),
  lead_title text,
  lead_description text,
  service_interest text,
  estimated_value numeric DEFAULT 0,
  probability integer DEFAULT 0,
  expected_close_date date,
  pipeline_stage text DEFAULT 'new_lead',
  stage_changed_at timestamptz DEFAULT now(),
  stage_changed_by text,
  days_in_stage integer DEFAULT 0,
  lost_reason text,
  assigned_to text,
  assigned_at timestamptz DEFAULT now(),
  last_contacted timestamptz,
  next_follow_up timestamptz,
  lead_source text DEFAULT 'phone_call',
  campaign_id text,
  referral_source text
);

CREATE TABLE IF NOT EXISTS activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  client_id uuid,
  contact_id uuid REFERENCES contacts(id),
  lead_id uuid REFERENCES crm_leads(id),
  call_record_id uuid REFERENCES call_records(id),
  activity_type text NOT NULL,
  activity_direction text,
  activity_subject text,
  activity_body text,
  activity_outcome text,
  performed_by text,
  duration_seconds integer
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  client_id uuid,
  contact_id uuid REFERENCES contacts(id),
  lead_id uuid REFERENCES crm_leads(id),
  call_record_id uuid REFERENCES call_records(id),
  task_title text NOT NULL,
  task_description text,
  task_type text,
  due_date timestamptz,
  priority text DEFAULT 'normal',
  assigned_to text,
  status text DEFAULT 'pending',
  completed_at timestamptz,
  completed_by text,
  notes text
);

CREATE TABLE IF NOT EXISTS staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  client_id uuid,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text,
  role text DEFAULT 'agent',
  presence_status text DEFAULT 'available',
  status_updated_at timestamptz DEFAULT now(),
  is_active boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS sms_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  client_id uuid,
  contact_id uuid REFERENCES contacts(id),
  call_record_id uuid REFERENCES call_records(id),
  direction text NOT NULL,
  from_number text,
  to_number text,
  message_body text,
  message_status text DEFAULT 'sent',
  twilio_message_sid text,
  opt_out boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_contacts_caller_id ON contacts(caller_id);
CREATE INDEX IF NOT EXISTS idx_contacts_lead_status ON contacts(lead_status);
CREATE INDEX IF NOT EXISTS idx_call_records_caller_id ON call_records(caller_id);
CREATE INDEX IF NOT EXISTS idx_call_records_created_at ON call_records(created_at);
CREATE INDEX IF NOT EXISTS idx_crm_leads_pipeline_stage ON crm_leads(pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
