// =====================================================================
// RMMIS Pilot — Supabase client configuration
// The publishable key is safe to expose in frontend code — Row Level
// Security on the database is what actually protects the data.
// =====================================================================
const SUPABASE_URL = "https://gannbbuujwzjukfbjptq.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dKpu8lvJzwxPuTzMEl-QTg_MRfWipvU";

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// Edge Function base (adjust the path segment if you redeploy under a different name)
const EDGE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
