// Sync engine — push (phase 4) + pull with last-write-wins merge (phase 5).
//
// Failure is never fatal and never blocks the UI. A failed push leaves rows
// dirty and the next trigger retries; a failed pull just leaves lastPulledAt
// where it was. Offline is the normal case, not an error — you log workouts
// in a gym basement.

import { supabase, getSession } from './supabase';
import {
  db, getDirtyWorkouts, afterPush, markAllDirty, getOfflineDeletes,
  getMeta, setMeta, getOwner, setOwner, logEvent,
} from './local';

const MIGRATION_KEY   = 'firstPushMigrationDone';
const LAST_PUSHED_KEY = 'lastPushedAt';
const LAST_PULLED_KEY = 'lastPulledAt';
const EPOCH           = '1970-01-01T00:00:00.000Z';

// Triggers overlap constantly — a save fires one while app-open is still
// running. Coalesce into a single in-flight promise so two runs can't race
// and double-clear dirty flags.
let inFlight = null;

export function syncNow(reason = 'manual') {
  if (inFlight) return inFlight;
  inFlight = doSync(reason).finally(() => { inFlight = null; });
  return inFlight;
}

async function doSync(reason) {
  const session = await getSession();
  if (!session) return { ok: false, skipped: 'signed_out' };
  const userId = session.user.id;

  // Local rows carry no owner of their own, and a push stamps whoever is
  // signed in. Without this gate, signing in on a device holding someone
  // else's workouts would upload them under the new account — RLS would
  // faithfully store the wrong attribution, because the client asked it to.
  const owner = await getOwner();
  if (owner && owner !== userId) {
    logEvent('warn', 'sync_blocked_wrong_account', `device belongs to ${owner.slice(0, 8)}…, signed in as ${userId.slice(0, 8)}…`);
    return { ok: false, blocked: 'wrong_account' };
  }
  if (!owner) await setOwner(userId);

  // Deletions made while signed out are held until the user decides. Blocking
  // the whole sync rather than pushing the additions and holding the deletes
  // keeps it comprehensible: one question, one resolution, then everything
  // moves together.
  const offlineDeletes = await getOfflineDeletes();
  if (offlineDeletes.length) {
    logEvent('warn', 'sync_needs_delete_confirm', `${offlineDeletes.length} deleted while signed out`);
    return { ok: false, needsDeleteConfirm: offlineDeletes.length };
  }

  try {
    const pushed = await pushLocal(userId);
    const pulled = await pullRemote();
    logEvent('info', 'sync_ok', `${reason}: pushed ${pushed.workouts}, pulled ${pulled.applied} of ${pulled.seen}`);
    return { ok: true, ...pushed, ...pulled };
  } catch (e) {
    logEvent('error', 'sync_failed', `${reason}: ${e.message || e}`);
    return { ok: false, error: e.message || String(e) };
  }
}

/* ── Push: local → cloud ─────────────────────────────────────────────────── */
async function pushLocal(userId) {
  // Everything logged before sync existed carries no dirty flag, so the index
  // cannot see it. Mark it once, on the first sync after signing in.
  if (!(await getMeta(MIGRATION_KEY))) {
    const n = await markAllDirty();
    await setMeta(MIGRATION_KEY, true);
    logEvent('info', 'sync_migration', `marked ${n} existing workouts for first upload`);
  }

  const dirty = await getDirtyWorkouts();
  if (dirty.length) {
    // `deleted` is 1/0 locally (IndexedDB cannot index booleans) but the
    // Postgres column is a real boolean — convert at the boundary.
    const rows = dirty.map((w) => ({
      id:         w.id,
      user_id:    userId,
      date:       w.date,
      updated_at: w.updatedAt || new Date().toISOString(),
      deleted:    !!w.deleted,
      data:       w,
    }));
    // Keyed on (user_id, id), not id alone. A globally-unique id means two
    // accounts can never hold the same workout id — so a device that pushed
    // under one account and later signs in as another collides on a row it
    // cannot see, Postgres takes the ON CONFLICT DO UPDATE path, and the
    // UPDATE policy's USING correctly refuses. One collision fails the whole
    // batch and sync stops dead with a 403. abbrevs and modalities were
    // already keyed this way; workouts was the odd one out.
    const { error } = await supabase.from('workouts').upsert(rows, { onConflict: 'user_id,id' });
    if (error) throw error;
    await afterPush(dirty.map((w) => ({ id: w.id, deleted: !!w.deleted })));
  }

  // Learned caches are a few hundred rows at most — pushing the whole table is
  // cheaper than tracking per-row deltas.
  const [abbrevs, modalities] = await Promise.all([db.abbrevs.toArray(), db.modalities.toArray()]);
  const stamp = new Date().toISOString();
  if (abbrevs.length) {
    const { error } = await supabase.from('abbrevs').upsert(
      abbrevs.map((a) => ({ user_id: userId, key: a.key, name: a.name, updated_at: stamp })),
      { onConflict: 'user_id,key' });
    if (error) throw error;
  }
  if (modalities.length) {
    const { error } = await supabase.from('modalities').upsert(
      modalities.map((m) => ({ user_id: userId, key: m.key, modality: m.modality, updated_at: stamp })),
      { onConflict: 'user_id,key' });
    if (error) throw error;
  }

  await setMeta(LAST_PUSHED_KEY, stamp);
  return { workouts: dirty.length };
}

/* ── Pull: cloud → local, last-write-wins ────────────────────────────────── */
async function pullRemote() {
  const since = await getMeta(LAST_PULLED_KEY, EPOCH);

  // No user_id filter needed — RLS scopes this to the caller. If this ever
  // returns another account's rows, the policies are wrong, not this query.
  const { data, error } = await supabase
    .from('workouts')
    .select('id,updated_at,deleted,data')
    .gt('updated_at', since)
    .order('updated_at', { ascending: true });
  if (error) throw error;

  let applied = 0, kept = 0, maxSeen = since;
  for (const row of data || []) {
    if (row.updated_at > maxSeen) maxSeen = row.updated_at;
    const local = await db.workouts.get(row.id);

    // A local edit that hasn't shipped yet is newer by construction, so it
    // wins until pushed — otherwise a pull would silently revert work the
    // user just did on this device.
    if (local && local.dirty) { kept++; continue; }

    if (row.deleted) {
      if (local) { await db.workouts.delete(row.id); applied++; }
      continue;
    }

    const localTime = local ? new Date(local.updatedAt || 0).getTime() : -1;
    if (new Date(row.updated_at).getTime() > localTime) {
      // row.data is the whole local record as it was pushed; reset the sync
      // flags rather than trusting whatever they were at upload time.
      await db.workouts.put({ ...row.data, dirty: 0, deleted: 0 });
      applied++;
    } else kept++;
  }

  await pullLearnedCaches();

  // Server clock, deliberately — the max updated_at actually seen, never
  // Date.now(). A device whose clock runs fast would otherwise set the
  // watermark into the future and skip rows written in between.
  await setMeta(LAST_PULLED_KEY, maxSeen);
  return { applied, kept, seen: (data || []).length };
}

// Learned names and modalities are additive caches. Only fill gaps: a key that
// already exists locally is left alone and will be pushed on the next sync, so
// the two sides converge without either clobbering the other.
async function pullLearnedCaches() {
  const [ra, rm] = await Promise.all([
    supabase.from('abbrevs').select('key,name'),
    supabase.from('modalities').select('key,modality'),
  ]);
  if (ra.error) throw ra.error;
  if (rm.error) throw rm.error;

  const [la, lm] = await Promise.all([db.abbrevs.toArray(), db.modalities.toArray()]);
  const haveA = new Set(la.map((x) => x.key));
  const haveM = new Set(lm.map((x) => x.key));

  const newA = (ra.data || []).filter((r) => !haveA.has(r.key)).map((r) => ({ key: r.key, name: r.name }));
  const newM = (rm.data || []).filter((r) => !haveM.has(r.key)).map((r) => ({ key: r.key, modality: r.modality }));
  if (newA.length) await db.abbrevs.bulkPut(newA);
  if (newM.length) await db.modalities.bulkPut(newM);
}

export async function getSyncState() {
  const [session, lastPushedAt, lastPulledAt, dirty, owner, offlineDeletes] = await Promise.all([
    getSession(), getMeta(LAST_PUSHED_KEY), getMeta(LAST_PULLED_KEY),
    getDirtyWorkouts(), getOwner(), getOfflineDeletes(),
  ]);
  const userId = session?.user?.id || null;
  return {
    signedIn: !!session,
    lastPushedAt,
    lastPulledAt,
    pending: dirty.length,
    wrongAccount: !!(owner && userId && owner !== userId),
    offlineDeletes: offlineDeletes.length,
  };
}
