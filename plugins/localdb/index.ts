import { ISource, SearchResult, MediaType, ContentLinks, SelectionData, VideoLink } from '../../src/types/source.js';
import { CONFIG } from '../../src/utils/config.js';
import { sourceRegistry } from '../../src/core/registry.js';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

export class LocalDatabaseAPI implements ISource {
    name = 'localdb';
    private db: any = null;
    private dbPath: string;

    constructor() {
        this.dbPath = path.resolve(CONFIG.DB_PATH || './database/darkiworld.db');
    }

    private initDb(): boolean {
        if (this.db) return true;
        if (!fs.existsSync(this.dbPath)) {
            return false;
        }
        try {
            // Utilise le module natif node:sqlite de Node.js v22+
            this.db = new DatabaseSync(this.dbPath);
            return true;
        } catch (e: any) {
            console.error('[LocalDB] ❌ Erreur lors de l\'ouverture de la base SQLite native:', e.message);
            return false;
        }
    }

    async healthCheck(): Promise<boolean> {
        return this.initDb();
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

        try {
            const sql = `
                SELECT title_name, tmdb_id, category_name, title_poster, created_at 
                FROM links_small 
                WHERE title_name LIKE ? OR original_title LIKE ?
                GROUP BY title_name, tmdb_id 
                ORDER BY created_at ASC 
                LIMIT 150
            `;
            const stmt = this.db.prepare(sql);
            const searchPattern = `%${query.trim()}%`;
            const rows = stmt.all(searchPattern, searchPattern) as any[];

            const results: SearchResult[] = rows.map((row: any) => {
                const type = this.mapCategoryToType(row.category_name);
                const tmdbId = row.tmdb_id || 0;
                return {
                    title: row.title_name,
                    year: row.created_at ? row.created_at.substring(0, 4) : null,
                    image: row.title_poster || null,
                    hrefPath: `localdb:${tmdbId}:${row.title_name}`,
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
        } catch (e: any) {
            console.error('[LocalDB] Erreur lors de la recherche:', e.message);
            return [];
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
