import { ISource, SearchResult, MediaType, ContentLinks, VideoLink, SelectionData } from '../../src/types/source.js';
import { sourceRegistry } from '../../src/core/registry.js';
import { CONFIG_HYDRACKER, apiGet, apiPost, fetchSearch, fetchMovieLinks, fetchSeriesLiens } from './api.js';
import {
    QUALITY_MAP, formatSize,
    parseSearchResults, parseTrendingResults,
    parseMovieLinks, parseSeasons, parsePremiumLink
} from './parser.js';

export class HydrackerAPI implements ISource {
    name = 'hydracker';

    async healthCheck(): Promise<boolean> {
        if (!CONFIG_HYDRACKER.BASE_URL || !CONFIG_HYDRACKER.API_KEY) {
            console.warn('[Hydracker] ⚠️ HYDRACKER_URL ou HYDRACKER_API_KEY manquante.');
            return false;
        }
        try {
            const res = await fetch(CONFIG_HYDRACKER.BASE_URL, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(8000)
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    async search(query: string, mediaType: MediaType = 'movie'): Promise<SearchResult[]> {
        const data = await fetchSearch(query);
        if (!data) {
            console.error('[Hydracker] search: fetchSearch a retourné null pour', query);
            return [];
        }
        const totalRaw = (data.results || []).length;
        const parsed = parseSearchResults(data, mediaType);
        console.log(`[Hydracker] search "${query}" (${mediaType}): ${totalRaw} résultats bruts → ${parsed.length} après filtre`);
        return parsed;
    }

    async getTrending(mediaType: MediaType): Promise<SearchResult[]> {
        const type = mediaType === 'series' ? 'series' : 'movie';
        try {
            const data = await apiGet('titles', { order: 'trending:desc', type, page: 1, paginate: 'lengthAware' });
            return parseTrendingResults(data);
        } catch (e: any) {
            console.error(`[Hydracker] getTrending Error for ${type}:`, e.message);
            return [];
        }
    }

    async getSelection(identifier: string, type?: string, seasonValue?: string | number): Promise<SelectionData> {
        const seasonsList = await this.getSeasons(identifier);

        let isSeries = false;
        if (type) {
            isSeries = (type === 'series' || type === 'serie' || type === 'tv');
        } else {
            isSeries = seasonsList.length > 0;
        }

        const currentSeason = seasonValue ? parseInt(String(seasonValue), 10) : 1;
        const content = await this.getContentLinks(identifier, currentSeason);
        const formattedSeasons = seasonsList.map(num => ({ label: `Saison ${num}`, value: num }));

        return {
            links: content.links,
            seasons: isSeries ? formattedSeasons : [],
            isSeries
        };
    }

    async getContentLinks(titleId: string, season: number = 1): Promise<ContentLinks> {
        // Essai film en premier
        const movieData = await fetchMovieLinks(titleId);
        if (movieData) {
            const movieLinks = parseMovieLinks(movieData);
            if (movieLinks.length > 0) return { links: movieLinks };
        }

        // Fallback série
        const rawLiens = await fetchSeriesLiens(titleId, season);
        const links: VideoLink[] = rawLiens.map(l => ({
            id: l.id,
            host: (l.host && l.host.name) || '?',
            size: formatSize(l.taille),
            sizeBytes: l.taille || 0,
            quality: QUALITY_MAP[l.qualite] || `id:${l.qualite}`,
            langs: (l.langues_compact || []).map((la: any) => la.name || ''),
            episode: (l.episode === 0 || l.episode === "0" || l.episode === "00")
                ? 'Saison complète'
                : (l.episode ? String(l.episode) : null),
            url: null
        }));

        return { links };
    }

    async getSeasons(titleId: string): Promise<number[]> {
        const result = await apiGet(`titles/${titleId}/seasons`);
        return parseSeasons(result);
    }

    private isPremiumCache: boolean | null = null;
    private premiumCheckPromise: Promise<boolean> | null = null;

    async checkPremiumStatus(): Promise<boolean> {
        if (this.isPremiumCache !== null) return this.isPremiumCache;
        if (this.premiumCheckPromise) return this.premiumCheckPromise;

        this.premiumCheckPromise = (async () => {
            try {
                const result = await apiGet('users/me');
                if (result && result.user) {
                    this.isPremiumCache = !!result.user.IsPremium;
                    console.log(`[Hydracker] Statut Premium vérifié: ${this.isPremiumCache ? 'OUI' : 'NON'}`);
                    return this.isPremiumCache;
                }
            } catch (e: any) {
                console.error('[Hydracker] Erreur vérification Premium:', e.message);
            }
            return false;
        })();

        return await this.premiumCheckPromise;
    }

    async resolveLink(linkId: string): Promise<string | null> {
        const isPremium = await this.checkPremiumStatus();
        
        if (!isPremium) {
            console.log(`[Hydracker] Compte non Premium détecté. Bypass de Hydracker, passage direct à Movix...`);
            return await this.resolveMovixLink(linkId);
        }

        const maxRetries = 4;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 1) {
                    console.log(`[Hydracker] Retry ${attempt}/${maxRetries} for lien ${linkId}`);
                    await new Promise(r => setTimeout(r, 4000));
                }

                const result = await apiGet(`content/liens/${linkId}`);
                if (!result) continue;
                
                const finalUrl = result.directDL || result.url || result.link || '';
                if (!finalUrl) continue;

                console.log(`[Hydracker] Got final URL: ${finalUrl.substring(0, 80)}...`);

                return finalUrl;
            } catch (e: any) {
                console.error(`[Hydracker] Exception resolving lien ${linkId} (attempt ${attempt}):`, e.message);
            }
        }
        
        console.log(`[Hydracker] Échec de la résolution classique (Erreur). Fallback automatique via Movix...`);
        return await this.resolveMovixLink(linkId);
    }

    async resolveMovixLink(lienId: string, titleId?: string): Promise<string | null> {
        try {
            console.log(`[Hydracker] Tentative de débridage Movix pour le lien ${lienId}...`);
            const url = `https://api.movix.tax/api/darkiworld/decode/${lienId}${titleId ? `?title_id=${titleId}` : ''}`;
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Referer': 'https://movix.tax/',
                    'Origin': 'https://movix.tax',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                }
            });

            const data = await response.json();
            
            if (!response.ok || data.success === false) {
                console.error('[Hydracker] Erreur API Movix:', data.error || 'Erreur inconnue');
                return null;
            }

            // Récupération du lien direct selon le format de réponse Movix
            const directUrl = data.directDL || data.direct_url || 
                             (data.embed_url && (data.embed_url.directDL || data.embed_url.src || data.embed_url.lien));
            
            if (directUrl) {
                console.log(`[Hydracker] Movix a résolu le lien avec succès !`);
                return directUrl;
            }

            return null;
        } catch (e: any) {
            console.error(`[Hydracker] Exception lors de la résolution Movix :`, e.message);
            return null;
        }
    }
}

// ── Auto-registration ──
sourceRegistry.register(new HydrackerAPI());
