document.addEventListener('DOMContentLoaded', () => {

    // --- INIT ICONS ---
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // --- UTILS ---
    const dom = (id) => document.getElementById(id);
    const show = (el) => el && el.classList.remove('hidden');
    const hide = (el) => el && el.classList.add('hidden');

    const showToast = (msg) => {
        const t = dom('toast');
        if (!t) return;
        t.textContent = msg;
        show(t);
        setTimeout(() => hide(t), 3000);
    };

    const updateSiteStatusUI = (isOffline, message) => {
        let banner = dom('offline-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'offline-banner';
            banner.style = "background: #e50914; color: white; text-align: center; padding: 10px; font-weight: 700; position: sticky; top: 0; z-index: 9999; display: none; font-size: 0.9rem;";
            document.body.prepend(banner);
        }
        if (isOffline) {
            banner.textContent = `⚠️ SITE SOURCE INDISPONIBLE : ${message || 'Vérification en cours...'}`;
            banner.style.display = 'block';
        } else {
            banner.style.display = 'none';
        }
    };

    const apiCall = async (endpoint, method = 'GET', body = null) => {
        try {
            const opts = {
                method,
                headers: { 'Content-Type': 'application/json' }
            };
            if (body) opts.body = JSON.stringify(body);

            const res = await fetch(endpoint, opts);
            const text = await res.text();

            if (!res.ok) {
                let err = `Erreur ${res.status}`;
                try { err = JSON.parse(text).error || err; } catch (e) { }
                throw new Error(err);
            }
            return text ? JSON.parse(text) : {};
        } catch (e) {
            console.error(`API ${endpoint}:`, e);
            throw e;
        }
    };

    // --- STATE & LOOPS MANAGER ---
    const state = {
        downloadInterval: null,
        trendingData: { films: [], series: [] },
        activeSources: [],
        availableSources: [], // Dynamically populated from /status
    };

    // --- GESTION INTELLIGENTE DES BOUCLES ---

    // 1. Gestion Téléchargements (Actif seulement sur l'onglet)
    const startDownloadLoop = () => {
        if (state.downloadInterval) clearInterval(state.downloadInterval);
        loadDownloads(); // Appel immédiat
        state.downloadInterval = setInterval(loadDownloads, 5000); // Mise à jour toutes les 5s
        console.log("Flux Téléchargement : ACTIVÉ");
    };

    const stopDownloadLoop = () => {
        if (state.downloadInterval) {
            clearInterval(state.downloadInterval);
            state.downloadInterval = null;
            console.log("Flux Téléchargement : ARRÊTÉ");
        }
    };



    // --- NAVIGATION ---
    const navLinks = document.querySelectorAll('.nav-links li[data-target]');
    const sections = document.querySelectorAll('.section');

    navLinks.forEach(link => {
        link.addEventListener('click', async () => {
            const targetId = link.dataset.target;

            // 1. Gestion UI classique
            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');

            sections.forEach(s => hide(s));
            show(dom(targetId));

            // 2. Gestion des boucles
            stopDownloadLoop();
            if (targetId === 'section-downloads') {
                startDownloadLoop();
            }
        });
    });

    // --- LOGIN ---
    const loginForm = dom('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = loginForm.querySelector('button');
            const pass = dom('api-password').value;
            const err = dom('login-error');

            btn.disabled = true;
            hide(err);

            try {
                const res = await apiCall('/login', 'POST', { password: pass });
                if (res.success) {
                    initApp();
                } else {
                    show(err);
                }
            } catch (e) {
                err.textContent = "Erreur serveur";
                show(err);
            } finally {
                btn.disabled = false;
            }
        });
    }

    const checkSession = async () => {
        try {
            const res = await apiCall('/check-session');
            if (res.isLoggedIn) initApp();
        } catch (e) { }
    };

    const initApp = async () => {
        hide(dom('login-overlay'));
        show(dom('app-container'));
        
        // --- Source Detection & Dynamic Options ---
        let serverJdDefault = false;
        try {
            const statusData = await apiCall('/status');
            state.activeSources = statusData.activeSources || [];
            state.availableSources = statusData.availableSources || [];
            serverJdDefault = !!statusData.jdDefault;
            renderSourcesUI();
            updateLocalDbFiltersVisibility();
        } catch(e) { console.error('Erreur détection source:', e); }

        // --- Default-preference dropdowns (settings page) ---
        // Populates the Hébergeur / Qualité Films / Qualité Séries selects
        // from the LocalDB's distinct values. Persists picks to localStorage.
        try {
            const opts = await apiCall('/config-options');
            state.configOptions = opts;
            populateDefaultPrefs(opts);
        } catch (e) {
            console.error('Erreur /config-options:', e);
        }

        const trendingHidden = updateTrendingVisibility();

        // --- JDownloader Toggle ---
        // Priority: user's localStorage choice > server JD_ENABLED default > off.
        const toggleJd = document.getElementById('toggle-jd');
        if (toggleJd) {
            const savedState = localStorage.getItem('useJD');
            if (savedState !== null) {
                toggleJd.checked = savedState === 'true';
            } else {
                toggleJd.checked = serverJdDefault;
            }
            toggleJd.addEventListener('change', (e) => localStorage.setItem('useJD', e.target.checked));
        }

        if (!trendingHidden) loadTrending();
        lucide.createIcons();
        document.querySelectorAll('input[name="trending-type"]').forEach(radio => {
            radio.addEventListener('change', renderTrending);
        });

        // --- HEARTBEAT : Détection source down + Refresh Tendances ---
        let wasOffline = false;
        const checkSourceStatus = async () => {
            try {
                const s = await apiCall('/status');
                updateSiteStatusUI(s.isOffline, s.message);
                state.activeSources = s.activeSources || [];
                
                const searchInput = dom('search-input');
                if (searchInput) searchInput.disabled = s.isOffline;

                const trendingHidden = updateTrendingVisibility();
                if (!trendingHidden && !s.isOffline && (wasOffline || (!state.trendingData.films.length && !state.trendingData.series.length))) {
                    console.log('[Heartbeat] Site source en ligne, rechargement des tendances...');
                    loadTrending();
                }
                wasOffline = s.isOffline;
                updateLocalDbFiltersVisibility();
            } catch (e) {
                wasOffline = true;
                updateSiteStatusUI(true, 'Connexion au serveur perdue...');
            }
        };

        setInterval(checkSourceStatus, 30000);
    };

    // --- SOURCE MANAGEMENT ---
    function renderSourcesUI() {
        const container = dom('sources-container');
        if (!container) return;

        container.innerHTML = '';

        state.availableSources.forEach(sourceName => {
            const label = document.createElement('label');
            label.style = "display: flex; align-items: center; justify-content: space-between; cursor: pointer; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 10px; transition: background 0.2s;";
            label.onmouseover = () => label.style.background = "rgba(255,255,255,0.08)";
            label.onmouseout = () => label.style.background = "rgba(255,255,255,0.05)";

            const isActive = state.activeSources.includes(sourceName);
            const displayName = sourceName === 'zt' ? 'Zone-Téléchargement' : 
                                sourceName === 'hydracker' ? 'Hydracker (Token)' : 
                                sourceName.toUpperCase();

            label.innerHTML = `
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 10px; height: 10px; border-radius: 50%; background: ${isActive ? 'var(--success)' : '#4b5563'};"></div>
                    <span style="font-weight: 600;">${displayName}</span>
                </div>
                <input type="checkbox" value="${sourceName}" ${isActive ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer;">
            `;

            const checkbox = label.querySelector('input');
            checkbox.addEventListener('change', async () => {
                let newActiveSources = [...state.activeSources];
                if (checkbox.checked) {
                    if (!newActiveSources.includes(sourceName)) newActiveSources.push(sourceName);
                } else {
                    newActiveSources = newActiveSources.filter(s => s !== sourceName);
                }
                await updateActiveSources(newActiveSources);
            });

            container.appendChild(label);
        });
    }

    // --- UI UPDATES ---
    // LocalDB is the only source that has no trending support (getTrending
    // returns []), so when it's the only active source the Tendances tab
    // is dead weight. Hide the nav item + section, and if trending was
    // the active section, swap to Recherche. Returns true when trending
    // is hidden, so callers can skip loadTrending().
    function updateTrendingVisibility() {
        const onlyLocaldb = state.activeSources.length === 1 && state.activeSources[0] === 'localdb';
        const trendingNav = document.querySelector('.nav-links li[data-target="section-trending"]');
        const trendingSection = dom('section-trending');
        const searchNav = document.querySelector('.nav-links li[data-target="section-search"]');
        const searchSection = dom('section-search');
        if (!trendingNav || !trendingSection || !searchNav || !searchSection) return onlyLocaldb;

        if (onlyLocaldb) {
            trendingNav.classList.add('hidden');
            if (!trendingSection.classList.contains('hidden')) {
                hide(trendingSection);
                show(searchSection);
                trendingNav.classList.remove('active');
                searchNav.classList.add('active');
            }
        } else {
            trendingNav.classList.remove('hidden');
        }
        return onlyLocaldb;
    }

    function populateDefaultPrefs(opts) {
        const wire = (sel, items, storageKey, fallback) => {
            const node = dom(sel);
            if (!node) return;
            node.replaceChildren();

            // First entry is the "auto" sentinel — empty value means "use the
            // first available option from whatever the selection page sees".
            const autoOpt = document.createElement('option');
            autoOpt.value = '';
            autoOpt.textContent = 'Auto (premier disponible)';
            node.appendChild(autoOpt);

            (items || []).forEach(v => {
                const o = document.createElement('option');
                o.value = v;
                o.textContent = v;
                node.appendChild(o);
            });

            let saved = localStorage.getItem(storageKey);
            if (saved === null && fallback && (items || []).includes(fallback)) {
                saved = fallback;
                localStorage.setItem(storageKey, fallback);
            }
            if (saved !== null && (saved === '' || (items || []).includes(saved))) {
                node.value = saved;
            }
            node.addEventListener('change', () => {
                localStorage.setItem(storageKey, node.value);
            });
        };

        wire('setting-default-host',          opts.hosts,             'defaultHost',         '1Fichier');
        wire('setting-default-quality-movie', opts.qualities.movies,  'defaultQualityMovie', null);
        wire('setting-default-quality-series',opts.qualities.series,  'defaultQualitySeries',null);
    }

    function updateLocalDbFiltersVisibility() {
        const hasLocalDb = state.activeSources.includes('localdb');
        document.querySelectorAll('.localdb-filter').forEach(el => {
            if (hasLocalDb) {
                el.classList.remove('hidden');
            } else {
                el.classList.add('hidden');
                // If a hidden radio is checked, default back to 'film'
                const radio = el.querySelector('input[type="radio"]');
                if (radio && radio.checked) {
                    const defaultRadio = document.querySelector('input[name="search-type"][value="film"]');
                    if (defaultRadio) defaultRadio.checked = true;
                }
            }
        });
    }

    async function updateActiveSources(sources) {
        try {
            const res = await apiCall('/set-sources', 'POST', { sources });
            state.activeSources = res.activeSources;
            renderSourcesUI();
            updateLocalDbFiltersVisibility();
            const trendingHidden = updateTrendingVisibility();
            showToast('Sources mises à jour');
            if (!trendingHidden) loadTrending();
        } catch(e) {
            showToast('Erreur sources: ' + e.message);
            renderSourcesUI(); // Revert UI
        }
    }




    // --- DOWNLOADS (LIST) ---
    const loadDownloads = async () => {
        const list = dom('downloads-list');
        if (!list) return;

        try {
            const data = await apiCall('/download-status');
            list.innerHTML = '';

            if (!data || !data.length) {
                list.innerHTML = `
                    <div class="empty-state-modern">
                        <i data-lucide="hard-drive-download"></i>
                        <p>Aucun téléchargement actif</p>
                    </div>`;
                lucide.createIcons();
                return;
            }

            data.forEach(dl => {
                const item = document.createElement('div');
                item.className = 'dl-card';
                const isDone = dl.percent >= 100;
                const barColor = isDone ? 'var(--success)' : 'var(--accent)';

                item.innerHTML = `
                    <div class="dl-icon">
                        <i data-lucide="${isDone ? 'check-circle' : 'loader-2'}" class="${!isDone ? 'spin-slow' : ''}"></i>
                    </div>
                    <div class="dl-content">
                        <div class="dl-header">
                            <span class="dl-title">${dl.name}</span>
                            <span class="dl-percentage">${Math.round(dl.percent)}%</span>
                        </div>
                        <div class="dl-bar-bg">
                            <div class="dl-bar-fill" style="width: ${dl.percent}%; background: ${barColor};"></div>
                        </div>
                        <div class="dl-status-text">${isDone ? 'Terminé' : 'Téléchargement en cours...'}</div>
                    </div>
                    <button class="btn-jd-delete" title="Supprimer de JDownloader" style="background: none; border: none; color: var(--text-sec); cursor: pointer; padding: 8px; margin-left: 8px; border-radius: 8px; transition: all 0.2s;">
                        <i data-lucide="trash-2" style="width: 18px; height: 18px;"></i>
                    </button>
                `;

                // Attach delete handler
                const deleteBtn = item.querySelector('.btn-jd-delete');
                deleteBtn.onmouseover = () => { deleteBtn.style.color = '#ef4444'; deleteBtn.style.background = 'rgba(239,68,68,0.1)'; };
                deleteBtn.onmouseout = () => { deleteBtn.style.color = 'var(--text-sec)'; deleteBtn.style.background = 'none'; };
                deleteBtn.onclick = async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Supprimer "${dl.name}" de JDownloader ?`)) return;
                    try {
                        await apiCall('/jd/remove-link', 'POST', { linkIds: [dl.uuid] });
                        showToast(`🗑️ ${dl.name} supprimé`);
                        loadDownloads();
                    } catch (err) {
                        showToast('Erreur : ' + err.message);
                    }
                };

                list.appendChild(item);
            });
            lucide.createIcons();
        } catch (e) { }
    };

    dom('btn-refresh-downloads').onclick = loadDownloads;


    // --- UTILS: BLOCKING LOADER & STATE HELPERS ---
    const cleanTitle = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");


    const toggleBlockingLoader = (show, msg = "Traitement en cours...") => {
        let loader = document.getElementById('blocking-loader');
        if (!loader) {
            loader = document.createElement('div');
            loader.id = 'blocking-loader';
            loader.className = 'hidden';
            loader.innerHTML = `<div class="loader"></div><p id="blocking-msg"></p>`;
            document.body.appendChild(loader);
        }
        if (show) {
            document.getElementById('blocking-msg').textContent = msg;
            loader.classList.remove('hidden');
        } else {
            loader.classList.add('hidden');
        }
    };

    // --- PROXY IMAGE HELPER ---
    // Passe les URLs HTTPS des posters par le proxy serveur pour éviter le blocage mixed-content
    const proxyImageUrl = (url) => {
        if (!url) return '';
        // Si l'image est déjà locale ou en HTTP sur notre domaine, pas besoin de proxy
        if (url.startsWith('/') || url.startsWith('data:')) return url;
        // Proxy les URLs HTTPS via le serveur
        if (url.startsWith('https://')) {
            return `/proxy-image?url=${encodeURIComponent(url)}`;
        }
        return url;
    };

    // --- TRENDING & CARDS ---
    const createCard = (movie) => {
        const div = document.createElement('div');
        div.className = 'card';

        const posterSrc = proxyImageUrl(movie.image);

        // Build subtitle: quality + lang for ZT, year for Hydracker
        let subtitle = movie.year || '';
        let cleanedTitle = movie.title;

        // Clean ZT titles: "Show Name - Saison X [Quality]" -> "Show Name - Saison X"
        if (movie.source === 'zt') {
            const parts = [];
            
            // Extract quality info from title if present: "Title [1080p]" -> "Title"
            const titleQualityMatch = cleanedTitle.match(/(.*)\s+\[([^\]]+)\]$/);
            if (titleQualityMatch) {
                cleanedTitle = titleQualityMatch[1].trim();
                const qualityFromTitle = titleQualityMatch[2].trim();
                if (!movie.quality) movie.quality = qualityFromTitle;
            }

            if (movie.quality) parts.push(movie.quality);
            if (movie.lang) parts.push(movie.lang);
            subtitle = parts.join(' — ') || '';
        }

        const typeBadge = movie.type === 'series' || movie.type === 'anime' ? `<span class="type-badge">${movie.type === 'anime' ? 'Anime' : 'Série'}</span>` : '';

        div.innerHTML = `
            <div class="poster-container">
                <img src="${posterSrc}" loading="lazy" alt="${cleanedTitle}" onerror="this.style.display='none'">
                <div class="source-badge" style="position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.7); color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; backdrop-filter: blur(4px); border: 1px solid rgba(255,255,255,0.1);">
                    ${movie.source}
                </div>
            </div>
            <div class="card-info">
                <div class="card-title">${cleanedTitle}</div>
                <div class="card-year">${typeBadge} ${subtitle}</div>
            </div>
        `;
        div.addEventListener('click', () => handleSelection(movie));
        return div;
    };


    const renderTrending = () => {
        const grid = dom('trending-grid');
        if (!grid) return;

        const type = document.querySelector('input[name="trending-type"]:checked').value;
        const itemsToDisplay = type === 'film' ? state.trendingData.films : state.trendingData.series;

        grid.innerHTML = '';

        if (!itemsToDisplay || !itemsToDisplay.length) {
            if (dom('offline-banner') && dom('offline-banner').textContent.includes('Aucune source configurée')) {
                grid.innerHTML = `
                    <div style="grid-column: 1/-1; text-align: center; padding: 4rem 2rem; color: var(--text-sec);">
                        <i data-lucide="settings-2" style="width: 48px; height: 48px; margin-bottom: 1.5rem; opacity: 0.5;"></i>
                        <h3 style="color: white; margin-bottom: 0.5rem;">Aucune source configurée</h3>
                        <p style="margin-bottom: 2rem; max-width: 400px; margin-left: auto; margin-right: auto;">
                            Pour afficher du contenu, activez au moins une source dans les paramètres. ZT est recommandé par défaut.
                        </p>
                        <button class="btn-primary" onclick="document.querySelector('[data-target=\'section-settings\']').click()" style="padding: 10px 24px;">
                            Aller aux Paramètres
                        </button>
                    </div>`;
                lucide.createIcons();
            } else {
                grid.innerHTML = '<p style="padding:1rem">Aucune tendance trouvée.</p>';
            }
            return;
        }

        itemsToDisplay.forEach(m => grid.appendChild(createCard(m)));
    };

    const loadTrending = async () => {
        const grid = dom('trending-grid');
        if (!grid) return;

        try {
            const data = await apiCall('/trending');

            // Mise à jour de la bannière si le site est down
            updateSiteStatusUI(data.isSiteOffline, data.siteOfflineMessage);

            state.trendingData = data;

            // Si le serveur n'a pas encore fini de scrapper au démarrage
            if (data.films.length === 0 && data.series.length === 0) {
                grid.innerHTML = `
                    <div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--text-sec);">
                        <div class="loader"></div>
                        <p>Le serveur prépare les tendances, un instant...</p>
                    </div>`;
                setTimeout(loadTrending, 3000); // On réessaye dans 3 secondes
                return;
            }

            renderTrending();
        } catch (e) {
            console.error("Erreur tendances:", e);
            grid.innerHTML = '<p style="padding:1rem; color: #e50914;">⚠️ Erreur de liaison avec le serveur.</p>';
        }
    };

    document.querySelectorAll('input[name="trending-type"]').forEach(radio => {
        radio.addEventListener('change', renderTrending);
    });

    // --- SEARCH ---
    const searchInput = dom('search-input');
    const searchRadios = document.querySelectorAll('input[name="search-type"]');
    let searchTimeout = null;

    const performSearch = async () => {
        const q = searchInput ? searchInput.value.trim() : '';
        const grid = dom('search-results');
        if (!q) {
            if (grid) grid.innerHTML = '';
            return;
        }

        // ZT requires min 4 characters
        if (state.activeSources.includes('zt') && state.activeSources.length === 1 && q.length < 4) {
            if (grid) grid.innerHTML = '<p style="padding:1rem; opacity:0.7;">Minimum 4 caractères pour la recherche sur ZT.</p>';
            return;
        }
        
        const typeEl = document.querySelector('input[name="search-type"]:checked');
        const type = typeEl ? typeEl.value : 'film';
        
        if (grid) grid.innerHTML = '<div class="loader-wrapper"><div class="loader"></div></div>';
        
        try {
            const res = await apiCall('/search', 'POST', { title: q, mediaType: type });
            // Vérification si la recherche n'a pas changé entre temps
            if (searchInput.value.trim() !== q) return;
            
            if (grid) {
                grid.innerHTML = '';
                if (!res || !res.length) {
                    if (dom('offline-banner') && dom('offline-banner').textContent.includes('Aucune source configurée')) {
                        grid.innerHTML = '<p style="padding:1rem; opacity:0.7;">Veuillez configurer une source dans les paramètres.</p>';
                    } else {
                        grid.innerHTML = '<p style="padding:1rem; opacity:0.7;">Aucun résultat.</p>';
                    }
                }
                else res.forEach(m => grid.appendChild(createCard(m)));
            }
        } catch (e) {
            if (grid) grid.innerHTML = `<p style="padding:1rem; color:#ef4444;">Erreur: ${e.message}</p>`;
        }
    };

    if (searchInput) {
        // Recherche instantanée avec debounce
        searchInput.addEventListener('input', () => {
            if (searchTimeout) clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                performSearch();
            }, 500); // 500ms d'attente
        });

        // Entrée pour valider immédiatement
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (searchTimeout) clearTimeout(searchTimeout);
                performSearch();
            }
        });
    }

    // Relancer la recherche si on change de filtre (Film/Série)
    searchRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (searchInput && searchInput.value.trim().length > 0) {
                if (searchTimeout) clearTimeout(searchTimeout);
                performSearch();
            }
        });
    });

    // --- SELECTION PAGE (replaces the old modal flow) ---
    const selectionState = {
        items: new Map(),
        previousSectionId: 'section-search'
    };

    const showSelectionPage = () => {
        const active = document.querySelector('.section:not(.hidden)');
        if (active && active.id !== 'section-selection') {
            selectionState.previousSectionId = active.id;
        }
        document.querySelectorAll('.section').forEach(s => hide(s));
        show(dom('section-selection'));
        document.querySelectorAll('.nav-links li').forEach(l => l.classList.remove('active'));
    };

    const resetSelection = () => {
        selectionState.items.clear();
        updateSelectionActionBar();
    };

    const BULK_LINKS_MAX = 50;

    const updateSelectionActionBar = () => {
        const bar = dom('selection-action-bar');
        const count = selectionState.items.size;
        const label = dom('selection-action-count');
        const btn = dom('btn-selection-get-all');
        const over = count > BULK_LINKS_MAX;

        if (label) {
            if (over) {
                label.textContent = `${count} sélectionnés — max ${BULK_LINKS_MAX} par requête`;
                label.style.color = 'var(--accent-red, #ff5252)';
            } else {
                label.textContent = `${count} sélectionné${count > 1 ? 's' : ''}`;
                label.style.color = '';
            }
        }
        if (btn) {
            btn.disabled = over;
            btn.title = over ? `Désélectionnez-en ${count - BULK_LINKS_MAX} pour continuer.` : '';
        }
        if (count > 0) show(bar); else hide(bar);
    };

    const renderLoader = (parent) => {
        parent.replaceChildren();
        const wrap = document.createElement('div');
        wrap.className = 'loader-wrapper';
        const sp = document.createElement('div');
        sp.className = 'loader';
        wrap.appendChild(sp);
        parent.appendChild(wrap);
    };

    const handleSelection = async (movie) => {
        showSelectionPage();
        dom('selection-title').textContent = movie.title;
        const body = dom('selection-body');
        renderLoader(body);
        dom('selection-results').classList.add('hidden');
        dom('selection-results').replaceChildren();
        resetSelection();
        try {
            let ep = '/select-movie';
            if (movie.source === 'hydracker' && movie.hrefPath && movie.hrefPath.includes('download')) {
                ep = '/select-trending';
            }
            const data = await apiCall(ep, 'POST', { hrefPath: movie.hrefPath || '', title: movie.title, type: movie.type, source: movie.source });
            renderModalOptions(data, movie.title, movie.source, {
                container: body,
                multiSelect: true,
                onSelectionChange: updateSelectionActionBar
            });
            if (window.lucide) window.lucide.createIcons();
        } catch (e) {
            body.replaceChildren();
            const err = document.createElement('p');
            err.style.color = 'red';
            err.style.padding = '1rem';
            err.textContent = e.message;
            body.appendChild(err);
        }
    };

    function parseSizeToMB(sizeStr) {
        if (!sizeStr || sizeStr === 'N/A') return 0;
        const match = sizeStr.match(/([\d.,]+)\s*(gb|go|mb|mo|ko|kb|tb|to)/i);
        if (!match) return 0;
        let size = parseFloat(match[1].replace(',', '.'));
        const unit = match[2].toLowerCase();
        if (unit.includes('gb') || unit.includes('go')) size *= 1024;
        else if (unit.includes('tb')) size *= 1024 * 1024;
        else if (unit.includes('kb') || unit.includes('ko')) size /= 1024;
        return size;
    }

    const getQualityRank = (qualityString) => {
        const lower = qualityString.toLowerCase();
        if (lower.includes("ultra hdlight") && lower.includes("x265")) return 1;
        if (lower.includes("1080p") && lower.includes("x265") || lower.includes("1080p light") || lower.includes("x265")) return 2;
        return 3;
    };

    const renderModalOptions = (data, currentTitle = '', source = '', opts = {}) => {
        const body = opts.container || dom('modal-body');
        const multiSelect = opts.multiSelect === true;
        const onSelectionChange = typeof opts.onSelectionChange === 'function' ? opts.onSelectionChange : null;
        if (multiSelect && selectionState && selectionState.items) {
            selectionState.items.clear();
            if (onSelectionChange) onSelectionChange();
        }
        body.innerHTML = '';

        // --- 0. TYPE DETECTION ---
        const hasSaisonLabel = data.seasons && data.seasons.some(s => s.label.toLowerCase().includes('saison'));
        const hasNumericEpisodes = data.clientOptions && data.clientOptions.some(q => {
            if (!q.episode) return false;
            const lowEp = q.episode.toLowerCase();
            if (lowEp.includes('saison complète') || lowEp.includes('intégrale') || lowEp.includes('pack')) return false;
            // Si c'est un nombre ou contient "Ep", c'est une série
            return /^\d+$/.test(q.episode) || lowEp.includes('ep');
        });
        const isActuallySeries = hasSaisonLabel || hasNumericEpisodes;


        // --- 1. SAISONS / VERSIONS ---
        if (data.seasons && data.seasons.length > 0) {
            const h4 = document.createElement('h4');
            h4.textContent = isActuallySeries ? "Saisons disponibles" : "Qualités & Versions";
            h4.className = "modal-subtitle";
            body.appendChild(h4);

            // Flatten labels — handles ZT's occasional "Saison 1 Saison 2"-style joined labels.
            const flatOptions = [];
            data.seasons.forEach(s => {
                let labelsToProcess = [];
                if ((s.label.match(/Saison/ig) || []).length > 1) {
                    labelsToProcess = s.label.split(/(?=Saison\s*\d+)/i).filter(Boolean);
                } else {
                    labelsToProcess = [s.label];
                }
                labelsToProcess.forEach(label => {
                    flatOptions.push({ fullLabel: label.trim(), value: s.value });
                });
            });

            // Common handler for both UIs.
            const onSeasonChosen = async (selectedValue, displayLabel) => {
                renderLoader(body);
                try {
                    const res = await apiCall('/select-season', 'POST', { seasonValue: selectedValue });
                    res.seasons = data.seasons;

                    const baseTitle = currentTitle.split(' - ')[0];
                    const newTitle = displayLabel ? `${baseTitle} - ${displayLabel}` : currentTitle;

                    const selectionTitleEl = dom('selection-title');
                    if (selectionTitleEl) selectionTitleEl.textContent = newTitle;
                    const modalTitleEl = dom('modal-title');
                    if (modalTitleEl) modalTitleEl.textContent = newTitle;

                    renderModalOptions(res, newTitle, source, opts);
                    if (window.lucide) window.lucide.createIcons();
                } catch (e) {
                    body.replaceChildren();
                    const errP = document.createElement('p');
                    errP.style.color = 'red';
                    errP.style.padding = '1rem';
                    errP.textContent = `Erreur: ${e.message}`;
                    body.appendChild(errP);
                }
            };

            if (isActuallySeries) {
                // Series: single <select> dropdown, auto-select Saison 1 (or the
                // first option as a fallback when "Saison 1" isn't present).
                const wrap = document.createElement('div');
                wrap.className = 'season-select-wrap';

                const select = document.createElement('select');
                select.className = 'season-select';
                select.setAttribute('aria-label', 'Saison');

                flatOptions.forEach((opt, i) => {
                    const o = document.createElement('option');
                    o.value = String(i); // stable index — opt.value can be a URL/number
                    o.textContent = opt.fullLabel;
                    select.appendChild(o);
                });

                let preferIdx = flatOptions.findIndex(o => /(^|\s)Saison\s*0*1(\b|$)/i.test(o.fullLabel) || o.value === 1 || o.value === '1');
                if (preferIdx < 0) preferIdx = 0;
                select.selectedIndex = preferIdx;

                select.addEventListener('change', () => {
                    const idx = parseInt(select.value, 10);
                    const opt = flatOptions[idx];
                    if (!opt) return;
                    const seasonMatch = opt.fullLabel.match(/^(Saison\s*\d+)/i);
                    const display = seasonMatch ? seasonMatch[1].trim() : opt.fullLabel;
                    onSeasonChosen(opt.value, display);
                });

                wrap.appendChild(select);
                body.appendChild(wrap);
            } else {
                // Movies / quality versions: keep the grouped pill layout — each
                // group is a quality bucket the user picks one variant from.
                const groupedSeasons = new Map();
                flatOptions.forEach(({ fullLabel: cleanLabel, value }) => {
                    const seasonMatch = cleanLabel.match(/^(Saison\s*\d+)(.*)$/i);
                    let groupName = "Versions";
                    let subLabel = cleanLabel;
                    if (seasonMatch) {
                        groupName = seasonMatch[1].trim();
                        subLabel = seasonMatch[2].trim() || "Standard";
                    } else if (cleanLabel.toLowerCase().includes('intégrale')) {
                        groupName = "Intégrales";
                    } else if (cleanLabel.toLowerCase().includes('saison')) {
                        groupName = cleanLabel;
                        subLabel = "Pack";
                    }
                    if (!groupedSeasons.has(groupName)) groupedSeasons.set(groupName, []);
                    groupedSeasons.get(groupName).push({ label: subLabel, fullLabel: cleanLabel, value });
                });

                groupedSeasons.forEach((options, groupName) => {
                    const groupDiv = document.createElement('div');
                    groupDiv.className = "season-group";

                    const titleDiv = document.createElement('div');
                    titleDiv.className = "season-group-title";
                    titleDiv.textContent = groupName;
                    groupDiv.appendChild(titleDiv);

                    const grid = document.createElement('div');
                    grid.className = "seasons-grid";

                    options.forEach(opt => {
                        const btn = document.createElement('button');
                        btn.className = 'quality-pill';
                        const span = document.createElement('span');
                        span.textContent = opt.label;
                        btn.appendChild(span);
                        btn.title = opt.fullLabel;
                        btn.onclick = () => {
                            const display = (groupName.startsWith('Saison') || groupName.startsWith('Intégrale')) ? groupName : '';
                            onSeasonChosen(opt.value, display);
                        };
                        grid.appendChild(btn);
                    });

                    groupDiv.appendChild(grid);
                    body.appendChild(groupDiv);
                });
            }

            const sep = document.createElement('hr');
            sep.className = 'modal-sep';
            body.appendChild(sep);
        }


        // --- 2. FILES ---
        if (!data.clientOptions || !data.clientOptions.length) {
            body.innerHTML += '<p class="empty-msg">Aucun fichier disponible.</p>';
            return;
        }

        const MAX_FILM_SIZE_MB = 45360;

        const enriched = data.clientOptions.map(q => {
            const lowEp = q.episode ? q.episode.toLowerCase() : '';
            const isFullSeason = lowEp.includes('saison complète') || lowEp.includes('intégrale') || lowEp.includes('pack') ? 1 : 0;
            return {
                ...q,
                sizeVal: parseSizeToMB(q.size),
                rank: getQualityRank(q.quality),
                isFullSeason
            };
        })
.filter(q => {
            if (!isActuallySeries) return q.sizeVal <= MAX_FILM_SIZE_MB;
            return true;
        }).sort((a, b) => {
            // Saison complète packs first, then for series we want strict
            // episode-number order (E01, E02, …) — that's what the user
            // expects when scanning the table. Quality rank and size are
            // tertiary tiebreakers within the same episode.
            if (a.isFullSeason !== b.isFullSeason) return b.isFullSeason - a.isFullSeason;
            if (isActuallySeries) {
                const aEp = a.episodeNumber || 0;
                const bEp = b.episodeNumber || 0;
                if (aEp !== bEp) return aEp - bEp;
            }
            if (a.rank !== b.rank) return a.rank - b.rank;
            return (b.sizeBytes || 0) - (a.sizeBytes || 0);
        });

        if (enriched.length === 0) {
            body.innerHTML += '<p class="empty-msg">Aucun fichier disponible.</p>';
            return;
        }

        // --- 2a. QUALITY + HOST FILTER DROPDOWNS ---
        const allVersions = [...new Set(enriched.map(q => q.quality || 'Inconnu'))];

        const h4files = document.createElement('h4');
        h4files.textContent = "Fichiers Disponibles";
        h4files.className = "modal-subtitle";
        body.appendChild(h4files);

        // Pick the initial quality from the user's settings preference if it
        // exists in the current dataset; fall back to the first available.
        const qualityPrefKey = isActuallySeries ? 'defaultQualitySeries' : 'defaultQualityMovie';
        const savedQuality = localStorage.getItem(qualityPrefKey);
        let activeVersion = (savedQuality && allVersions.includes(savedQuality))
            ? savedQuality
            : allVersions[0];

        const filterRow = document.createElement('div');
        filterRow.className = 'selection-filters';
        body.appendChild(filterRow);

        const buildFilter = (labelText, sel) => {
            const wrap = document.createElement('div');
            wrap.className = 'selection-filter';
            const label = document.createElement('label');
            label.textContent = labelText;
            label.htmlFor = sel.id;
            wrap.appendChild(label);
            wrap.appendChild(sel);
            return wrap;
        };

        const qualitySelect = document.createElement('select');
        qualitySelect.className = 'season-select';
        qualitySelect.id = 'filter-quality';
        allVersions.forEach(v => {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = v;
            qualitySelect.appendChild(o);
        });
        qualitySelect.value = activeVersion;
        filterRow.appendChild(buildFilter('Qualité', qualitySelect));

        const hostSelect = document.createElement('select');
        hostSelect.className = 'season-select';
        hostSelect.id = 'filter-host';
        filterRow.appendChild(buildFilter('Hébergeur', hostSelect));

        const filesContainer = document.createElement('div');
        filesContainer.className = 'files-list';
        body.appendChild(filesContainer);

        // Refresh host options every time the quality changes — hosts available
        // for "Blu-Ray 1080p" aren't necessarily the same as for "WEB-DL 720p".
        const refreshHostOptions = () => {
            const subset = enriched.filter(q => (q.quality || 'Inconnu') === qualitySelect.value);
            const hosts = [...new Set(subset.map(q => q.host || 'Inconnu'))].sort();
            hostSelect.replaceChildren();
            const all = document.createElement('option');
            all.value = '';
            all.textContent = 'Tous';
            hostSelect.appendChild(all);
            hosts.forEach(h => {
                const o = document.createElement('option');
                o.value = h;
                o.textContent = h;
                hostSelect.appendChild(o);
            });
            const preferred = localStorage.getItem('defaultHost') || '1Fichier';
            hostSelect.value = hosts.includes(preferred) ? preferred : '';
        };

        const renderSeriesTable = (parent, items) => {
            // Detect which optional columns have any data — empty ones are
            // hidden so plugins that don't populate the richer metadata
            // (e.g. ZT) still get a tidy table.
            const has = {
                name: items.some(q => q.episodeName),
                audio: items.some(q => (q.audioLangs && q.audioLangs.length) || (q.langs && q.langs.some(l => !String(l).startsWith('Subs:')))),
                sub: items.some(q => q.subLangs && q.subLangs.length),
            };

            // Duplicate detection: group by episode (or "saison complète"),
            // then mark cells that differ within a multi-row group.
            const groups = new Map();
            items.forEach(item => {
                const key = item.isFullSeason
                    ? 'full'
                    : (item.episodeNumber ? `ep${item.episodeNumber}` : `raw${item.episode || ''}`);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(item);
            });
            const diffMap = new Map();
            const accessors = {
                size:  i => i.size || '',
                host:  i => i.host || '',
                audio: i => (i.audioLangs && i.audioLangs.length)
                    ? i.audioLangs.join(',')
                    : (i.langs || []).filter(l => !String(l).startsWith('Subs:')).join(','),
                sub:   i => (i.subLangs && i.subLangs.length) ? i.subLangs.join(',') : '',
            };
            for (const group of groups.values()) {
                if (group.length < 2) continue;
                for (const [col, acc] of Object.entries(accessors)) {
                    const values = new Set(group.map(acc));
                    if (values.size > 1) {
                        group.forEach(item => {
                            const k = String(item.id);
                            if (!diffMap.has(k)) diffMap.set(k, new Set());
                            diffMap.get(k).add(col);
                        });
                    }
                }
            }

            const table = document.createElement('table');
            table.className = 'episodes-table';

            // Header
            const thead = document.createElement('thead');
            const trHead = document.createElement('tr');
            let headerCb = null;
            if (multiSelect) {
                const thSel = document.createElement('th');
                thSel.className = 'col-sel';
                headerCb = document.createElement('input');
                headerCb.type = 'checkbox';
                headerCb.title = 'Tout sélectionner';
                thSel.appendChild(headerCb);
                trHead.appendChild(thSel);
            }
            // Qualité is intentionally omitted — the table is already filtered
            // by the quality dropdown above, so the column would only ever
            // hold the same value.
            const cols = [
                { label: 'Épisode', cls: 'col-ep' },
                ...(has.name  ? [{ label: 'Titre',       cls: 'col-name' }]    : []),
                { label: 'Taille',  cls: 'col-size' },
                ...(has.audio ? [{ label: 'Audio',       cls: 'col-audio' }]   : []),
                ...(has.sub   ? [{ label: 'Sous-titres', cls: 'col-sub' }]     : []),
                { label: 'Hôte',   cls: 'col-host' },
                { label: '',       cls: 'col-action' },
            ];
            cols.forEach(c => {
                const th = document.createElement('th');
                th.className = c.cls;
                th.textContent = c.label;
                trHead.appendChild(th);
            });
            thead.appendChild(trHead);
            table.appendChild(thead);

            // Body
            const tbody = document.createElement('tbody');
            table.appendChild(tbody);
            const rowSetters = [];

            items.forEach(q => {
                const tr = document.createElement('tr');
                tr.dataset.id = q.id != null ? String(q.id) : '';
                const diffs = diffMap.get(tr.dataset.id) || new Set();

                let setSelected = null;
                let rowCb = null;
                if (multiSelect) {
                    const tdSel = document.createElement('td');
                    tdSel.className = 'col-sel';
                    rowCb = document.createElement('input');
                    rowCb.type = 'checkbox';
                    rowCb.dataset.id = tr.dataset.id;
                    rowCb.checked = selectionState.items.has(rowCb.dataset.id);
                    if (rowCb.checked) tr.classList.add('is-selected');

                    setSelected = (on) => {
                        rowCb.checked = on;
                        tr.classList.toggle('is-selected', on);
                        if (!rowCb.dataset.id) return;
                        if (on) {
                            selectionState.items.set(rowCb.dataset.id, {
                                id: rowCb.dataset.id,
                                host: q.host || '',
                                quality: q.quality || '',
                                episode: q.episode || '',
                                episodeNumber: q.episodeNumber || 0,
                                isFullSeason: !!q.isFullSeason
                            });
                        } else {
                            selectionState.items.delete(rowCb.dataset.id);
                        }
                        if (onSelectionChange) onSelectionChange();
                        updateHeaderState();
                    };
                    rowCb.addEventListener('change', () => setSelected(rowCb.checked));
                    tdSel.appendChild(rowCb);
                    tr.appendChild(tdSel);
                    rowSetters.push({ cb: rowCb, setSelected });
                }

                // Épisode
                const epTd = document.createElement('td');
                epTd.className = 'col-ep';
                if (q.isFullSeason) {
                    const badge = document.createElement('span');
                    badge.className = 'ep-badge ep-badge-full';
                    badge.textContent = '📦 Saison complète';
                    epTd.appendChild(badge);
                } else if (q.episodeNumber) {
                    const badge = document.createElement('span');
                    badge.className = 'ep-badge';
                    badge.textContent = `Ep. ${String(q.episodeNumber).padStart(2, '0')}`;
                    epTd.appendChild(badge);
                } else {
                    epTd.textContent = q.episode || '—';
                }
                tr.appendChild(epTd);

                if (has.name) {
                    const td = document.createElement('td');
                    td.className = 'col-name';
                    td.textContent = q.episodeName || '—';
                    tr.appendChild(td);
                }

                const sizeTd = document.createElement('td');
                sizeTd.className = 'col-size';
                sizeTd.textContent = (q.size && q.size !== 'N/A') ? q.size : '—';
                if (diffs.has('size')) sizeTd.classList.add('cell-diff');
                tr.appendChild(sizeTd);

                if (has.audio) {
                    const td = document.createElement('td');
                    td.className = 'col-audio';
                    const audios = (q.audioLangs && q.audioLangs.length)
                        ? q.audioLangs
                        : (q.langs || []).filter(l => !String(l).startsWith('Subs:'));
                    td.textContent = audios.length ? audios.join(', ') : '—';
                    if (diffs.has('audio')) td.classList.add('cell-diff');
                    tr.appendChild(td);
                }

                if (has.sub) {
                    const td = document.createElement('td');
                    td.className = 'col-sub';
                    td.textContent = (q.subLangs && q.subLangs.length) ? q.subLangs.join(', ') : '—';
                    if (diffs.has('sub')) td.classList.add('cell-diff');
                    tr.appendChild(td);
                }

                const hostTd = document.createElement('td');
                hostTd.className = 'col-host';
                hostTd.textContent = q.host || '—';
                if (diffs.has('host')) hostTd.classList.add('cell-diff');
                tr.appendChild(hostTd);

                const actTd = document.createElement('td');
                actTd.className = 'col-action';
                const dlBtn = document.createElement('button');
                dlBtn.className = 'btn-action btn-dl';
                dlBtn.title = 'Télécharger';
                const icon = document.createElement('i');
                icon.setAttribute('data-lucide', 'download');
                icon.style.width = '16px';
                icon.style.height = '16px';
                dlBtn.appendChild(icon);
                dlBtn.onclick = async (e) => {
                    e.stopPropagation();
                    toggleBlockingLoader(true, "Récupération du lien...");
                    try {
                        const useJD = document.getElementById('toggle-jd') ? document.getElementById('toggle-jd').checked : true;
                        const result = await apiCall('/get-link', 'POST', { chosenId: q.id, useJD });
                        toggleBlockingLoader(false);
                        if (useJD && result.jdSent) {
                            showToast('Lien envoyé à JDownloader !');
                            document.querySelector('.nav-links li[data-target="section-downloads"]').click();
                        } else {
                            showDirectLinkModal(result.link);
                        }
                    } catch (err) {
                        toggleBlockingLoader(false);
                        showToast("Erreur: " + err.message);
                    }
                };
                actTd.appendChild(dlBtn);
                tr.appendChild(actTd);

                if (multiSelect && setSelected && rowCb) {
                    tr.addEventListener('click', (e) => {
                        if (e.target.closest('button')) return;
                        if (e.target === rowCb) return;
                        setSelected(!rowCb.checked);
                    });
                }

                tbody.appendChild(tr);
            });

            const updateHeaderState = () => {
                if (!headerCb) return;
                const cbs = tbody.querySelectorAll('input[type="checkbox"]');
                if (!cbs.length) { headerCb.checked = false; headerCb.indeterminate = false; return; }
                const checked = Array.from(cbs).filter(c => c.checked).length;
                if (checked === 0) { headerCb.checked = false; headerCb.indeterminate = false; }
                else if (checked === cbs.length) { headerCb.checked = true; headerCb.indeterminate = false; }
                else { headerCb.checked = false; headerCb.indeterminate = true; }
            };
            if (multiSelect && headerCb) {
                headerCb.addEventListener('change', () => {
                    const target = headerCb.checked;
                    rowSetters.forEach(({ cb, setSelected }) => {
                        if (cb.checked !== target) setSelected(target);
                    });
                    updateHeaderState();
                });
                updateHeaderState();
            }

            parent.appendChild(table);
            if (window.lucide) window.lucide.createIcons();
        };

        const renderFiles = () => {
            filesContainer.replaceChildren();
            const selectedQuality = qualitySelect.value;
            const selectedHost = hostSelect.value;
            const toShow = enriched.filter(q =>
                (q.quality || 'Inconnu') === selectedQuality &&
                (!selectedHost || (q.host || 'Inconnu') === selectedHost)
            );

            if (toShow.length === 0) {
                const p = document.createElement('p');
                p.className = 'empty-msg';
                p.textContent = 'Aucun fichier pour cette combinaison qualité / hébergeur.';
                filesContainer.appendChild(p);
                return;
            }

            if (isActuallySeries) {
                renderSeriesTable(filesContainer, toShow);
                return;
            }

            // Group by host
            const hostGroups = new Map();
            toShow.forEach(q => {
                const hostKey = q.host || 'inconnu';
                if (!hostGroups.has(hostKey)) hostGroups.set(hostKey, []);
                hostGroups.get(hostKey).push(q);
            });

            hostGroups.forEach((items, hostName) => {
                // Host Header
                const hostHeader = document.createElement('div');
                hostHeader.className = "season-group-title";
                hostHeader.style.marginTop = "1rem";
                
                // Friendly host name
                const hostDisplay = hostName
                    .replace(/\.(png|jpg|webp|gif)$/i, '')
                    .replace(/[-_]/g, ' ')
                    .toUpperCase();
                
                hostHeader.textContent = hostDisplay;
                filesContainer.appendChild(hostHeader);

                
                const itemsGrid = document.createElement('div');
                itemsGrid.className = isActuallySeries ? "seasons-grid" : "files-list";
                filesContainer.appendChild(itemsGrid);

                items.forEach((q, idx) => {
                    const row = document.createElement('div');
                    let specialClass = '';
                    let rankIcon = '';
                    
                    if (q.isFullSeason) { specialClass = 'quality-gold'; rankIcon = '📦'; }
                    else if (q.rank === 1) { specialClass = 'quality-gold'; rankIcon = '⭐'; }
                    else if (q.rank === 2) { specialClass = 'quality-blue'; rankIcon = '✨'; }

                    const episodeLabel = q.episode
                        ? (q.isFullSeason || !/^\d+$/.test(q.episode) ? q.episode : `Ep. ${q.episode}`)
                        : "Télécharger";

                    // On vérifie si la source est Hydracker
                    const isHydracker = source === 'hydracker';

                    if (isActuallySeries) {
                        row.className = `quality-pill ${specialClass}`;
                        row.style.display = 'flex';
                        row.style.justifyContent = 'space-between';
                        row.style.alignItems = 'center';
                        row.style.padding = "8px 14px";
                        row.style.cursor = "default";
                        
                        let buttonsHtml = '';
                        if (isHydracker) {
                            buttonsHtml = `
                                <div style="display: flex; gap: 6px; align-items: center;">
                                    <button class="btn-action btn-movix" title="Lien Direct (Movix)" style="background: rgba(139, 92, 246, 0.2); border: 1px solid rgba(139, 92, 246, 0.5); color: #8b5cf6; border-radius: 6px; padding: 4px 8px; cursor: pointer; display: flex; align-items: center; transition: all 0.2s;">
                                        <i data-lucide="zap" style="width: 16px; height: 16px;"></i>
                                    </button>
                                    <button class="btn-action btn-dl" title="Télécharger classique" style="background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.1); color: white; border-radius: 6px; padding: 4px 8px; cursor: pointer; display: flex; align-items: center; transition: all 0.2s;">
                                        <i data-lucide="download" style="width: 16px; height: 16px;"></i>
                                    </button>
                                </div>
                            `;
                        } else {
                            buttonsHtml = `
                                <button class="btn-action btn-dl" title="Télécharger" style="background: transparent; border: none; color: white; cursor: pointer; display: flex; align-items: center;">
                                    <i data-lucide="download" style="width: 18px; height: 18px;"></i>
                                </button>
                            `;
                        }

                        row.innerHTML = `
                            <div style="display: flex; align-items: center;">
                                ${rankIcon ? `<span style="margin-right:5px">${rankIcon}</span>` : ''}
                                <span>${episodeLabel}</span>
                            </div>
                            ${buttonsHtml}
                        `;
                    } else {
                        row.className = `file-btn ${specialClass}`;
                        row.style.cursor = "default";
                        row.style.display = 'flex';
                        row.style.justifyContent = 'space-between';
                        row.style.alignItems = 'center';

                        const mirrorLabel = items.length > 1 ? ` <span class="mirror-tag">Miroir ${idx + 1}</span>` : '';
                        
                        let buttonsHtml = '';
                        if (isHydracker) {
                            buttonsHtml = `
                                <div class="file-btn-right" style="display: flex; gap: 8px; align-items: center;">
                                    <button class="btn-action btn-movix" title="Lien Direct (Movix)" style="background: rgba(139, 92, 246, 0.15); border: 1px solid #8b5cf6; color: #8b5cf6; padding: 6px 12px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-weight: 600; transition: all 0.2s;">
                                        <i data-lucide="zap" style="width: 16px; height: 16px;"></i> Direct
                                    </button>
                                    <button class="btn-action btn-dl" title="Télécharger classique" style="background: rgba(255, 255, 255, 0.1); border: none; color: white; padding: 6px 12px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; transition: all 0.2s;">
                                        <i data-lucide="download" style="width: 16px; height: 16px;"></i>
                                    </button>
                                </div>
                            `;
                        } else {
                            buttonsHtml = `
                                <div class="file-btn-right">
                                    <button class="btn-action btn-dl" title="Télécharger" style="background: transparent; border: none; color: white; cursor: pointer;">
                                        <i data-lucide="download" class="dl-icon-btn"></i>
                                    </button>
                                </div>
                            `;
                        }

                        row.innerHTML = `
                            <div class="file-btn-left">
                                <div class="file-host">
                                    ${rankIcon ? `<span class="rank-icon">${rankIcon}</span>` : ''}
                                    <span class="host-name">${hostDisplay}</span>
                                    ${mirrorLabel}
                                    ${q.episode ? `<span class="episode-tag">${q.episode}</span>` : ''}
                                </div>
                                <div class="file-size">${q.size && q.size !== 'N/A' ? q.size : 'Taille inconnue'}</div>
                            </div>
                            ${buttonsHtml}
                        `;
                    }

                    // On attache l'event listener Movix UNIQUEMENT si on est sur Hydracker
                    if (isHydracker) {
                        row.querySelector('.btn-movix').onclick = async (e) => {
                            e.stopPropagation();
                            hide(dom('modal-overlay'));
                            toggleBlockingLoader(true, "Débridage Movix en cours...");
                            try {
                                const result = await apiCall(`/movix-decode/${q.id}`, 'GET');
                                toggleBlockingLoader(false);

                                if (result.link) {
                                    showModal('Lien Direct Movix', `
                                        <div class="direct-link-box">
                                            <p style="margin-bottom: 10px;">Voici votre lien direct rapide :</p>
                                            <input type="text" value="${result.link}" readonly id="direct-link-input" style="width: 100%; margin-bottom: 15px;">
                                            <div class="btn-group" style="display: flex; gap: 10px;">
                                                <button class="btn-primary" style="flex: 1;" onclick="document.getElementById('direct-link-input').select(); document.execCommand('copy'); showToast('Copié !')">Copier</button>
                                                <a href="${result.link}" target="_blank" class="btn-success" style="flex: 1; text-align: center; text-decoration: none; display: inline-block;">Ouvrir</a>
                                            </div>
                                        </div>
                                    `);
                                }
                            } catch (err) {
                                toggleBlockingLoader(false);
                                showToast("Erreur Movix: " + err.message);
                                show(dom('modal-overlay'));
                            }
                        };
                    }

                    // L'event listener classique fonctionne pour toutes les sources
                    row.querySelector('.btn-dl').onclick = async (e) => {
                        e.stopPropagation();
                        hide(dom('modal-overlay'));
                        toggleBlockingLoader(true, "Récupération du lien...");
                        try {
                            const useJD = document.getElementById('toggle-jd') ? document.getElementById('toggle-jd').checked : true;
                            const result = await apiCall('/get-link', 'POST', { chosenId: q.id, useJD });
                            toggleBlockingLoader(false);

                            // Only follow the JD path if the server confirmed the .crawljob
                            // was actually written. Otherwise fall through and show the
                            // direct link so the user can copy/open it manually.
                            if (useJD && result.jdSent) {
                                showToast('Lien envoyé à JDownloader !');
                                document.querySelector('.nav-links li[data-target="section-downloads"]').click();
                            } else {
                                showModal('Lien Direct', `
                                    <div class="direct-link-box">
                                        <p style="margin-bottom: 10px;">Voici votre lien de téléchargement :</p>
                                        <input type="text" value="${result.link}" readonly id="direct-link-input" style="width: 100%; margin-bottom: 15px;">
                                        <div class="btn-group" style="display: flex; gap: 10px;">
                                            <button class="btn-primary" style="flex: 1;" onclick="document.getElementById('direct-link-input').select(); document.execCommand('copy'); showToast('Copié !')">Copier</button>
                                            <a href="${result.link}" target="_blank" class="btn-success" style="flex: 1; text-align: center; text-decoration: none; display: inline-block;">Ouvrir</a>
                                        </div>
                                    </div>
                                `);
                            }
                        } catch (err) {
                            toggleBlockingLoader(false);
                            showToast("Erreur: " + err.message);
                            show(dom('modal-overlay'));
                        }
                    };
                    
                    row.querySelectorAll('.btn-action').forEach(b => {
                        b.addEventListener('mouseover', () => b.style.transform = 'scale(1.05)');
                        b.addEventListener('mouseout', () => b.style.transform = 'scale(1)');
                    });

                    if (multiSelect) {
                        const wrap = document.createElement('div');
                        wrap.className = 'file-row-select';
                        const cb = document.createElement('input');
                        cb.type = 'checkbox';
                        cb.dataset.id = q.id != null ? String(q.id) : '';
                        const initiallyChecked = selectionState.items.has(cb.dataset.id);
                        cb.checked = initiallyChecked;
                        if (initiallyChecked) wrap.classList.add('is-selected');
                        const main = document.createElement('div');
                        main.className = 'row-main';
                        main.appendChild(row);
                        wrap.appendChild(cb);
                        wrap.appendChild(main);

                        const setSelected = (on) => {
                            if (!cb.dataset.id) return;
                            cb.checked = on;
                            wrap.classList.toggle('is-selected', on);
                            if (on) {
                                selectionState.items.set(cb.dataset.id, {
                                    id: cb.dataset.id,
                                    host: q.host || '',
                                    quality: q.quality || '',
                                    episode: q.episode || '',
                                    episodeNumber: q.episodeNumber || 0,
                                    isFullSeason: !!q.isFullSeason
                                });
                            } else {
                                selectionState.items.delete(cb.dataset.id);
                            }
                            if (onSelectionChange) onSelectionChange();
                        };

                        cb.addEventListener('change', () => setSelected(cb.checked));
                        wrap.addEventListener('click', (e) => {
                            if (e.target.closest('button')) return;
                            if (e.target === cb) return;
                            setSelected(!cb.checked);
                        });

                        itemsGrid.appendChild(wrap);
                    } else {
                        itemsGrid.appendChild(row);
                    }
                });
            });


            lucide.createIcons();
        };

        qualitySelect.addEventListener('change', () => {
            refreshHostOptions();
            renderFiles();
        });
        hostSelect.addEventListener('change', renderFiles);

        refreshHostOptions();
        renderFiles();
    };


    const showModal = (title, content) => {
        dom('modal-title').textContent = title;
        dom('modal-body').innerHTML = content;
        show(dom('modal-overlay'));
    };

    // Direct-link modal built from DOM nodes so a hostile URL coming back
    // from the API can't smuggle markup into the body.
    const showDirectLinkModal = (link) => {
        const body = dom('modal-body');
        dom('modal-title').textContent = 'Lien Direct';
        body.replaceChildren();

        const wrap = document.createElement('div');
        wrap.className = 'direct-link-box';

        const p = document.createElement('p');
        p.style.marginBottom = '10px';
        p.textContent = 'Voici votre lien de téléchargement :';
        wrap.appendChild(p);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = link || '';
        input.readOnly = true;
        input.id = 'direct-link-input';
        input.style.width = '100%';
        input.style.marginBottom = '15px';
        wrap.appendChild(input);

        const btns = document.createElement('div');
        btns.className = 'btn-group';
        btns.style.display = 'flex';
        btns.style.gap = '10px';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn-primary';
        copyBtn.style.flex = '1';
        copyBtn.textContent = 'Copier';
        copyBtn.addEventListener('click', () => {
            input.select();
            document.execCommand('copy');
            showToast('Copié !');
        });
        btns.appendChild(copyBtn);

        const openLink = document.createElement('a');
        openLink.className = 'btn-success';
        openLink.href = link || '#';
        openLink.target = '_blank';
        openLink.rel = 'noopener noreferrer';
        openLink.style.flex = '1';
        openLink.style.textAlign = 'center';
        openLink.style.textDecoration = 'none';
        openLink.style.display = 'inline-block';
        openLink.textContent = 'Ouvrir';
        btns.appendChild(openLink);

        wrap.appendChild(btns);
        body.appendChild(wrap);
        show(dom('modal-overlay'));
    };

    dom('modal-close').onclick = () => {
        hide(dom('modal-overlay'));
    };

    dom('btn-logout').onclick = async () => {
        await apiCall('/logout', 'POST');
        location.reload();
    };

    // --- Selection page: back button, clear, get all links ---
    const backBtn = dom('btn-selection-back');
    if (backBtn) {
        backBtn.onclick = () => {
            const target = selectionState.previousSectionId || 'section-search';
            document.querySelectorAll('.section').forEach(s => hide(s));
            show(dom(target));
            document.querySelectorAll('.nav-links li').forEach(l => l.classList.remove('active'));
            const navLi = document.querySelector(`.nav-links li[data-target="${target}"]`);
            if (navLi) navLi.classList.add('active');
            resetSelection();
            dom('selection-results').classList.add('hidden');
            dom('selection-results').replaceChildren();
        };
    }

    const clearBtn = dom('btn-selection-clear');
    if (clearBtn) {
        clearBtn.onclick = () => {
            selectionState.items.clear();
            document.querySelectorAll('#selection-body input[type="checkbox"]').forEach(c => { c.checked = false; });
            document.querySelectorAll('#selection-body .file-row-select.is-selected').forEach(r => r.classList.remove('is-selected'));
            updateSelectionActionBar();
        };
    }

    // Sort bulk-resolution results into episode-number order so the listing
    // matches what the user just saw in the selection table (E01, E02, …).
    // Falls back to "Saison complète" packs first.
    const sortResultsByEpisode = (results) => {
        return results.slice().sort((a, b) => {
            const ma = selectionState.items.get(a.chosenId) || {};
            const mb = selectionState.items.get(b.chosenId) || {};
            if (!!ma.isFullSeason !== !!mb.isFullSeason) return mb.isFullSeason ? 1 : -1;
            return (ma.episodeNumber || 0) - (mb.episodeNumber || 0);
        });
    };

    const renderBulkResults = (results) => {
        const panel = dom('selection-results');
        panel.replaceChildren();
        panel.classList.remove('hidden');

        results = sortResultsByEpisode(results);
        const successful = results.filter(r => !r.error);
        const allLinks = successful.map(r => r.link).join('\n');

        const title = document.createElement('h3');
        const okCount = successful.length;
        const errCount = results.length - okCount;
        title.textContent = errCount > 0
            ? `Liens récupérés (${okCount}/${results.length}, ${errCount} échec${errCount > 1 ? 's' : ''})`
            : `Liens récupérés (${okCount})`;
        panel.appendChild(title);

        const toolbar = document.createElement('div');
        toolbar.className = 'results-toolbar';

        const copyAll = document.createElement('button');
        copyAll.className = 'btn-copy-all';
        copyAll.textContent = `Copier tous (${okCount})`;
        copyAll.disabled = okCount === 0;
        copyAll.onclick = async () => {
            try {
                await navigator.clipboard.writeText(allLinks);
                showToast(`${okCount} lien${okCount > 1 ? 's' : ''} copié${okCount > 1 ? 's' : ''} !`);
            } catch {
                showToast('Copie impossible — sélectionnez et copiez manuellement.');
            }
        };
        toolbar.appendChild(copyAll);

        const openAll = document.createElement('button');
        openAll.className = 'btn-open-all';
        const openLimit = Math.min(okCount, 10);
        openAll.textContent = `Ouvrir ${openLimit > 0 ? openLimit : ''}${okCount > 10 ? ' (max 10)' : ''}`;
        openAll.disabled = okCount === 0;
        openAll.onclick = () => {
            successful.slice(0, 10).forEach(r => window.open(r.link, '_blank', 'noopener'));
            if (okCount > 10) showToast(`Limité à 10 onglets sur ${okCount}.`);
        };
        toolbar.appendChild(openAll);
        panel.appendChild(toolbar);

        const table = document.createElement('table');
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>#</th><th>Élément</th><th>Lien</th><th></th></tr>';
        table.appendChild(thead);
        const tbody = document.createElement('tbody');

        results.forEach((r, i) => {
            const meta = selectionState.items.get(r.chosenId);
            const tr = document.createElement('tr');
            const tdN = document.createElement('td'); tdN.textContent = String(i + 1); tr.appendChild(tdN);

            const tdLabel = document.createElement('td');
            const labelParts = [];
            if (meta) {
                if (meta.episode) labelParts.push(meta.episode);
                if (meta.quality) labelParts.push(meta.quality);
                if (meta.host) labelParts.push(meta.host);
            }
            tdLabel.textContent = labelParts.length ? labelParts.join(' — ') : r.chosenId;
            if (!r.error && r.jdSent) {
                const chip = document.createElement('span');
                chip.className = 'chip';
                chip.style.marginLeft = '6px';
                chip.textContent = '→ JD';
                tdLabel.appendChild(chip);
            }
            tr.appendChild(tdLabel);

            const tdLink = document.createElement('td');
            tdLink.className = 'col-link';
            if (r.error) {
                tdLink.classList.add('row-error');
                tdLink.textContent = r.error;
                tr.appendChild(tdLink);
                const tdEmpty = document.createElement('td');
                tr.appendChild(tdEmpty);
            } else {
                const a = document.createElement('a');
                a.href = r.link;
                a.target = '_blank';
                a.rel = 'noopener';
                a.textContent = r.link;
                tdLink.appendChild(a);
                tr.appendChild(tdLink);
                const tdCopy = document.createElement('td');
                const btn = document.createElement('button');
                btn.className = 'btn-copy-row';
                btn.textContent = 'Copier';
                btn.onclick = async () => {
                    try {
                        await navigator.clipboard.writeText(r.link);
                        showToast('Copié !');
                    } catch {
                        showToast('Copie impossible');
                    }
                };
                tdCopy.appendChild(btn);
                tr.appendChild(tdCopy);
            }
            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        panel.appendChild(table);
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // Validate + resolve a bulk selection. Returns { results } or null if
    // the precondition (size limit / empty selection) failed.
    const resolveSelectionLinks = async (useJD) => {
        const ids = Array.from(selectionState.items.keys()).filter(Boolean);
        if (ids.length === 0) {
            showToast('Aucun élément sélectionné.');
            return null;
        }
        if (ids.length > BULK_LINKS_MAX) {
            showToast(`Limite: ${BULK_LINKS_MAX} liens par requête. Désélectionnez-en ${ids.length - BULK_LINKS_MAX}.`);
            return null;
        }
        toggleBlockingLoader(true, `Récupération de ${ids.length} lien${ids.length > 1 ? 's' : ''}...`);
        try {
            const res = await apiCall('/get-links', 'POST', { chosenIds: ids, useJD });
            toggleBlockingLoader(false);
            return res || { results: [] };
        } catch (e) {
            toggleBlockingLoader(false);
            showToast('Erreur: ' + e.message);
            return null;
        }
    };

    const getAllBtn = dom('btn-selection-get-all');
    if (getAllBtn) {
        getAllBtn.onclick = async () => {
            const useJD = document.getElementById('toggle-jd') ? document.getElementById('toggle-jd').checked : false;
            const res = await resolveSelectionLinks(useJD);
            if (res) renderBulkResults(res.results || []);
        };
    }

    // One-click bulk-copy: resolve every selected episode's link and drop
    // them into the clipboard in episode order, joined by newlines. JD is
    // intentionally skipped here — the user just wants the URLs.
    const copyAllBtn = dom('btn-selection-copy-all');
    if (copyAllBtn) {
        copyAllBtn.onclick = async () => {
            const res = await resolveSelectionLinks(false);
            if (!res) return;
            const results = sortResultsByEpisode(res.results || []);
            const successful = results.filter(r => !r.error && r.link);
            const text = successful.map(r => r.link).join('\n');
            const errs = results.length - successful.length;
            if (!successful.length) {
                showToast('Aucun lien résolu.');
                renderBulkResults(results);
                return;
            }
            try {
                await navigator.clipboard.writeText(text);
                showToast(errs > 0
                    ? `${successful.length} lien${successful.length > 1 ? 's' : ''} copié${successful.length > 1 ? 's' : ''} — ${errs} échec${errs > 1 ? 's' : ''}.`
                    : `${successful.length} lien${successful.length > 1 ? 's' : ''} copié${successful.length > 1 ? 's' : ''} !`);
                // Still surface the table so the user can verify what was copied
                // and grab any individual link if needed.
                renderBulkResults(results);
            } catch {
                // Clipboard API blocked (insecure context, permission denied).
                // Fall back to the table view where each row has a Copier button.
                renderBulkResults(results);
                showToast('Clipboard indisponible — copiez depuis le tableau.');
            }
        };
    }

    // Start
    checkSession();
});