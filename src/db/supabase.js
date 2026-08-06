// Supabase client + auth helpers.
//
// Phase 3 scope: IDENTITY ONLY. Signing in establishes who you are and
// persists a session — it does not move any data. Workouts still live in
// device-local IndexedDB (see local.js) until push sync (phase 4) and pull
// merge (phase 5) land.
//
// The publishable key below is public by design: it ships inside the client
// bundle and anyone can read it. Row Level Security is what actually protects
// the data. NEVER put the service_role / sb_secret_... key in this file — it
// bypasses RLS entirely.

import { createClient } from '@supabase/supabase-js';
import { logEvent } from './local';

const SUPABASE_URL = 'https://brpvgalhfifepnurymnc.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_2vm4RMhG54L2y4TOJWnu6g_Z4JV-RZb';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,      // localStorage — survives PWA restarts
    autoRefreshToken: true,    // keeps the session alive without re-login
    detectSessionInUrl: true,  // required: the OAuth redirect carries tokens in the URL
  },
});

// Exposed for diagnostics: lets you run a query from the browser console with
// the real anon key and the real session, exactly as the app does — the only
// honest way to check RLS from outside, since the SQL editor runs as superuser
// and bypasses it. Harmless: the key is public and the session is the user's
// own, and no third-party scripts run on this page.
if (typeof window !== 'undefined') window.__sb = supabase;

// Full-page redirect rather than a popup. An installed iOS PWA has no popup
// surface — a popup either fails silently or opens a detached Safari window
// the app never hears back from.
export async function signInGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) {
    logEvent('error', 'auth_signin_failed', error.message);
    throw error;
  }
  // No return value worth having: the browser navigates away to Google.
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) {
    logEvent('error', 'auth_signout_failed', error.message);
    throw error;
  }
  logEvent('info', 'auth_signed_out', 'local data kept on device');
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    logEvent('warn', 'auth_get_session_failed', error.message);
    return null;
  }
  return data.session || null;
}

// Subscribe to sign-in / sign-out / token-refresh. Returns an unsubscribe fn.
// Auth events are logged because the iOS PWA redirect return path is a known
// weak spot — if a sign-in silently fails on-device, the diagnostics log is
// the only place that will say so.
export function onAuthChange(cb) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN')  logEvent('info', 'auth_signed_in', session?.user?.email || '?');
    if (event === 'SIGNED_OUT') logEvent('info', 'auth_signed_out_event', null);
    cb(session || null);
  });
  return () => data.subscription.unsubscribe();
}
