// Public settings. The anon key is meant to be public: row-level security in
// the database decides what it can do. Never put the service-role key here.

const LOCAL = {
  url: 'http://127.0.0.1:54321',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
};

// Filled in during setup (see README).
const HOSTED = {
  url: 'https://YOUR-PROJECT-REF.supabase.co',
  anonKey: 'YOUR-ANON-KEY',
};

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const cfg = isLocal ? LOCAL : HOSTED;

export const SUPABASE_URL = cfg.url;
export const SUPABASE_ANON_KEY = cfg.anonKey;
export const CONFIGURED = !cfg.url.includes('YOUR-PROJECT-REF');

export const COLLEGE = 'HIMS';
export const PAYEE = { name: 'HIMS Fees (demo)', vpa: 'hims.fees@demo' };
