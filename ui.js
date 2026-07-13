/**
 * ui.js - User interface and DOM manipulation
 * Handles table rendering, event handling, and user interactions
 */

// Show a brief sync status message near the import/export button
const showSyncStatus = (() => {
    let timer = null;
    let defaultText = '';
    let defaultIsError = false;

    const applyToEl = (msg, isError) => {
        const el = document.getElementById('syncStatus');
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('error', isError);
        el.classList.toggle('visible', msg.length > 0);
    };

    const fn = (msg, isError = false) => {
        if (timer) clearTimeout(timer);
        applyToEl(msg, isError);
        timer = setTimeout(() => {
            timer = null;
            applyToEl(defaultText, defaultIsError);
        }, 3000);
    };

    fn.setDefault = (msg, isError = false) => {
        defaultText = msg;
        defaultIsError = isError;
        if (!timer) applyToEl(msg, isError);
    };

    return fn;
})();

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
 * Clear all selections with confirmation.
 * Keeps the sync profile: the clear is a normal edit that syncs to other
 * devices instead of silently abandoning the namespace they still use.
 */
const clearAll = () => {
    if (confirm('Are you sure you want to clear all selections? This also clears them on your synced devices.')) {
        for (let k in state.prefs) {
            state.prefs[k] = {
                wanted: false,
                archetypes: {},
                combineWith: []
            };
            markPrefEdited(k);
        }
        saveAndRender();
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
 * Import or export state
 */
const importExportState = () => {
    const currentStateJson = JSON.stringify(state);

    const userInput = prompt(
        'Copy your settings, or paste previously exported settings to restore them:',
        currentStateJson
    );

    if (userInput === null) return; // User cancelled

    // If user didn't change the data, they just copied it
    if (userInput === currentStateJson) return;

    try {
        const imported = JSON.parse(userInput);

        if (typeof imported !== 'object' || imported === null) {
            alert('Invalid settings data.');
            return;
        }

        // If the import includes a MantleDB config, we can sync from cloud.
        // Merge the import using per-field timestamps: newer remote data is never
        // overwritten by the import, so this is safe even for stale exports.
        if (imported.mantledb?.ns && imported.mantledb?.key) {
            (async () => {
                try {
                    const remoteState = await pullFromMantledb(imported.mantledb.ns, imported.mantledb.key);
                    // Merge remote data on top of the import: fields in remote that
                    // are newer than the import win. Adopt the imported sync profile
                    // so this device joins the same namespace as the exporting device.
                    if (remoteState !== null) {
                        mergeRemoteIntoLocal(imported, remoteState);
                    }
                    Object.assign(state, imported);
                    persistState();
                    applyLoadedState();
                    showSyncStatus('Settings imported and synced');
                    updateSyncedStatus();
                    requestSync();
                } catch (e) {
                    if (e instanceof MantleAuthError) {
                        // Bad key in the import — use imported data only, claim fresh namespace
                        imported.mantledb = null;
                        Object.assign(state, imported);
                        persistState();
                        applyLoadedState();
                        await initMantledb();
                        if (state.mantledb) {
                            showSyncStatus('Settings imported (old sync invalid, new profile created)');
                        }
                    } else {
                        // Transient error — keep the imported sync profile and retry later
                        Object.assign(state, imported);
                        persistState();
                        applyLoadedState();
                        showSyncStatus('Settings imported (sync unavailable, will retry)', true);
                        scheduleSyncRetry();
                    }
                }
            })();
        } else {
            // No MantleDB config in import — apply it, keep local namespace
            imported.mantledb = state.mantledb;
            Object.assign(state, imported);
            Object.keys(imported.prefs || {}).forEach(k => {
                state.prefsUpdated[k] = nextEditTimestamp();
            });
            state.settingsUpdated = nextEditTimestamp();
            persistState();
            applyLoadedState();
            if (state.mantledb) {
                showSyncStatus('Settings imported');
                requestSync();
            } else {
                // No local namespace either — claim one so future changes sync
                initMantledb().then(() => {
                    if (state.mantledb) showSyncStatus('Settings imported');
                });
            }
        }
    } catch (e) {
        alert('Error parsing settings: ' + e.message);
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
    markSettingsEdited();
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

    // --- ARCHETYPES COLUMN ---
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

/**
 * Initialize the application
 */
const init = async () => {
    loadState();

    const tier5Toggle = document.getElementById('tier5Toggle');
    tier5Toggle.checked = state.tier5;
    tier5Toggle.addEventListener('change', (e) => {
        state.tier5 = e.target.checked;
        markSettingsEdited();
        saveAndRender();
    });

    const keepToggle = document.getElementById('keepToggle');
    keepToggle.checked = state.keep;
    keepToggle.addEventListener('change', (e) => {
        state.keep = e.target.checked;
        markSettingsEdited();
        saveAndRender();
    });

    const clearBtn = document.getElementById('clearBtn');
    clearBtn.addEventListener('click', clearAll);

    const importExportBtn = document.getElementById('importExportBtn');
    importExportBtn.addEventListener('click', importExportState);

    const tbody = document.getElementById('tableBody');
    tbody.addEventListener('click', handleTableClick);
    tbody.addEventListener('change', handleTableChange);

    // Pull remote state before parsing CSV so the first render shows synced data.
    // The sync cycle is pull→merge→push and per-field, so stale local data can
    // never overwrite newer remote data; failures retry automatically.
    if (state.mantledb) {
        await runSyncCycle();
    } else {
        await initMantledb();
    }

    // Re-sync when connectivity returns or the tab becomes visible again,
    // so long-lived tabs pick up edits made on other devices.
    window.addEventListener('online', requestSync);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') requestSync();
    });

    // Keep multiple tabs of the same browser consistent: reload state when
    // another tab writes to localStorage.
    window.addEventListener('storage', (e) => {
        if (e.key !== STATE_KEY || e.newValue === null) return;
        loadState();
        if (rawData.length > 0) applyLoadedState();
    });

    Papa.parse(CSV_URL, {
        download: true,
        header: true,
        complete: (results) => {
            rawData = results.data.filter(r => r.Set && r.Set.trim() !== '');
            processData();
            // Render only — loading the page is not a user edit, so nothing
            // is stamped or pushed here.
            optimizeSlots();
            renderTable();
            updateQueries();
        }
    });
};

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', init);
