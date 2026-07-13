/**
 * sync.js - Cloud synchronization and state management
 * Handles MantleDB sync, localStorage persistence, and per-field timestamps
 */

const MANTLE_BASE_URL = 'https://mantledb.sh/v2';
const MANTLE_PATH = 'state';

const STATE_KEY = 'd2asw';
const LEGACY_STATE_KEY = 'dimConfigState';

// Global state shared across all modules
let state = {
    tier5: true,
    keep: true,
    sortCol: 'Set',
    sortAsc: true,
    prefs: {},
    mantledb: null,
    lastUpdated: 0,     // max edit timestamp across all fields (0 = never edited)
    settingsUpdated: 0, // edit timestamp for tier5/keep/sort settings
    prefsUpdated: {}    // per-armor-set edit timestamps, keyed like prefs
};

let syncRunning = false;
let syncPending = false;
let syncRetryTimer = null;
let claimingNamespace = false;

// Thrown when the server rejects the key (401/403) — a permanent failure requiring a new namespace
class MantleAuthError extends Error { }

/**
 * Read state from localStorage with backwards compatibility
 * Checks new key first, falls back to legacy key
 */
const getStateFromStorage = () => {
    let saved = localStorage.getItem(STATE_KEY);
    if (!saved) {
        saved = localStorage.getItem(LEGACY_STATE_KEY);
    }
    return saved;
};

/**
 * Generate a random MantleDB namespace key
 * @returns {string} A unique namespace string
 */
const generateStorageKey = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'd2asw-';
    for (let i = 0; i < 24; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
};

/**
 * Claim a MantleDB namespace and return the secret key
 * @param {string} ns - Namespace to claim
 * @returns {Promise<string>} The secret key
 */
const claimMantleNamespace = async (ns) => {
    const res = await fetch(`${MANTLE_BASE_URL}/claim/${ns}`);
    if (!res.ok) throw new Error(`Failed to claim namespace: ${res.status}`);
    const data = await res.json();
    return data.key;
};

/**
 * Initialize MantleDB: generate and claim a namespace if not already done
 */
const initMantledb = async () => {
    if (state.mantledb || claimingNamespace) return;
    claimingNamespace = true;
    const ns = generateStorageKey();
    try {
        const key = await claimMantleNamespace(ns);
        state.mantledb = { ns, key };
        persistState();
        requestSync();
    } catch (e) {
        showSyncStatus('Sync unavailable — changes saved locally only', true);
    } finally {
        claimingNamespace = false;
    }
};

/**
 * Pull state from MantleDB
 * Returns null if no entry exists yet (404) — not an error, just an empty namespace.
 * Throws MantleAuthError on 401/403 (bad key). Throws Error on other failures.
 * @param {string} ns - Namespace
 * @param {string} key - Secret key
 * @returns {Promise<object|null>}
 */
const pullFromMantledb = async (ns, key) => {
    const res = await fetch(`${MANTLE_BASE_URL}/${ns}/${MANTLE_PATH}`, {
        headers: { 'X-Mantle-Key': key }
    });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new MantleAuthError('Invalid sync key');
    if (!res.ok) throw new Error(`Sync error (${res.status})`);
    return await res.json();
};

/**
 * PATCH (RFC 7396 JSON Merge Patch) a partial payload into MantleDB.
 * Only the top-level fields present in `payload` are touched — anything
 * else already stored remotely (written by another tab/device) is left
 * alone. This is what makes concurrent pushes from different tabs safe
 * to interleave in any order, as long as they touch different fields.
 * Throws MantleAuthError on 401/403, Error on other failures.
 * @param {string} ns - Namespace
 * @param {string} key - Secret key
 * @param {object} payload - Partial state to merge in
 */
const patchToMantledb = async (ns, key, payload) => {
    const res = await fetch(`${MANTLE_BASE_URL}/${ns}/${MANTLE_PATH}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'X-Mantle-Key': key
        },
        body: JSON.stringify(payload)
    });
    if (res.status === 401 || res.status === 403) throw new MantleAuthError('Invalid sync key');
    if (!res.ok) throw new Error(`Sync error (${res.status})`);
};

/**
 * Field-level merge of local and remote state using per-field edit timestamps.
 * For each field, the side with the newer timestamp wins; local wins ties.
 * This makes it impossible for a stale device to clobber newer edits made
 * elsewhere: only fields it actually edited more recently are taken from it.
 * @param {object} localState - Current local state (mutated in place)
 * @param {object} remoteState - State pulled from remote
 * @returns {boolean} true if any local field was changed by the merge
 */
const mergeRemoteIntoLocal = (localState, remoteState) => {
    let changed = false;

    // Legacy remote blobs (pre per-field timestamps): treat the whole-state
    // lastUpdated as the timestamp for every field.
    const remoteSettingsTime = remoteState.settingsUpdated ?? remoteState.lastUpdated ?? 0;
    const remotePrefsTimes = remoteState.prefsUpdated || {};
    const remoteLegacyTime = remoteState.lastUpdated ?? 0;

    localState.prefsUpdated = localState.prefsUpdated || {};

    // Settings (tier5 / keep / sort)
    if (remoteSettingsTime > (localState.settingsUpdated || 0)) {
        for (const f of ['tier5', 'keep', 'sortCol', 'sortAsc']) {
            if (remoteState[f] !== undefined && localState[f] !== remoteState[f]) {
                localState[f] = remoteState[f];
                changed = true;
            }
        }
        localState.settingsUpdated = remoteSettingsTime;
    }

    // Per-armor-set prefs
    const remotePrefs = remoteState.prefs || {};
    const allKeys = new Set([...Object.keys(localState.prefs || {}), ...Object.keys(remotePrefs)]);
    for (const k of allKeys) {
        const remoteTime = remotePrefsTimes[k] ?? (remotePrefs[k] !== undefined ? remoteLegacyTime : 0);
        const localTime = localState.prefsUpdated[k] || 0;
        if (remoteTime > localTime && remotePrefs[k] !== undefined) {
            if (JSON.stringify(localState.prefs[k]) !== JSON.stringify(remotePrefs[k])) {
                localState.prefs[k] = remotePrefs[k];
                changed = true;
            }
            localState.prefsUpdated[k] = remoteTime;
        }
    }

    localState.lastUpdated = Math.max(
        localState.settingsUpdated || 0,
        ...Object.values(localState.prefsUpdated),
        localState.lastUpdated || 0
    );

    return changed;
};

/**
 * Compute the minimal set of fields to push: only ones where localState's
 * edit timestamp is strictly newer than what we last saw in `baseline`
 * (a remote snapshot). Returns null if there's nothing to push.
 *
 * This payload is sent via PATCH, not POST, so pushing it can only ever
 * add this device's genuinely-newer fields on top of whatever is on the
 * server — it never touches fields this device didn't just edit, which is
 * what makes concurrent pushes from other tabs/devices safe to interleave.
 *
 * Caveat: each prefs[key] value is sent as a whole object, not sub-diffed.
 * If a single armor-set's saved pref object can shrink (a sub-field gets
 * removed), explicitly set that removed sub-field to null before calling
 * markPrefEdited/saveState — RFC 7396 merge patch merges nested objects
 * recursively, so an omitted sub-field is left untouched on the remote
 * copy rather than removed.
 *
 * @param {object} localState
 * @param {object|null} baseline - last remote snapshot seen (or null)
 * @returns {object|null}
 */
const buildPushDelta = (localState, baseline) => {
    const payload = {};
    let hasAnything = false;

    const baseSettingsTime = baseline?.settingsUpdated ?? baseline?.lastUpdated ?? 0;
    if ((localState.settingsUpdated || 0) > baseSettingsTime) {
        payload.tier5 = localState.tier5;
        payload.keep = localState.keep;
        payload.sortCol = localState.sortCol;
        payload.sortAsc = localState.sortAsc;
        payload.settingsUpdated = localState.settingsUpdated;
        hasAnything = true;
    }

    const basePrefsTimes = baseline?.prefsUpdated || {};
    const basePrefs = baseline?.prefs || {};
    const baseLegacyTime = baseline?.lastUpdated ?? 0;
    const prefsDelta = {};
    const prefsUpdatedDelta = {};
    for (const k in localState.prefsUpdated) {
        const baseTime = basePrefsTimes[k] ?? (basePrefs[k] !== undefined ? baseLegacyTime : 0);
        if (localState.prefsUpdated[k] > baseTime) {
            prefsDelta[k] = localState.prefs[k];
            prefsUpdatedDelta[k] = localState.prefsUpdated[k];
            hasAnything = true;
        }
    }
    if (Object.keys(prefsDelta).length) {
        payload.prefs = prefsDelta;
        payload.prefsUpdated = prefsUpdatedDelta;
    }

    if (!hasAnything) return null;
    payload.lastUpdated = localState.lastUpdated;
    return payload;
};

/**
 * Request a sync cycle. Safe to call at any frequency: cycles are
 * serialized and coalesced.
 */
const requestSync = () => {
    if (syncRetryTimer) {
        clearTimeout(syncRetryTimer);
        syncRetryTimer = null;
    }
    if (syncRunning) {
        syncPending = true;
        return;
    }
    runSyncCycle();
};

/**
 * Schedule a sync retry after a transient failure
 */
const scheduleSyncRetry = () => {
    if (syncRetryTimer) return;
    syncRetryTimer = setTimeout(() => {
        syncRetryTimer = null;
        requestSync();
    }, 15000);
};

/**
 * One pull→merge→push cycle.
 *
 * Always pulls and merges first, so a push can only ever add this device's
 * genuinely-newer fields on top of the latest remote data. The push itself
 * is a PATCH of only those newer fields (see buildPushDelta) — never a
 * full-state overwrite — so a concurrent tab/device editing something else
 * entirely can never be clobbered.
 *
 * If there's anything to push, remote is re-pulled and re-merged one more
 * time immediately beforehand, narrowing the window in which another
 * device could have written the exact same field between our first pull
 * and our write down to the gap between that check and the PATCH call
 * itself. MantleDB has no compare-and-swap primitive, so this is the
 * tightest a client-only guard can get; if two devices still land a write
 * on the exact same field in that narrow gap, whichever the server
 * processes last "wins" at the storage layer, but the loser's local
 * timestamp is still newer than what landed, so the very next sync cycle
 * will detect that and push again, correctly converging on the
 * higher-timestamped value.
 */
const runSyncCycle = async () => {
    if (!state.mantledb) return;
    syncRunning = true;
    const { ns, key } = state.mantledb;
    try {
        const remoteState = await pullFromMantledb(ns, key);
        // Namespace changed while pulling (e.g. import) — discard, rerun below if pending
        if (state.mantledb?.ns !== ns) return;

        let localChanged = false;
        if (remoteState !== null) {
            localChanged = mergeRemoteIntoLocal(state, remoteState);
        }

        let delta = buildPushDelta(state, remoteState);
        if (delta) {
            // One more pull immediately before writing, to catch anything
            // another tab/device pushed in between.
            const freshRemote = await pullFromMantledb(ns, key);
            if (state.mantledb?.ns !== ns) return;

            if (freshRemote !== null && mergeRemoteIntoLocal(state, freshRemote)) {
                localChanged = true;
            }
            // Recompute against the fresher baseline — fields the fresh pull
            // just absorbed into local no longer show up as "newer".
            delta = buildPushDelta(state, freshRemote);

            if (delta) {
                await patchToMantledb(ns, key, delta);
                if (state.mantledb?.ns !== ns) return;
            }
        }

        if (localChanged) {
            persistState();
            applyLoadedState();
            showSyncStatus('Settings synced');
        } else {
            persistState();
        }
        updateSyncedStatus();
    } catch (e) {
        if (state.mantledb?.ns !== ns) return;
        if (e instanceof MantleAuthError) {
            // Stored key is invalid — drop it and reconnect with a fresh namespace
            state.mantledb = null;
            persistState();
            showSyncStatus('Sync reconnecting…');
            await initMantledb();
        } else {
            showSyncStatus('Sync failed — will retry', true);
            scheduleSyncRetry();
        }
    } finally {
        syncRunning = false;
        if (syncPending) {
            syncPending = false;
            requestSync();
        }
    }
};

/**
 * Load application state from localStorage
 */
const loadState = () => {
    try {
        const saved = getStateFromStorage();
        if (saved) {
            const parsed = JSON.parse(saved);
            state.tier5 = parsed.tier5 !== undefined ? parsed.tier5 : true;
            state.keep = parsed.keep !== undefined ? parsed.keep : true;
            state.prefs = parsed.prefs || {};
            state.sortCol = parsed.sortCol || 'Set';
            state.sortAsc = parsed.sortAsc !== undefined ? parsed.sortAsc : true;
            state.mantledb = parsed.mantledb || null;
            state.lastUpdated = parsed.lastUpdated || 0;
            state.settingsUpdated = parsed.settingsUpdated || 0;
            state.prefsUpdated = parsed.prefsUpdated || {};
            // Legacy state (pre per-field timestamps): stamp every existing
            // pref with the old whole-state timestamp so merges behave sanely
            if (parsed.lastUpdated && !parsed.prefsUpdated) {
                state.settingsUpdated = parsed.lastUpdated;
                for (const k in state.prefs) {
                    state.prefsUpdated[k] = parsed.lastUpdated;
                }
            }
        }
    } catch (e) {
        console.error('Error loading state:', e);
    }
};

/**
 * Persist state to localStorage WITHOUT marking anything as edited.
 * Used for non-edit persistence (merges, config changes, page load).
 */
const persistState = () => {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
};

/**
 * Return a monotonic edit timestamp: never earlier than any timestamp this
 * state has already seen, so a device with a slow clock can still register
 * edits as newer than the data it just synced.
 * @returns {number}
 */
const nextEditTimestamp = () => {
    const now = Date.now();
    const ts = Math.max(now, (state.lastUpdated || 0) + 1);
    state.lastUpdated = ts;
    return ts;
};

/**
 * Mark a per-armor-set pref as edited now
 * @param {string} key - Armor set key
 */
const markPrefEdited = (key) => {
    state.prefsUpdated[key] = nextEditTimestamp();
};

/**
 * Mark the shared settings (tier5/keep/sort) as edited now
 */
const markSettingsEdited = () => {
    state.settingsUpdated = nextEditTimestamp();
};

/**
 * Persist state and kick off a sync cycle.
 * Callers must mark edited fields first via markPrefEdited/markSettingsEdited.
 */
const saveState = () => {
    persistState();
    requestSync();
};

/**
 * Update the persistent sync status to show last synced time and key prefix.
 * Uses state.lastUpdated (the actual most-recent edit timestamp, local or
 * merged-in-remote) rather than the current wall-clock time, so this only
 * moves when data genuinely changed — not on every page refresh where a
 * no-op sync cycle ran but nothing was actually pulled or pushed.
 */
const updateSyncedStatus = () => {
    if (!state.mantledb) return;
    const keyPrefix = state.mantledb.key.slice(0, 5);
    const dateStr = new Date(state.lastUpdated || Date.now()).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    showSyncStatus.setDefault(`Last synced: ${dateStr} (${keyPrefix})`);
};

/**
 * Optional: keep devices converged even when nothing was edited locally.
 * A sync cycle only self-heals a lost race (see runSyncCycle) or picks up
 * another device's edits when it actually runs. Without this, that only
 * happens on this device's next local edit. Re-syncing on focus and on a
 * slow interval means stale data doesn't just sit there until someone
 * happens to touch a setting.
 */
if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => {
        if (state.mantledb) requestSync();
    });
    setInterval(() => {
        if (state.mantledb) requestSync();
    }, 60000);
}