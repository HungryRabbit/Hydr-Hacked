import { ISource, SearchResult, MediaType, ContentLinks, SelectionData, VideoLink } from '../../src/types/source.js';
import { CONFIG } from '../../src/utils/config.js';
import { sourceRegistry } from '../../src/core/registry.js';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

type IndexedTitle = {
    norm: string;
    normOrig: string;
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
        return this.initDb();
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
        if (!this.initDb()) { this.titleIndex = []; return; }

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

        this.titleIndex = rows.map((r: any) => ({
            norm: LocalDatabaseAPI.normalize(r.title_name),
            normOrig: LocalDatabaseAPI.normalize(r.original_title),
            title_name: r.title_name,
            original_title: r.original_title,
            tmdb_id: r.tmdb_id || 0,
            category_name: r.category_name,
            title_poster: r.title_poster,
            created_at: r.created_at,
        }));

        console.log(`[LocalDB] Index construit: ${this.titleIndex.length} titres en ${Date.now() - t0}ms`);
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

        const q = LocalDatabaseAPI.normalize(query);
        if (!q) return [];
        const tokens = q.split(' ').filter(Boolean);
        if (tokens.length === 0) return [];

        const scored: Array<{ idx: number; score: number }> = [];

        for (let i = 0; i < this.titleIndex.length; i++) {
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
            // Words are computed on demand instead of stored, to keep the
            // index small (104K titles × stored word arrays is too heavy).
            else {
                const words = (entry.norm + ' ' + (entry.normOrig || '')).split(' ').filter(Boolean);
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

        if (mediaType === 'movie') {
            return results.filter(r => r.type === 'movie' || r.type === 'anime');
        } else if (mediaType === 'series') {
            return results.filter(r => r.type === 'series' || r.type === 'anime');
        } else {
            return results.filter(r => r.type === mediaType);
        }
    }

    async getTrending(mediaType: MediaType): Promise<SearchResult[]> {
        // Pas de tendances en base de données locale
        return [];
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

            const links: VideoLink[] = rows.map((row: any, i: number) => {
                const idKey = row.link_id != null ? String(row.link_id) : `local_${i}`;
                const langsList = row.audio_langs ? [row.audio_langs] : [];
                if (row.sub_langs) langsList.push(`Subs: ${row.sub_langs}`);

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
                        : (row.episode_number ? `Épisode ${row.episode_number}` : null)
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
                    currentSeason = seasonsRows[0].season_number;
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
