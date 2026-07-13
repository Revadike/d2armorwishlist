/**
 * core.js - Core application logic and data processing
 * Handles armor data, preferences, and business logic
 */

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

const ALL_SLOTS = ['helmet', 'gauntlets', 'chest', 'leg', 'classitem'];

const EXOTICS = [
    { id: 'exotic_helmet', label: 'Exotic Helmet', slot: 'helmet' },
    { id: 'exotic_gauntlets', label: 'Exotic Gauntlets', slot: 'gauntlets' },
    { id: 'exotic_chest', label: 'Exotic Chest', slot: 'chest' },
    { id: 'exotic_leg', label: 'Exotic Leg Armor', slot: 'leg' },
    { id: 'exotic_classitem', label: 'Exotic Class Item', slot: 'classitem' }
];

// Memory object to remember the last chosen tertiaries for each archetype globally
const lastUsedTertiaries = {};

let rawData = [];
let slotAssignments = {};
let conflicts = {};

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
    markPrefEdited(key);

    // Reset archetypes to default when unchecking want
    if (!pref.wanted) {
        pref.archetypes = {};
    }

    const [exactName, pcs] = key.split('_');

    // Auto-want the 2pcs when 4pcs is wanted
    if (pcs === '4' && pref.wanted) {
        if (state.prefs[`${exactName}_2`] && !state.prefs[`${exactName}_2`].wanted) {
            state.prefs[`${exactName}_2`].wanted = true;
            markPrefEdited(`${exactName}_2`);
        }
    }
    // Auto-unwant the 4pcs when 2pcs is unwanted
    if (pcs === '2' && !pref.wanted) {
        if (state.prefs[`${exactName}_4`] && state.prefs[`${exactName}_4`].wanted) {
            state.prefs[`${exactName}_4`].wanted = false;
            markPrefEdited(`${exactName}_4`);
        }
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
    markPrefEdited(rowKey);

    saveAndRender();
}

/**
 * Remove an archetype from the armor set
 * @param {string} rowKey - Armor set key
 * @param {string} archId - Archetype ID
 */
function removeArchetype(rowKey, archId) {
    delete state.prefs[rowKey].archetypes[archId];
    markPrefEdited(rowKey);
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

    markPrefEdited(rowKey);
    saveAndRender();
}

/**
 * Add a combination to the armor's combineWith list
 * @param {string} key - Armor set key
 * @param {HTMLElement} selectElement - The select element
 */
const addCombine = (key, selectElement) => {
    const val = selectElement.value;
    if (!val) return;

    const pref = state.prefs[key];
    if (!pref.combineWith.includes(val)) {
        pref.combineWith.push(val);
        markPrefEdited(key);
    }

    // Set-to-set combines are mutual: if A combines with 2pc set B, B should also
    // combine with A. Exotics are not sets, so they stay one-directional.
    if (!val.startsWith('exotic_') && state.prefs[val]) {
        const partner = state.prefs[val];
        if (!partner.combineWith.includes(key)) {
            partner.combineWith.push(key);
            markPrefEdited(val);
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
    if (pref.combineWith.includes(val)) {
        pref.combineWith = pref.combineWith.filter(v => v !== val);
        markPrefEdited(key);
    }

    // Mirror removal for mutual set-to-set combines.
    if (!val.startsWith('exotic_') && state.prefs[val]) {
        if (state.prefs[val].combineWith.includes(key)) {
            state.prefs[val].combineWith = state.prefs[val].combineWith.filter(v => v !== key);
            markPrefEdited(val);
        }
    }

    saveAndRender();
};
