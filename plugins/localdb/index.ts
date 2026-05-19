import { ISource, SearchResult, MediaType, ContentLinks, SelectionData, VideoLink } from '../../src/types/source.js';
import { CONFIG } from '../../src/utils/config.js';
import { sourceRegistry } from '../../src/core/registry.js';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

type IndexedTitle = {
    norm: string;
    normOrig: string;
    // Distinct token list for the entry (union of norm + normOrig words).
    // Precomputed at index build time so the search hot path never
    // re-splits/dedupes these strings.
    words: string[];
    title_name: string;
    original_title: string | null;
    tmdb_id: number;
    category_name: string;
    title_poster: string | null;
    created_at: string | null;
};

export class LocalDatabaseAPI implements ISource {
    name = 'localdb';
    private db: any = null;
    private dbPath: string;
    private titleIndex: IndexedTitle[] | null = null;
    // Inverted indexes used by search() to shrink the candidate set from
    // ~104K rows down to <2K before running tier scoring. Populated by
    // buildTitleIndex(); never read or written outside of that method
    // and search().
    private tokenIndex: Map<string, number[]> | null = null;     // exact token  -> row indices
    private titleByNorm: Map<string, number[]> | null = null;    // full norm    -> row indices (Tier 1)
    private prefixIndex: Map<string, number[]> | null = null;    // 2-char prefix-> row indices (Tier 2 + fuzzy)

    constructor() {
        this.dbPath = path.resolve(CONFIG.DB_PATH || './database/darkiworld.db');
    }

    private initDb(): boolean {
        if (this.db) return true;
        if (!fs.existsSync(this.dbPath)) {
            return false;
        }
        try {
            // readOnly avoids journal/WAL writes (plugin only reads).
            this.db = new DatabaseSync(this.dbPath, { readOnly: true });
            // Keep SQLite's temp store in RAM so big GROUP BY / sort
            // operations don't spill to /tmp (a small tmpfs in the
            // hardened container). Also bump page cache + mmap for
            // the initial index scan.
            for (const p of [
                'PRAGMA temp_store = MEMORY',
                'PRAGMA cache_size = -8000',     // ~8MB page cache
                'PRAGMA mmap_size = 67108864',   // 64MB mmap, not 256MB
            ]) {
                this.db.prepare(p).run();
            }
            return true;
        } catch (e: any) {
            console.error('[LocalDB] ❌ Erreur lors de l\'ouverture de la base SQLite native:', e.message);
            return false;
        }
    }

    async healthCheck(): Promise<boolean> {
        const ok = this.initDb();
        if (ok) {
            // Warm the search indexes right after registration so the
            // first /search request doesn't eat the multi-second build
            // cost. setImmediate yields the current tick — the parallel
            // health checks of other plugins still run first.
            setImmediate(() => {
                try { this.buildTitleIndex(); }
                catch (e: any) { console.error('[LocalDB] Index warmup failed:', e.message); }
            });
        }
        return ok;
    }

    // Lowercase, strip diacritics, strip apostrophes, collapse to alnum tokens.
    // "Pokémon: l'aventure" -> "pokemon l aventure"
    private static normalize(s: string | null | undefined): string {
        if (!s) return '';
        return s
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/['"`’ʼ]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    // Bounded Levenshtein. Returns max+1 if it would exceed `max` (cheap exit).
    private static editDistance(a: string, b: string, max: number): number {
        const la = a.length, lb = b.length;
        if (Math.abs(la - lb) > max) return max + 1;
        if (la === 0) return lb;
        if (lb === 0) return la;
        let prev = new Array(lb + 1);
        let curr = new Array(lb + 1);
        for (let j = 0; j <= lb; j++) prev[j] = j;
        for (let i = 1; i <= la; i++) {
            curr[0] = i;
            let rowMin = curr[0];
            const ai = a.charCodeAt(i - 1);
            for (let j = 1; j <= lb; j++) {
                const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
                const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
                curr[j] = v;
                if (v < rowMin) rowMin = v;
            }
            if (rowMin > max) return max + 1;
            const tmp = prev; prev = curr; curr = tmp;
        }
        return prev[lb];
    }

    // Per-token edit-distance budget. Short words must match almost exactly;
    // longer words tolerate more typos.
    private static fuzzyBudget(tok: string): number {
        if (tok.length <= 3) return 0;
        if (tok.length <= 5) return 1;
        if (tok.length <= 8) return 2;
        return 3;
    }

    private buildTitleIndex(): void {
        if (this.titleIndex !== null) return;
        if (!this.initDb()) {
            this.titleIndex = [];
            this.tokenIndex = new Map();
            this.titleByNorm = new Map();
            this.prefixIndex = new Map();
            return;
        }

        const t0 = Date.now();
        const sql = `
            SELECT title_name,
                   original_title,
                   tmdb_id,
                   category_name,
                   title_poster,
                   MIN(created_at) AS created_at
            FROM links_small
            GROUP BY title_name, tmdb_id
        `;
        const rows = this.db.prepare(sql).all() as any[];

        const titleIndex = new Array<IndexedTitle>(rows.length);
        const tokenIndex = new Map<string, number[]>();
        const titleByNorm = new Map<string, number[]>();
        const prefixIndex = new Map<string, number[]>();

        const push = (m: Map<string, number[]>, key: string, idx: number) => {
            const list = m.get(key);
            if (list) list.push(idx);
            else m.set(key, [idx]);
        };

        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const norm = LocalDatabaseAPI.normalize(r.title_name);
            const normOrig = LocalDatabaseAPI.normalize(r.original_title);

            // Deduplicated union of words from both title fields.
            const seen = new Set<string>();
            const words: string[] = [];
            if (norm) for (const w of norm.split(' ')) if (w && !seen.has(w)) { seen.add(w); words.push(w); }
            if (normOrig) for (const w of normOrig.split(' ')) if (w && !seen.has(w)) { seen.add(w); words.push(w); }

            titleIndex[i] = {
                norm, normOrig, words,
                title_name: r.title_name,
                original_title: r.original_title,
                tmdb_id: r.tmdb_id || 0,
                category_name: r.category_name,
                title_poster: r.title_poster,
                created_at: r.created_at,
            };

            if (norm) push(titleByNorm, norm, i);
            if (normOrig && normOrig !== norm) push(titleByNorm, normOrig, i);
            for (const w of words) {
                push(tokenIndex, w, i);
                if (w.length >= 2) push(prefixIndex, w.slice(0, 2), i);
            }
        }

        this.titleIndex = titleIndex;
        this.tokenIndex = tokenIndex;
        this.titleByNorm = titleByNorm;
        this.prefixIndex = prefixIndex;

        console.log(`[LocalDB] Index construit: ${titleIndex.length} titres en ${Date.now() - t0}ms ` +
            `(tokens=${tokenIndex.size}, prefixes=${prefixIndex.size})`);
    }

    private mapCategoryToType(category: string): MediaType {
        const cat = (category || '').toLowerCase().trim();
        
        // Livres & BD
        if (cat.match(/\b(bd|livres?|ebooks?|magazines?|journaux)\b/)) return 'book';
        
        // Jeux
        if (cat.match(/\b(jeux?|consoles?)\b/)) return 'game';
        
        // Logiciels & Formations
        if (cat.match(/\b(logiciels?|formations?)\b/)) return 'software';
        
        // Musique
        if (cat.match(/\b(musiques?|audio)\b/)) return 'music';

        // Séries
        if (cat.includes('série') || cat.includes('serie') || cat.includes('tv') || cat.includes('emission')) return 'series';
        
        // Animes / Dessins animés
        if (cat.includes('anime') || cat.includes('manga') || cat.includes('dessin')) return 'anime';
        
        // Films (Films HD, Documentaires, Spectacles...)
        if (cat.includes('film') || cat.includes('spectacle') || cat.includes('documentaire') || cat === '') return 'movie';
        
        // Tout le reste
        return 'other';
    }

    async search(query: string, mediaType: MediaType = 'movie'): Promise<SearchResult[]> {
        if (!this.initDb()) {
            console.warn('[LocalDB] ⚠️ Base de données non initialisée ou introuvable.');
            return [];
        }
        this.buildTitleIndex();
        if (!this.titleIndex || this.titleIndex.length === 0) return [];

        const t0 = Date.now();
        const q = LocalDatabaseAPI.normalize(query);
        if (!q) return [];
        const tokens = q.split(' ').filter(Boolean);
        if (tokens.length === 0) return [];

        // Candidate row indices, gathered from the inverted indexes. For
        // a typical query this drops the working set from ~104K rows to
        // a few hundred. Rows that don't show up here cannot match Tier
        // 1, 2, 3 or 5 — the only thing they could theoretically hit is
        // Tier 4 substring-inside-a-word, which is rare enough not to
        // justify a trigram index.
        const candidates = new Set<number>();
        const exactHits = this.titleByNorm!.get(q);
        if (exactHits) for (const i of exactHits) candidates.add(i);
        for (const tok of tokens) {
            const rows = this.tokenIndex!.get(tok);
            if (rows) for (const i of rows) candidates.add(i);
            if (tok.length >= 2) {
                const pRows = this.prefixIndex!.get(tok.slice(0, 2));
                if (pRows) for (const i of pRows) candidates.add(i);
            }
        }

        const scored: Array<{ idx: number; score: number }> = [];

        for (const i of candidates) {
            const entry = this.titleIndex[i];
            const t = entry.norm;
            const o = entry.normOrig;

            let score = 0;

            // Tier 1: exact normalized match on either title field
            if (t === q || (o && o === q)) {
                score = 1000;
            }
            // Tier 2: title starts with the full query
            else if (t.startsWith(q) || (o && o.startsWith(q))) {
                score = 800;
            }
            // Tier 3: query appears as a whole-word substring
            else if ((' ' + t + ' ').includes(' ' + q + ' ') ||
                     (o && (' ' + o + ' ').includes(' ' + q + ' '))) {
                score = 700;
            }
            // Tier 4: raw substring (partial word)
            else if (t.includes(q) || (o && o.includes(q))) {
                score = 600;
            }
            // Tier 5: per-token matching, exact-then-fuzzy, any word order.
            // Uses the precomputed entry.words instead of re-splitting on
            // every row.
            else {
                const words = entry.words;
                let exactMatched = 0;
                let fuzzyMatched = 0;
                let fuzzyPenalty = 0;
                let anyMatched = false;

                for (const tok of tokens) {
                    let exact = false;
                    for (const w of words) {
                        if (w === tok || w.startsWith(tok)) { exact = true; break; }
                    }
                    if (exact) {
                        exactMatched++;
                        anyMatched = true;
                        continue;
                    }
                    const budget = LocalDatabaseAPI.fuzzyBudget(tok);
                    if (budget === 0) continue;
                    let best = budget + 1;
                    for (const w of words) {
                        if (Math.abs(w.length - tok.length) > budget) continue;
                        const d = LocalDatabaseAPI.editDistance(tok, w, budget);
                        if (d < best) { best = d; if (best <= 1) break; }
                    }
                    if (best <= budget) {
                        fuzzyMatched++;
                        fuzzyPenalty += best;
                        anyMatched = true;
                    }
                }

                const totalMatched = exactMatched + fuzzyMatched;
                if (totalMatched === tokens.length) {
                    // All tokens covered — strong signal even when some were fuzzy
                    score = 400 - fuzzyPenalty * 30 + exactMatched * 5;
                } else if (anyMatched) {
                    // Partial coverage — only meaningful for multi-word queries
                    score = Math.round(120 * (totalMatched / tokens.length)) - fuzzyPenalty * 10;
                }
            }

            if (score > 0) {
                // Tiebreakers: shorter titles win; original_title field is a small bonus when it helped
                score += Math.max(0, 30 - t.length);
                scored.push({ idx: i, score });
            }
        }

        scored.sort((a, b) => b.score - a.score);

        const results: SearchResult[] = scored.slice(0, 150).map(({ idx }) => {
            const r = this.titleIndex![idx];
            const type = this.mapCategoryToType(r.category_name);
            return {
                title: r.title_name,
                year: r.created_at ? r.created_at.substring(0, 4) : null,
                image: r.title_poster || null,
                hrefPath: `localdb:${r.tmdb_id}:${r.title_name}`,
                type,
                source: this.name
            };
        });

        const filtered = (mediaType === 'movie')
            ? results.filter(r => r.type === 'movie' || r.type === 'anime')
            : (mediaType === 'series')
                ? results.filter(r => r.type === 'series' || r.type === 'anime')
                : (mediaType === 'movie_series')
                    ? results.filter(r => r.type === 'movie' || r.type === 'series' || r.type === 'anime')
                    : results.filter(r => r.type === mediaType);

        console.log(`[LocalDB] search "${query}" → ${candidates.size} candidats, ${filtered.length} résultats en ${Date.now() - t0}ms`);
        return filtered;
    }

    async getTrending(mediaType: MediaType): Promise<SearchResult[]> {
        // Pas de tendances en base de données locale
        return [];
    }

    // Distinct quality/host values from the DB, grouped by media bucket.
    // Cached after the first call — the underlying data is static.
    private optionsCache: { qualities: { movies: string[]; series: string[] }; hosts: string[] } | null = null;
    listConfigOptions(): { qualities: { movies: string[]; series: string[] }; hosts: string[] } {
        if (this.optionsCache) return this.optionsCache;
        const empty = { qualities: { movies: [] as string[], series: [] as string[] }, hosts: [] as string[] };
        if (!this.initDb()) return empty;
        try {
            const movieCats  = ['Films', 'Animes', 'Films et series', 'Documentaire', 'Spectacle'];
            const seriesCats = ['Séries', 'Animes', 'Téléréalité', 'Émissions TV', 'Mangas'];
            const sql = (cats: string[]) => `
                SELECT DISTINCT quality_name FROM links_small
                WHERE category_name IN (${cats.map(() => '?').join(',')})
                  AND quality_name IS NOT NULL AND quality_name != ''
                ORDER BY quality_name`;
            const pick = (cats: string[]): string[] =>
                this.db.prepare(sql(cats)).all(...cats).map((r: any) => r.quality_name);

            const hosts = this.db.prepare(
                `SELECT DISTINCT host_name FROM links_small
                 WHERE host_name IS NOT NULL AND host_name != ''
                 ORDER BY host_name`
            ).all().map((r: any) => r.host_name);

            this.optionsCache = {
                qualities: { movies: pick(movieCats), series: pick(seriesCats) },
                hosts,
            };
            return this.optionsCache;
        } catch (e: any) {
            console.error('[LocalDB] listConfigOptions error:', e.message);
            return empty;
        }
    }

    private parseIdentifier(identifier: string): { tmdbId: number; titleName: string } {
        const parts = identifier.split(':');
        if (parts[0] === 'localdb') {
            return {
                tmdbId: parseInt(parts[1], 10) || 0,
                titleName: parts.slice(2).join(':')
            };
        }
        return { tmdbId: 0, titleName: identifier };
    }

    async getContentLinks(identifier: string, season: number = 1): Promise<ContentLinks> {
        if (!this.initDb()) return { links: [] };

        const { tmdbId, titleName } = this.parseIdentifier(identifier);

        try {
            let categoryStmt = this.db.prepare('SELECT category_name FROM links_small WHERE tmdb_id = ? OR title_name = ? LIMIT 1');
            let sample = categoryStmt.get(tmdbId, titleName) as any;
            
            if (!sample && tmdbId > 0) {
                sample = categoryStmt.get(0, titleName) as any;
            }

            if (!sample) return { links: [] };

            const mediaType = this.mapCategoryToType(sample.category_name);
            if (!mediaType) return { links: [] };

            const isSeries = mediaType === 'series';
            let rows: any[] = [];

            if (isSeries) {
                const sql = `
                    SELECT * FROM links_small 
                    WHERE (tmdb_id = ? OR title_name = ?) AND season_number = ?
                    ORDER BY episode_number ASC, quality_name DESC
                `;
                rows = this.db.prepare(sql).all(tmdbId, titleName, season) as any[];
            } else {
                const sql = `
                    SELECT * FROM links_small 
                    WHERE tmdb_id = ? OR title_name = ?
                    ORDER BY quality_name DESC
                `;
                rows = this.db.prepare(sql).all(tmdbId, titleName) as any[];
            }

            const splitLangs = (s: string | null | undefined): string[] => {
                if (!s) return [];
                return s.split(/[,;/]+/).map(p => p.trim()).filter(Boolean);
            };

            const links: VideoLink[] = rows.map((row: any, i: number) => {
                const idKey = row.link_id != null ? String(row.link_id) : `local_${i}`;
                const audioLangs = splitLangs(row.audio_langs);
                const subLangs = splitLangs(row.sub_langs);

                // Legacy `langs` field — kept for plugins/clients that don't
                // know about audioLangs/subLangs yet.
                const langsList = [...audioLangs];
                if (subLangs.length) langsList.push(`Subs: ${subLangs.join(', ')}`);

                return {
                    id: idKey,
                    host: row.host_name || 'Inconnu',
                    url: row.link_url || null,
                    size: row.size_human || '0 Bytes',
                    sizeBytes: row.size_bytes || 0,
                    quality: row.quality_name || 'BDRip',
                    langs: langsList,
                    episode: row.is_full_season
                        ? 'Saison complète'
                        : (row.episode_number ? `Épisode ${row.episode_number}` : null),
                    episodeNumber: row.episode_number || null,
                    episodeName: row.episode_name || null,
                    isFullSeason: !!row.is_full_season,
                    audioLangs,
                    subLangs,
                };
            });

            return { links };
        } catch (e: any) {
            console.error('[LocalDB] Erreur getContentLinks:', e.message);
            return { links: [] };
        }
    }

    async getSelection(identifier: string, type?: string, seasonValue?: string | number): Promise<SelectionData> {
        if (!this.initDb()) return { links: [], seasons: [], isSeries: false };

        const { tmdbId, titleName } = this.parseIdentifier(identifier);

        try {
            const sample = this.db.prepare('SELECT category_name FROM links_small WHERE tmdb_id = ? OR title_name = ? LIMIT 1').get(tmdbId, titleName) as any;
            if (!sample) return { links: [], seasons: [], isSeries: false };

            const mediaType = this.mapCategoryToType(sample.category_name);
            if (!mediaType) return { links: [], seasons: [], isSeries: false };

            const isSeries = mediaType === 'series';
            let seasonsList: any[] = [];
            let currentSeason = 1;

            if (isSeries) {
                const seasonsRows = this.db.prepare(`
                    SELECT DISTINCT season_number 
                    FROM links_small 
                    WHERE tmdb_id = ? OR title_name = ?
                    ORDER BY season_number ASC
                `).all(tmdbId, titleName) as any[];

                seasonsList = seasonsRows.map((r: any) => ({
                    label: `Saison ${r.season_number}`,
                    value: r.season_number
                }));

                if (seasonValue) {
                    currentSeason = parseInt(String(seasonValue), 10) || 1;
                } else if (seasonsRows.length > 0) {
                    // Prefer season 1 if it exists (matches the UI's auto-selected
                    // dropdown option); otherwise fall back to the lowest season
                    // number — usually "Saison 0" specials.
                    const hasSeason1 = seasonsRows.some((r: any) => r.season_number === 1);
                    currentSeason = hasSeason1 ? 1 : seasonsRows[0].season_number;
                }
            }

            const content = await this.getContentLinks(identifier, currentSeason);

            return {
                links: content.links,
                seasons: seasonsList,
                isSeries
            };
        } catch (e: any) {
            console.error('[LocalDB] Erreur getSelection:', e.message);
            return { links: [], seasons: [], isSeries: false };
        }
    }
}

// Enregistrement automatique du plugin
sourceRegistry.register(new LocalDatabaseAPI());
