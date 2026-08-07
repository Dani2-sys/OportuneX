create table organisations (
  id text primary key,
  name text not null,
  created_at timestamptz default now()
);

create table users (
  id text primary key,
  email text unique not null,
  created_at timestamptz default now()
);

create table organisation_members (
  organisation_id text not null references organisations(id),
  user_id text not null references users(id),
  role text not null,
  primary key (organisation_id, user_id)
);

create table company_profiles (
  id text primary key,
  organisation_id text not null references organisations(id),
  legal_name text not null,
  trading_name text,
  cif text,
  preferred_language text,
  website text,
  municipality text,
  province text,
  autonomous_community text,
  preferred_working_radius_km integer,
  employee_band text,
  turnover_band text,
  company_age_years integer,
  sme_status text,
  legal_entity_type text,
  created_at timestamptz default now()
);

create table company_capabilities (
  id text primary key,
  company_profile_id text not null references company_profiles(id),
  capability_code text not null,
  label text not null,
  level text not null
);

create table company_certifications (
  id text primary key,
  company_profile_id text not null references company_profiles(id),
  certification_name text not null,
  status text not null,
  issuing_authority text,
  expiry_date date
);

create table company_preferences (
  company_profile_id text primary key references company_profiles(id),
  minimum_attractive_project_value numeric,
  ideal_project_value numeric,
  maximum_realistic_project_value numeric,
  desired_work_types text[],
  unwanted_work_types text[]
);

create table company_feedback (
  id text primary key,
  company_profile_id text not null references company_profiles(id),
  opportunity_id text not null,
  label text not null,
  comment text,
  created_at timestamptz default now()
);

create table opportunities (
  id text primary key,
  canonical_id text,
  source_opportunity_id text,
  source_notice_version_id text,
  opportunity_type text not null,
  notice_type text not null,
  status text not null,
  title text not null,
  description text,
  issuing_organisation text,
  contracting_authority text,
  publication_date date,
  modification_date date,
  deadline_date date,
  deadline_time text,
  deadline_timezone text,
  location_display text,
  municipality text,
  province text,
  autonomous_community text,
  procedure_type text,
  duration_text text,
  submission_mechanism text,
  official_application_url text,
  official_notice_url text,
  last_checked timestamptz,
  created_at timestamptz default now()
);

create table opportunity_lots (
  id text primary key,
  opportunity_id text not null references opportunities(id),
  title text not null,
  description text,
  cpv_codes text[]
);

create table opportunity_sources (
  id text primary key,
  opportunity_id text not null references opportunities(id),
  organisation text not null,
  title text not null,
  url text,
  official boolean default false,
  published_at date,
  last_checked timestamptz
);

create table opportunity_documents (
  id text primary key,
  opportunity_id text not null references opportunities(id),
  title text not null,
  document_url text,
  document_type text
);

create table opportunity_contacts (
  id text primary key,
  opportunity_id text not null references opportunities(id),
  role text not null,
  name text,
  email text,
  phone text
);

create table opportunity_requirements (
  id text primary key,
  opportunity_id text not null references opportunities(id),
  lot_id text references opportunity_lots(id),
  requirement_kind text not null,
  label text not null,
  mandatory boolean default true,
  gating text,
  raw_value text
);

create table opportunity_amounts (
  id text primary key,
  opportunity_id text not null references opportunities(id),
  lot_id text references opportunity_lots(id),
  amount_type text not null,
  amount_minor bigint not null,
  currency text not null,
  vat_status text
);

create table opportunity_deadlines (
  id text primary key,
  opportunity_id text not null references opportunities(id),
  source_text text,
  parsed_date date,
  parsed_time text,
  timezone text,
  utc_equivalent timestamptz
);

create table opportunity_evidence (
  id text primary key,
  opportunity_id text not null references opportunities(id),
  source_id text references opportunity_sources(id),
  field_key text not null,
  excerpt text,
  confidence numeric,
  page_ref text,
  source_path text
);

create table matches (
  id text primary key,
  opportunity_id text not null references opportunities(id),
  company_profile_id text not null references company_profiles(id),
  lot_id text references opportunity_lots(id),
  match_score integer not null,
  priority_score integer not null,
  recommendation_class text not null,
  eligibility_status text not null,
  confidence_label text not null,
  executive_verdict text
);

create table match_dimensions (
  match_id text primary key references matches(id),
  capability_fit integer,
  financial_scale_fit integer,
  geographic_fit integer,
  strategic_fit integer,
  qualification_readiness integer,
  deadline_feasibility integer,
  application_effort integer,
  evidence_quality integer
);

create table eligibility_checks (
  id text primary key,
  match_id text not null references matches(id),
  requirement_label text not null,
  status text not null,
  evidence_ids text[]
);

create table adaptive_questions (
  id text primary key,
  match_id text not null references matches(id),
  prompt text not null,
  answer text
);

create table saved_opportunities (
  company_profile_id text not null references company_profiles(id),
  opportunity_id text not null references opportunities(id),
  primary key (company_profile_id, opportunity_id)
);

create table pursuit_statuses (
  company_profile_id text not null references company_profiles(id),
  opportunity_id text not null references opportunities(id),
  status text not null,
  primary key (company_profile_id, opportunity_id)
);

create table source_sync_runs (
  id text primary key,
  source_name text not null,
  status text not null,
  started_at timestamptz,
  finished_at timestamptz,
  note text
);

create table source_errors (
  id text primary key,
  source_sync_run_id text not null references source_sync_runs(id),
  error_message text not null,
  created_at timestamptz default now()
);

create table ai_runs (
  id text primary key,
  opportunity_id text references opportunities(id),
  company_profile_id text references company_profiles(id),
  model text not null,
  prompt_version text,
  response_status text,
  created_at timestamptz default now()
);

create table ai_cost_usage (
  ai_run_id text primary key references ai_runs(id),
  input_tokens integer,
  output_tokens integer,
  estimated_cost numeric
);

create table audit_events (
  id text primary key,
  organisation_id text references organisations(id),
  title text not null,
  detail text,
  created_at timestamptz default now()
);
