// Single public surface for storage + auth. Screens import from './db' only,
// never from './db/local' or './db/supabase' directly — so the internals can
// change (e.g. when sync lands) without touching a single call site.
export * from './local';
export * from './supabase';
