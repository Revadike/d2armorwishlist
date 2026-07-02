const CSV_URL = './data.csv';

const STATS = ['Health', 'Melee', 'Grenade', 'Super', 'Class', 'Weapons'];

const ARCHETYPE_DEFS = {
    'gunner': { id: 'gunner', name: 'Gunner', p: 'Weapons', s: 'Grenade' },
    'brawler': { id: 'brawler', name: 'Brawler', p: 'Melee', s: 'Health' },
    'specialist': { id: 'specialist', name: 'Specialist', p: 'Class', s: 'Weapons' },
    'paragon': { id: 'paragon', name: 'Paragon', p: 'Super', s: 'Melee' },
    'grenadier': { id: 'grenadier', name: 'Grenadier', p: 'Grenade', s: 'Super' },
    'bulwark': { id: 'bulwark', name: 'Bulwark', p: 'Health', s: 'Class' },
    'siegebreaker': { id: 'siegebreaker', name: 'Siegebreaker', p: 'Health', s: 'Grenade' },
    'skirmisher': { id: 'skirmisher', name: 'Skirmisher', p: 'Melee', s: 'Weapons' },
    'demolitionist': { id: 'demolitionist', name: 'Demolitionist', p: 'Grenade', s: 'Class' },
    'colossus': { id: 'colossus', name: 'Colossus', p: 'Super', s: 'Health' },
    'reaver': { id: 'reaver', name: 'Reaver', p: 'Class', s: 'Melee' },
    'powerhouse': { id: 'powerhouse', name: 'Powerhouse', p: 'Weapons', s: 'Super' }
};

const SETNAME_OVERRIDES = new Map([
    ['iron panoply', 'iron panoply set'],
    ['iron battalion', 'iron battalion set'],
    ['wayward psyche', 'wayward psyche set'],
    ['smoke jumper', 'smoke jumper set'],
    ['disaster corps', 'disaster corps set']
]);

// Memory object to remember the last chosen tertiaries for each archetype globally
const lastUsedTertiaries = {};

const ALL_SLOTS = ['helmet', 'gauntlets', 'chest', 'leg', 'classitem'];

const EXOTICS = [
    { id: 'exotic_helmet', label: 'Exotic Helmet', slot: 'helmet' },
    { id: 'exotic_gauntlets', label: 'Exotic Gauntlets', slot: 'gauntlets' },
    { id: 'exotic_chest', label: 'Exotic Chest', slot: 'chest' },
    { id: 'exotic_leg', label: 'Exotic Leg Armor', slot: 'leg' },
    { id: 'exotic_classitem', label: 'Exotic Class Item', slot: 'classitem' }
];

let rawData = [];
let syncingFromRemote = false; // prevent push while pulling remote state on startup
let state = {
    tier5: true,
    keep: true,
    sortCol: 'Set',
    sortAsc: true,
    prefs: {},
    mantledb: null
};
let slotAssignments = {};
let conflicts = {};

const STATE_KEY = 'd2asw';
const LEGACY_STATE_KEY = 'dimConfigState';

const MANTLE_BASE_URL = 'https://mantledb.sh/v2';
const MANTLE_PATH = 'state';

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
 * Show a brief sync status message near the import/export button
 * @param {string} msg - Message to display
 * @param {boolean} [isError=false] - Show in error color
 */
const showSyncStatus = (() => {
    let timer = null;
    return (msg, isError = false) => {
        const el = document.getElementById('syncStatus');
        if (!el) return;
        if (timer) clearTimeout(timer);
        el.textContent = msg;
        el.classList.toggle('error', isError);
        el.classList.add('visible');
        timer = setTimeout(() => el.classList.remove('visible'), 3000);
    };
})();

/**
 * Initialize MantleDB: generate and claim a namespace if not already done
 */
const initMantledb = async () => {
    if (state.mantledb) return;
    const ns = generateStorageKey();
    try {
        const key = await claimMantleNamespace(ns);
        state.mantledb = { ns, key };
        saveState();
    } catch (e) {
        showSyncStatus('Sync unavailable — changes saved locally only', true);
    }
};

/**
 * Push current state to MantleDB (fire-and-forget)
 * On auth failure, silently drops the broken config and claims a fresh namespace.
 */
const pushToMantledb = async () => {
    if (!state.mantledb || syncingFromRemote) return;
    const { ns, key } = state.mantledb;
    const payload = { ...state };
    delete payload.mantledb;
    try {
        const res = await fetch(`${MANTLE_BASE_URL}/${ns}/${MANTLE_PATH}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Mantle-Key': key
            },
            body: JSON.stringify(payload)
        });
        // If the namespace was reset while this push was in flight, silently discard the result
        if (state.mantledb?.ns !== ns) return;
        if (res.status === 401 || res.status === 403) {
            // Stored key is invalid — drop it and silently reconnect with a fresh namespace
            state.mantledb = null;
            localStorage.setItem(STATE_KEY, JSON.stringify(state));
            showSyncStatus('Sync reconnecting…');
            await initMantledb();
        } else if (!res.ok) {
            showSyncStatus('Sync failed', true);
        }
    } catch (e) {
        // If the namespace was reset while this push was in flight, silently discard the result
        if (state.mantledb?.ns !== ns) return;
        showSyncStatus('Sync failed', true);
    }
};

// Thrown when the server rejects the key (401/403) — a permanent failure requiring a new namespace
class MantleAuthError extends Error { }

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
        }
    } catch (e) {
        console.error('Error loading state:', e);
    }
};

/**
 * Save application state to localStorage and push to MantleDB
 */
const saveState = () => {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    pushToMantledb();
};

/**
 * Initialize the application
 */
const init = async () => {
    loadState();

    const tier5Toggle = document.getElementById('tier5Toggle');
    tier5Toggle.checked = state.tier5;
    tier5Toggle.addEventListener('change', (e) => {
        state.tier5 = e.target.checked;
        saveAndRender();
    });

    const keepToggle = document.getElementById('keepToggle');
    keepToggle.checked = state.keep;
    keepToggle.addEventListener('change', (e) => {
        state.keep = e.target.checked;
        saveAndRender();
    });

    const clearBtn = document.getElementById('clearBtn');
    clearBtn.addEventListener('click', clearAll);

    const importExportBtn = document.getElementById('importExportBtn');
    importExportBtn.addEventListener('click', importExportState);

    const tbody = document.getElementById('tableBody');
    tbody.addEventListener('click', handleTableClick);
    tbody.addEventListener('change', handleTableChange);

    // Pull remote state before parsing CSV so we never push stale local data
    if (state.mantledb) {
        syncingFromRemote = true;
        try {
            const remoteState = await pullFromMantledb(state.mantledb.ns, state.mantledb.key);
            if (remoteState !== null) {
                const mantledb = state.mantledb;
                Object.assign(state, remoteState);
                state.mantledb = mantledb; // preserve local mantledb config
                localStorage.setItem(STATE_KEY, JSON.stringify(state));
                showSyncStatus('Settings synced');
            }
            // null = no remote entry yet (new/cleared namespace) — local state is already correct
        } catch (e) {
            if (e instanceof MantleAuthError) {
                // Stored key has gone stale — drop it and claim a fresh namespace
                state.mantledb = null;
                syncingFromRemote = false;
                showSyncStatus('Sync reconnecting…');
                await initMantledb();
            } else {
                // Transient network error — proceed with local state
                showSyncStatus('Sync unavailable, using local settings', true);
            }
        } finally {
            syncingFromRemote = false;
        }
    } else {
        await initMantledb();
    }

    Papa.parse(CSV_URL, {
        download: true,
        header: true,
        complete: (results) => {
            rawData = results.data.filter(r => r.Set && r.Set.trim() !== '');
            processData();
            saveAndRender();
        }
    });
};

/**
 * Handle click events in the table (delegated)
 * @param {Event} e - The click event
 */
const handleTableClick = (e) => {
    const target = e.target;

    if (target.classList.contains('remove') && target.dataset.val) {
        removeCombine(target.dataset.key, target.dataset.val);
    }
};

/**
 * Handle change events in the table (delegated)
 * @param {Event} e - The change event
 */
const handleTableChange = (e) => {
    const target = e.target;

    if (target.classList.contains('combine-select')) {
        addCombine(target.dataset.key, target);
    } else if (target.classList.contains('want-checkbox')) {
        toggleWanted(target.dataset.key);
    }
};

/**
 * Process raw data to extract computed properties
 */
const processData = () => {
    rawData.forEach(row => {
        row.exactName = row.Set.split('\n')[0].trim().toLowerCase();
        row.pcsNum = row.Pcs;
        row.key = `${row.exactName}_${row.pcsNum}`;

        if (!state.prefs[row.key]) {
            state.prefs[row.key] = {
                wanted: false,
                archetypes: {},
                combineWith: []
            };
        }
    });
};

/**
 * Save state and re-render the table and queries
 */
const saveAndRender = () => {
    saveState();
    optimizeSlots();
    renderTable();
    updateQueries();
};

/**
 * Clear all selections with confirmation and generate a new MantleDB namespace
 */
const clearAll = async () => {
    if (confirm('Are you sure you want to clear all selections?')) {
        for (let k in state.prefs) {
            state.prefs[k] = {
                wanted: false,
                archetypes: {},
                combineWith: []
            };
        }
        state.mantledb = null;
        // Persist the cleared state immediately so a page refresh doesn't restore old settings
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
        // initMantledb claims a new namespace and calls saveState, which pushes the cleared state
        await initMantledb();
        optimizeSlots();
        renderTable();
        updateQueries();
        // Only show success if initMantledb actually succeeded; failure shows its own message
        if (state.mantledb) {
            showSyncStatus('New sync profile created');
        }
    }
};

/**
 * Apply a freshly loaded state to the DOM and table, filling any missing pref keys.
 * Call after any loadState() that happens outside of init().
 */
const applyLoadedState = () => {
    document.getElementById('tier5Toggle').checked = state.tier5;
    document.getElementById('keepToggle').checked = state.keep;
    processData(); // fill in any prefs keys missing from imported data
    optimizeSlots();
    renderTable();
    updateQueries();
};

/**
 * Import or export state using window.prompt, with MantleDB sync on import
 */
const importExportState = async () => {
    const currentStateJson = getStateFromStorage() || '{}';

    // Show current settings in prompt; user can copy or paste new settings
    const userInput = prompt('Copy your settings, or paste previously exported settings to restore them:', currentStateJson);

    if (userInput === null) return; // User cancelled

    // If user didn't change the data, they just copied it
    if (userInput === currentStateJson) return;

    // Otherwise, try to import the pasted data
    try {
        const importedState = JSON.parse(userInput);

        // Validate that it looks like state data
        if (typeof importedState === 'object' && importedState !== null) {
            // If the imported state includes a MantleDB config, try to sync from the cloud
            if (importedState.mantledb && importedState.mantledb.ns && importedState.mantledb.key) {
                try {
                    const remoteState = await pullFromMantledb(importedState.mantledb.ns, importedState.mantledb.key);
                    if (remoteState !== null) {
                        // Remote has state — use it as it's the most up-to-date
                        const mergedState = { ...remoteState, mantledb: importedState.mantledb };
                        localStorage.setItem(STATE_KEY, JSON.stringify(mergedState));
                    } else {
                        // 404: valid namespace/key but nothing pushed yet — use imported JSON
                        localStorage.setItem(STATE_KEY, JSON.stringify(importedState));
                    }
                    loadState();
                    applyLoadedState();
                    showSyncStatus('Settings synced from cloud');
                } catch (syncError) {
                    if (syncError instanceof MantleAuthError) {
                        // Bad key in the pasted JSON — strip mantledb, import prefs only, get fresh namespace
                        const { mantledb: _m, ...stateWithoutMantle } = importedState;
                        localStorage.setItem(STATE_KEY, JSON.stringify(stateWithoutMantle));
                        loadState();
                        applyLoadedState();
                        await initMantledb();
                        // Only show success if a new namespace was actually claimed; failure shows its own message
                        if (state.mantledb) {
                            showSyncStatus('Settings imported (sync invalid, new profile created)');
                        }
                    } else {
                        // Transient network error — use imported JSON as-is, sync will retry on next save
                        localStorage.setItem(STATE_KEY, JSON.stringify(importedState));
                        loadState();
                        applyLoadedState();
                        showSyncStatus('Settings imported (sync temporarily unavailable)', true);
                    }
                }
            } else {
                // No MantleDB config in import — apply it and start a fresh namespace
                localStorage.setItem(STATE_KEY, JSON.stringify(importedState));
                loadState();
                applyLoadedState();
                await initMantledb(); // claim a new namespace so future changes sync
                // Only show success if a namespace was actually claimed; failure shows its own message
                if (state.mantledb) {
                    showSyncStatus('Settings imported');
                }
            }
        } else {
            alert('Invalid settings data. Please ensure you pasted the complete exported string.');
        }
    } catch (e) {
        alert('Error parsing settings: ' + e.message + '. Please ensure you pasted the complete exported string.');
    }
};

/**
 * Set the sort column and direction
 * @param {string} col - Column name to sort by
 */
const setSort = (col) => {
    if (state.sortCol === col) {
        state.sortAsc = !state.sortAsc;
    } else {
        state.sortCol = col;
        state.sortAsc = true;
    }
    saveAndRender();
};

/**
 * Update visual sort indicators on table headers
 */
const updateSortIndicator = () => {
    document.querySelectorAll('th.sortable').forEach(th => {
        th.classList.remove('sorted');
        th.textContent = th.textContent.replace(/↑|↓|↕/g, '↕');
    });

    const colMap = { 'Set': 'col-set', 'Tier': 'col-tier', 'Want': 'col-want' };
    const className = colMap[state.sortCol];

    if (className) {
        const header = document.querySelector(`th.${className}`);
        if (header) {
            header.classList.add('sorted');
            const arrow = state.sortAsc ? '↑' : '↓';
            header.textContent = header.textContent.replace(/↑|↓|↕/g, arrow);
        }
    }
};

/**
 * Copy query text to clipboard with visual feedback
 * @param {string} id - Element ID to copy from
 * @param {HTMLElement} btnElement - The button that triggered the copy
 */
const copyQuery = (id, btnElement) => {
    const textarea = document.getElementById(id);
    navigator.clipboard.writeText(textarea.value).then(() => {
        const originalText = btnElement.innerText;
        btnElement.innerText = 'Copied!';
        setTimeout(() => {
            btnElement.innerText = originalText;
        }, 1500);
    });
};

/**
 * Generate all combinations of array elements of length k
 * @param {Array} arr - Input array
 * @param {number} k - Combination length
 * @returns {Array} Array of combinations
 */
const getCombinations = (arr, k) => {
    if (k === 0) return [[]];
    if (arr.length === 0) return [];

    const [first, ...rest] = arr;
    return [
        ...getCombinations(rest, k - 1).map(c => [first, ...c]),
        ...getCombinations(rest, k)
    ];
};

/**
 * Optimize slot assignments for 2-piece sets
 */
const optimizeSlots = () => {
    slotAssignments = {};
    conflicts = {};

    const targetSets = [];
    for (let key in state.prefs) {
        const pref = state.prefs[key];
        const exactName = key.split('_')[0];
        const fourPcsKey = `${exactName}_4`;

        if (key.endsWith('_2') && pref.wanted) {
            if (!(state.prefs[fourPcsKey] && state.prefs[fourPcsKey].wanted)) {
                targetSets.push(key);
            }
        }
    }

    const choices = {};
    for (let key of targetSets) {
        const pref = state.prefs[key];
        const forbidden = pref.combineWith
            .filter(c => c.startsWith('exotic_'))
            .map(c => EXOTICS.find(e => e.id === c).slot);

        const allowed = ALL_SLOTS.filter(s => !forbidden.includes(s));
        const combos = getCombinations(allowed, 3);

        if (combos.length === 0) {
            conflicts[key] = 'Too many exact slots blocked! Using fallback.';
            choices[key] = [ALL_SLOTS.slice(0, 3)];
        } else {
            choices[key] = combos;
        }
    }

    // Count overlapping pieces between every declared "combine with" pair under a
    // given assignment. Each combine edge is scored once for whichever side(s)
    // declared it; lower total overlap is better.
    const scoreAssignment = (assignment) => {
        let score = 0;
        for (let key of targetSets) {
            state.prefs[key].combineWith.forEach(c => {
                if (!c.startsWith('exotic_') && assignment[c]) {
                    score += assignment[key].filter(s => assignment[c].includes(s)).length;
                }
            });
        }
        return score;
    };

    // The exhaustive search is the product of each set's choice count (up to 10
    // combos each), which explodes for many simultaneous 2pc-only sets and would
    // freeze the UI. Cap the work and fall back to a greedy assignment when the
    // search space is too large.
    const MAX_SEARCH = 200000;
    let searchSpace = 1;
    for (let key of targetSets) {
        searchSpace *= choices[key].length;
        if (searchSpace > MAX_SEARCH) break;
    }

    if (searchSpace > MAX_SEARCH) {
        // Greedy: assign sets in order, each picking the choice that minimizes
        // overlap with already-assigned combine partners.
        const greedy = {};
        for (let key of targetSets) {
            let bestChoice = choices[key][0];
            let bestLocal = Infinity;
            for (let choice of choices[key]) {
                let local = 0;
                state.prefs[key].combineWith.forEach(c => {
                    if (!c.startsWith('exotic_') && greedy[c]) {
                        local += choice.filter(s => greedy[c].includes(s)).length;
                    }
                });
                if (local < bestLocal) {
                    bestLocal = local;
                    bestChoice = choice;
                }
            }
            greedy[key] = bestChoice;
        }
        slotAssignments = greedy;
        return;
    }

    let bestScore = Infinity;
    let bestAssignment = {};

    const search = (index, currentAssignment) => {
        if (index === targetSets.length) {
            const score = scoreAssignment(currentAssignment);
            if (score < bestScore) {
                bestScore = score;
                bestAssignment = { ...currentAssignment };
            }
            return;
        }

        const key = targetSets[index];
        for (let choice of choices[key]) {
            currentAssignment[key] = choice;
            search(index + 1, currentAssignment);
        }
    };

    search(0, {});
    slotAssignments = bestAssignment;
};

/**
 * Toggle wanted status for an armor set
 * @param {string} key - Armor set key
 */
const toggleWanted = (key) => {
    const pref = state.prefs[key];
    pref.wanted = !pref.wanted;

    // Reset archetypes to default when unchecking want
    if (!pref.wanted) {
        pref.archetypes = {};
    }

    const [exactName, pcs] = key.split('_');

    // Auto-want the 2pcs when 4pcs is wanted
    if (pcs === '4' && pref.wanted) {
        if (state.prefs[`${exactName}_2`]) state.prefs[`${exactName}_2`].wanted = true;
    }
    // Auto-unwant the 4pcs when 2pcs is unwanted
    if (pcs === '2' && !pref.wanted) {
        if (state.prefs[`${exactName}_4`]) state.prefs[`${exactName}_4`].wanted = false;
    }

    saveAndRender();
};

/**
 * Add an archetype to the armor set
 * @param {string} rowKey - Armor set key
 * @param {string} archId - Archetype ID
 */
function addArchetype(rowKey, archId) {
    if (!state.prefs[rowKey].archetypes) {
        state.prefs[rowKey].archetypes = {};
    }

    const def = ARCHETYPE_DEFS[archId];

    // Get all available tertiary stats (all except primary and secondary)
    const allTerts = STATS.filter(s => s !== def.p && s !== def.s);

    // Use last used tertiaries if they exist, otherwise use all available
    const defaultTerts = lastUsedTertiaries[archId] ? [...lastUsedTertiaries[archId]] : allTerts;
    state.prefs[rowKey].archetypes[archId] = defaultTerts;

    // Auto-select Want
    state.prefs[rowKey].wanted = true;

    saveAndRender();
}

/**
 * Remove an archetype from the armor set
 * @param {string} rowKey - Armor set key
 * @param {string} archId - Archetype ID
 */
function removeArchetype(rowKey, archId) {
    delete state.prefs[rowKey].archetypes[archId];
    saveAndRender();
}

/**
 * Toggle a tertiary stat for an archetype
 * @param {string} rowKey - Armor set key
 * @param {string} archId - Archetype ID
 * @param {string} stat - Stat name
 */
function toggleTertiary(rowKey, archId, stat) {
    const terts = state.prefs[rowKey].archetypes[archId];
    const index = terts.indexOf(stat);

    if (index > -1) {
        terts.splice(index, 1);
    } else {
        terts.push(stat);
    }

    // Save to global memory for convenience on future sets
    lastUsedTertiaries[archId] = [...terts];

    saveAndRender();
}



/**
 * Add a combination to the armors's combineWith list
 * @param {string} key - Armor set key
 * @param {HTMLElement} selectElement - The select element
 */
const addCombine = (key, selectElement) => {
    const val = selectElement.value;
    if (!val) return;

    const pref = state.prefs[key];
    if (!pref.combineWith.includes(val)) {
        pref.combineWith.push(val);
    }

    // Set-to-set combines are mutual: if A combines with 2pc set B, B should also
    // combine with A. Exotics are not sets, so they stay one-directional.
    if (!val.startsWith('exotic_') && state.prefs[val]) {
        const partner = state.prefs[val];
        if (!partner.combineWith.includes(key)) {
            partner.combineWith.push(key);
        }
    }

    selectElement.value = '';
    saveAndRender();
};

/**
 * Remove a combination from the armor set's combineWith list
 * @param {string} key - Armor set key
 * @param {string} val - Combination value to remove
 */
const removeCombine = (key, val) => {
    const pref = state.prefs[key];
    pref.combineWith = pref.combineWith.filter(v => v !== val);

    // Mirror removal for mutual set-to-set combines.
    if (!val.startsWith('exotic_') && state.prefs[val]) {
        state.prefs[val].combineWith = state.prefs[val].combineWith.filter(v => v !== key);
    }

    saveAndRender();
};



/**
 * Create a chip element for a combination
 * @param {string} val - Combination value
 * @param {string} key - Armor set key
 * @param {Array} available2pcsSets - Available 2-piece sets
 * @returns {HTMLElement} The chip element
 */
const createChip = (val, key, available2pcsSets) => {
    const chip = document.createElement('div');
    chip.className = 'chip';

    let label;
    if (val.startsWith('exotic_')) {
        label = EXOTICS.find(e => e.id === val)?.label || val;
    } else {
        label = available2pcsSets.find(s => s.id === val)?.label || val;
    }

    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;

    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove';
    removeBtn.textContent = '×';
    removeBtn.dataset.key = key;
    removeBtn.dataset.val = val;

    chip.appendChild(labelSpan);
    chip.appendChild(removeBtn);

    return chip;
};

/**
 * Create the combine cell content for a 2-piece set
 * @param {string} key - Armor set key
 * @param {object} pref - Preference object
 * @param {boolean} is2pcs - Whether this is a 2-piece armor
 * @param {boolean} want4pcs - Whether the 4-piece is wanted
 * @param {Array} available2pcsSets - Available 2-piece sets
 * @returns {HTMLElement} The combine cell element
 */
const createCombineCell = (key, pref, is2pcs, want4pcs, available2pcsSets) => {
    const cell = document.createElement('div');
    cell.className = 'combine-cell';

    if (!is2pcs) {
        return cell;
    }

    if (!pref.wanted) {
        const msg = document.createElement('span');
        msg.className = 'subtext';
        msg.textContent = 'Must be wanted';
        cell.appendChild(msg);
        return cell;
    }

    if (want4pcs) {
        const msg = document.createElement('span');
        msg.className = 'subtext';
        msg.textContent = 'Disabled (4pcs wanted)';
        cell.appendChild(msg);
        return cell;
    }

    const chipsContainer = document.createElement('div');
    chipsContainer.className = 'chips-container';

    pref.combineWith.forEach(val => {
        chipsContainer.appendChild(createChip(val, key, available2pcsSets));
    });

    const select = document.createElement('select');
    select.className = 'combine-select';
    select.dataset.key = key;

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '+ Add...';
    select.appendChild(defaultOption);

    const exoticGroup = document.createElement('optgroup');
    exoticGroup.label = 'Exotics';
    EXOTICS.forEach(e => {
        const option = document.createElement('option');
        option.value = e.id;
        option.textContent = e.label;
        if (pref.combineWith.includes(e.id)) option.disabled = true;
        exoticGroup.appendChild(option);
    });
    select.appendChild(exoticGroup);

    const validSets = available2pcsSets.filter(s => s.id !== key);
    if (validSets.length > 0) {
        const setsGroup = document.createElement('optgroup');
        setsGroup.label = 'Other wanted 2pcs';
        validSets.forEach(s => {
            const option = document.createElement('option');
            option.value = s.id;
            option.textContent = s.label;
            if (pref.combineWith.includes(s.id)) option.disabled = true;
            setsGroup.appendChild(option);
        });
        select.appendChild(setsGroup);
    }

    cell.appendChild(chipsContainer);
    cell.appendChild(select);

    if (conflicts[key]) {
        const warn = document.createElement('div');
        warn.className = 'conflict-warn';
        warn.textContent = conflicts[key];
        cell.appendChild(warn);
    }

    return cell;
};

/**
 * Create a table row for an armor set
 * @param {object} row - Armor data row
 * @param {Array} available2pcsSets - Available 2-piece sets
 * @returns {HTMLElement} The table row element
 */
const createTableRow = (row, available2pcsSets) => {
    const tr = document.createElement('tr');
    const pref = state.prefs[row.key];

    const displayName = row.Set.split('\n')[0];
    const displaySub = row.Set.split('\n')[1] || '';

    const is2pcs = row.pcsNum === '2';
    const want4pcs = state.prefs[`${row.exactName}_4`] && state.prefs[`${row.exactName}_4`].wanted;

    if (is2pcs && want4pcs) {
        tr.classList.add('row-disabled');
    }

    const setCell = document.createElement('td');
    setCell.className = 'col-set';
    const setTitle = document.createElement('strong');
    setTitle.className = 'set-name';
    setTitle.textContent = displayName;
    const setSubtext = document.createElement('div');
    setSubtext.className = 'set-subtext';
    setSubtext.textContent = displaySub;
    setCell.appendChild(setTitle);
    setCell.appendChild(setSubtext);

    const effectCell = document.createElement('td');
    effectCell.className = 'col-effect';
    const bonusLabel = document.createElement('strong');
    bonusLabel.className = 'bonus-label';
    bonusLabel.innerHTML = `${row.Pcs} pcs &mdash; ${row.Bonus || '-'}`;
    const triggerDiv = document.createElement('div');
    triggerDiv.className = 'subtext';
    triggerDiv.innerHTML = `<span class="subtext-value">Trigger:</span> ${row.Trigger || '-'}`;
    const effectDiv = document.createElement('div');
    effectDiv.className = 'subtext';
    effectDiv.innerHTML = `<span class="subtext-value">Effect:</span> ${row.Effect || '-'}`;
    effectCell.appendChild(bonusLabel);
    effectCell.appendChild(triggerDiv);
    effectCell.appendChild(effectDiv);

    const tierCell = document.createElement('td');
    tierCell.className = 'col-tier';
    const tierLabel = document.createElement('strong');
    tierLabel.className = 'tier-label';
    tierLabel.textContent = `${row.Tier}-tier`;
    const analysisDiv = document.createElement('div');
    analysisDiv.className = 'subtext';
    analysisDiv.textContent = row['ANALYSIS Description'] || '-';
    tierCell.appendChild(tierLabel);
    tierCell.appendChild(analysisDiv);

    const wantCell = document.createElement('td');
    wantCell.className = 'col-want';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'want-checkbox';
    checkbox.dataset.key = row.key;
    checkbox.checked = pref.wanted;
    wantCell.appendChild(checkbox);

    // Create combine cell first (needed for early return)
    const combineTd = document.createElement('td');
    combineTd.className = 'col-combine';
    combineTd.appendChild(createCombineCell(row.key, pref, is2pcs, want4pcs, available2pcsSets));

    // --- NEW ARCHETYPES COLUMN ---
    const tdArch = document.createElement('td');
    tdArch.className = 'col-archetypes';

    // If this is a 2pcs row and the 4pcs is wanted, disable the archetype column
    if (is2pcs && want4pcs) {
        const msg = document.createElement('span');
        msg.className = 'subtext';
        msg.textContent = 'Disabled (4pcs wanted)';
        tdArch.appendChild(msg);
        tr.appendChild(setCell);
        tr.appendChild(effectCell);
        tr.appendChild(tierCell);
        tr.appendChild(wantCell);
        tr.appendChild(tdArch);
        tr.appendChild(combineTd);
        return tr;
    }

    const archContainer = document.createElement('div');
    archContainer.className = 'archetype-container';

    const selectedArchs = pref.archetypes || {};

    // Render already selected archetypes
    Object.keys(selectedArchs).forEach(archId => {
        const def = ARCHETYPE_DEFS[archId];
        const block = document.createElement('div');
        block.className = 'archetype-block';

        // Header: Name (Primary/Secondary) & Remove Button
        const header = document.createElement('div');
        header.className = 'arch-header';
        const nameSpan = document.createElement('span');
        nameSpan.innerHTML = `${def.name} <small>(${def.p}/${def.s})</small>`;
        const removeBtn = document.createElement('span');
        removeBtn.className = 'remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = () => removeArchetype(row.key, archId);
        header.appendChild(nameSpan);
        header.appendChild(removeBtn);
        block.appendChild(header);

        // Tertiary Pills
        const tertContainer = document.createElement('div');
        tertContainer.className = 'tert-list';

        STATS.forEach(stat => {
            // Prevent picking primary or secondary as a tertiary stat
            if (stat === def.p || stat === def.s) return;

            const isActive = selectedArchs[archId].includes(stat);
            const pill = document.createElement('div');
            pill.className = `tert-pill ${isActive ? 'active' : ''}`;
            pill.textContent = stat;
            pill.onclick = () => toggleTertiary(row.key, archId, stat);
            tertContainer.appendChild(pill);
        });

        block.appendChild(tertContainer);
        archContainer.appendChild(block);
    });
    tdArch.appendChild(archContainer);

    // Dropdown to add more archetypes, organized by primary stat
    const activeArchCount = Object.keys(selectedArchs).length;
    const totalArchCount = Object.keys(ARCHETYPE_DEFS).length;

    if (activeArchCount < totalArchCount) {
        const addSelect = document.createElement('select');
        addSelect.className = 'add-arch-select';

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '+ Add Archetype...';
        addSelect.appendChild(defaultOption);

        // Group archetypes by primary stat
        const grouped = {};
        Object.values(ARCHETYPE_DEFS).forEach(def => {
            if (!selectedArchs[def.id]) {
                if (!grouped[def.p]) grouped[def.p] = [];
                grouped[def.p].push(def);
            }
        });

        // Create optgroups for each primary stat
        STATS.forEach(primaryStat => {
            if (grouped[primaryStat] && grouped[primaryStat].length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = primaryStat;

                // Sort by secondary stat within each primary
                grouped[primaryStat].sort((a, b) => a.s.localeCompare(b.s));

                grouped[primaryStat].forEach(def => {
                    const option = document.createElement('option');
                    option.value = def.id;
                    option.textContent = `${def.name} (${def.s})`;
                    optgroup.appendChild(option);
                });

                addSelect.appendChild(optgroup);
            }
        });

        addSelect.onchange = (e) => {
            if (e.target.value) {
                addArchetype(row.key, e.target.value);
                e.target.value = ''; // reset dropdown
            }
        };
        tdArch.appendChild(addSelect);
    }

    tr.appendChild(setCell);
    tr.appendChild(effectCell);
    tr.appendChild(tierCell);
    tr.appendChild(wantCell);
    tr.appendChild(tdArch);
    tr.appendChild(combineTd);

    return tr;
};

/**
 * Render the entire table with sorted data
 */
const renderTable = () => {
    updateSortIndicator();
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    let sorted = [...rawData].sort((a, b) => {
        let res = 0;

        if (state.sortCol === 'Want') {
            const valA = state.prefs[a.key].wanted ? 1 : 0;
            const valB = state.prefs[b.key].wanted ? 1 : 0;
            res = state.sortAsc ? valA - valB : valB - valA;
        } else if (state.sortCol === 'Tier') {
            const valA = parseFloat(a.Rank) || 999;
            const valB = parseFloat(b.Rank) || 999;
            res = state.sortAsc ? valA - valB : valB - valA;
        } else {
            const valA = (a.Set || '').toString().toLowerCase();
            const valB = (b.Set || '').toString().toLowerCase();
            if (valA < valB) res = state.sortAsc ? -1 : 1;
            else if (valA > valB) res = state.sortAsc ? 1 : -1;
        }

        if (res !== 0) return res;

        if (state.sortCol !== 'Set') {
            const setA = (a.Set || '').toString().toLowerCase();
            const setB = (b.Set || '').toString().toLowerCase();
            if (setA < setB) return -1;
            if (setA > setB) return 1;
        }

        return parseFloat(a.Pcs) - parseFloat(b.Pcs);
    });

    const available2pcsSets = [];
    for (let k in state.prefs) {
        const exactName = k.split('_')[0];
        if (k.endsWith('_2') && state.prefs[k].wanted && !(state.prefs[`${exactName}_4`] && state.prefs[`${exactName}_4`].wanted)) {
            const row = rawData.find(r => r.key === k);
            if (row) {
                available2pcsSets.push({
                    id: k,
                    label: `${row.Set.split('\n')[0]} (2pcs)`
                });
            }
        }
    }

    sorted.forEach(row => {
        tbody.appendChild(createTableRow(row, available2pcsSets));
    });
};



/**
 * Update DIM query textareas with current selections
 */
const updateQueries = () => {
    const rowQueries = [];

    const validKeys = new Set(rawData.map(r => r.key));

    for (let key in state.prefs) {
        const pref = state.prefs[key];
        if (!pref.wanted) continue;
        if (!validKeys.has(key)) continue;

        const exactName = key.split('_')[0];
        const is2pcs = key.endsWith('_2');
        const want4pcs = state.prefs[`${exactName}_4`] && state.prefs[`${exactName}_4`].wanted;

        // When the 4pc is wanted, all 5 pieces of the set are kept and the 4pc
        // row already emits an unrestricted exactperk term covering the whole set.
        // Emitting the auto-wanted 2pc row too would add a redundant term with its
        // own (often empty) stat filters, nullifying the 4pc's stat restrictions.
        if (is2pcs && want4pcs) continue;

        const queryName = SETNAME_OVERRIDES.get(exactName) || exactName;
        const parts = [`exactperk:"${queryName}"`];

        if (is2pcs && !want4pcs && slotAssignments[key] && slotAssignments[key].length > 0) {
            parts.push(`(${slotAssignments[key].map(s => `is:${s}`).join(' or ')})`);
        }

        const selectedArchs = pref.archetypes || {};
        const archKeys = Object.keys(selectedArchs);

        if (archKeys.length > 0) {
            const archQueries = archKeys.map(archId => {
                const def = ARCHETYPE_DEFS[archId];
                const baseArchQuery = `exactperk:${archId}`;
                const terts = selectedArchs[archId];

                // Get all available tertiary stats for this archetype
                const allAvailableTerts = STATS.filter(s => s !== def.p && s !== def.s);

                // If all available tertiaries are selected, omit the tertiary filter (cleaner query)
                if (terts.length === allAvailableTerts.length) {
                    return baseArchQuery;
                }

                if (terts.length > 0) {
                    // Map selected tertiaries into DIM query syntax
                    const tertQuery = terts.map(stat => `tertiarystat:${stat.toLowerCase()}`).join(' or ');
                    return `(${baseArchQuery} (${tertQuery}))`;
                }
                return baseArchQuery;
            });
            parts.push(`(${archQueries.join(' or ')})`);
        }

        rowQueries.push(`(${parts.join(' ')})`);
    }

    const baseFilters = 'is:armor3.0 is:legendary';

    const posTextarea = document.getElementById('positiveQuery');
    const negTextarea = document.getElementById('negativeQuery');

    if (rowQueries.length === 0) {
        posTextarea.value = 'No armor sets selected.';
        negTextarea.value = 'No armor sets selected.';
        return;
    }

    const combinedOr = rowQueries.length > 1 ? `(${rowQueries.join(' or ')})` : rowQueries[0];

    // Build selection filter with optional tier5 constraint
    const selectionQuery = state.tier5 ? `tier:5 ${combinedOr}` : combinedOr;
    const selectionNegQuery = state.tier5 ? `(-tier:5 or -${combinedOr})` : `-${combinedOr}`;

    // Apply keep tag logic
    const posFilter = state.keep
        ? `(${selectionQuery} or tag:keep)`
        : selectionQuery;

    const negFilter = state.keep
        ? `(${selectionNegQuery} -tag:keep)`
        : selectionNegQuery;

    posTextarea.value = `${baseFilters} ${posFilter}`;
    negTextarea.value = `${baseFilters} ${negFilter}`;
};

window.addEventListener('load', init);
