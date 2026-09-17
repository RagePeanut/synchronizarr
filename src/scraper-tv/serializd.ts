import logger from '../util/logger';
import {
    SerializdSeries,
    SerializdListType,
    SERIALIZD_API_URL,
    SERIALIZD_API_HEADERS,
} from '.';
import { SeriesScraper } from './scraper.interface';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Raw item shape returned by the various Serializd list endpoints. */
interface SerializdItem {
    showId?: number;
    show_id?: number;
    showName?: string;
    show_name?: string;
    name?: string;
    title?: string;
    seasonIds?: number[];
    season_ids?: number[];
    seasonId?: number;
}

interface WatchlistPage {
    items?: SerializdItem[];
    totalPages: number;
}

interface ShowDetails {
    seasons?: Array<{ id: number; seasonNumber: number }>;
}

interface NormalisedItem {
    tmdbId: number;
    name: string;
    seasonIds: number[];
}

// In-process cache: showId → (serializd season id → season number).
const showSeasonCache = new Map<number, Map<number, number>>();

/**
 * Scrapes a single Serializd source (watchlist, user list or public list) into
 * a list of TV series. Mirrors the structure of the movie-side scrapers in
 * src/scraper/*, but reads Serializd's JSON API instead of scraping HTML.
 */
export class SerializdScraper implements SeriesScraper {
    private readonly url: string;
    private readonly listType: SerializdListType;

    constructor(url: string, listType: SerializdListType) {
        this.url = url;
        this.listType = listType;
    }

    async getSeries(): Promise<SerializdSeries[]> {
        const path = new URL(this.url).pathname;
        let rawItems: SerializdItem[];

        switch (this.listType) {
            case SerializdListType.WATCHLIST: {
                const username = this.extract(/\/user\/([^/]+)\/watchlist/, path, 'watchlist username');
                rawItems = await this.fetchWatchlist(username);
                break;
            }
            case SerializdListType.USER_LIST: {
                const match = /\/user\/([^/]+)\/lists\/([^/?]+)/.exec(path);
                if (!match) throw new Error(`Could not parse Serializd user list URL: ${this.url}`);
                rawItems = await this.fetchUserList(match[1], match[2]);
                break;
            }
            case SerializdListType.PUBLIC_LIST: {
                const slug = this.extract(/\/list\/([^/?]+)/, path, 'public list slug');
                rawItems = await this.fetchPublicList(slug);
                break;
            }
            default:
                throw new Error(`Unsupported Serializd list type: ${this.listType}`);
        }

        logger.debug(`Serializd: fetched ${rawItems.length} raw items from ${this.url}`);

        // De-duplicate by TMDB id, merging monitored seasons across duplicate entries.
        const seriesMap = new Map<number, SerializdSeries>();
        for (const raw of rawItems) {
            const item = this.normaliseItem(raw);
            if (!item) continue;

            const seasons = await this.resolveSeasons(item.tmdbId, item.seasonIds);
            const existing = seriesMap.get(item.tmdbId);
            if (existing) {
                existing.seasons = [...new Set([...existing.seasons, ...seasons])];
            } else {
                seriesMap.set(item.tmdbId, { tmdbId: item.tmdbId, name: item.name, seasons });
            }
        }

        const result = [...seriesMap.values()];
        logger.info(`Serializd: ${result.length} unique series from ${this.url}`);
        return result;
    }

    private extract(pattern: RegExp, path: string, label: string): string {
        const match = pattern.exec(path);
        if (!match || !match[1]) {
            throw new Error(`Could not extract ${label} from Serializd URL: ${this.url}`);
        }
        return match[1];
    }

    /**
     * Serializd's `showId` is the show's TMDB id. Season ids are Serializd's own
     * internal ids and must be resolved to TMDB season numbers separately.
     */
    private normaliseItem(raw: SerializdItem): NormalisedItem | null {
        const tmdbId = raw.showId ?? raw.show_id;
        if (!tmdbId) return null;

        const seasonIds = raw.seasonIds ?? raw.season_ids ?? (raw.seasonId != null ? [raw.seasonId] : []);
        return {
            tmdbId,
            name: raw.showName ?? raw.show_name ?? raw.name ?? raw.title ?? 'Unknown',
            seasonIds,
        };
    }

    private async resolveSeasons(tmdbId: number, seasonIds: number[]): Promise<number[]> {
        if (seasonIds.length === 0) return [];

        let cache = showSeasonCache.get(tmdbId);
        if (!cache) {
            try {
                const details = await this.fetchJson<ShowDetails>(`${SERIALIZD_API_URL}/api/show/${tmdbId}`, `show details for ${tmdbId}`);
                cache = new Map((details.seasons ?? []).map(s => [s.id, s.seasonNumber]));
                showSeasonCache.set(tmdbId, cache);
            } catch (error) {
                logger.warn(`Serializd: failed to fetch show details for ${tmdbId}; monitoring all seasons.`, error);
                return [];
            }
        }

        return seasonIds.flatMap(sid => {
            const n = cache!.get(sid);
            return n !== undefined ? [n] : [];
        });
    }

    private async fetchWatchlist(username: string): Promise<SerializdItem[]> {
        const base = `${SERIALIZD_API_URL}/api/user/${username}/watchlistpage_v2`;
        const all: SerializdItem[] = [];
        let page = 1;
        let totalPages = 1;

        do {
            const data = await this.fetchJson<WatchlistPage>(
                `${base}/${page}?sort_by=date_added_desc`,
                `watchlist page ${page} for ${username}`,
            );
            totalPages = data.totalPages ?? 1;
            if (data.items) all.push(...data.items);
            page++;
            // Be gentle with the API between pages.
            if (page <= totalPages) await sleep(500);
        } while (page <= totalPages);

        return all;
    }

    private async fetchUserList(username: string, slug: string): Promise<SerializdItem[]> {
        const data = await this.fetchJson<unknown>(
            `${SERIALIZD_API_URL}/api/user/${username}/list/${slug}`,
            `user list ${username}/${slug}`,
        );
        return this.extractItems(data, ['shows', 'items', 'entries', 'listItems']);
    }

    private async fetchPublicList(slug: string): Promise<SerializdItem[]> {
        // Public list URLs often look like "My-List-Name-12345"; the API keys on
        // the trailing numeric id.
        const idMatch = /(\d+)$/.exec(slug);
        const listId = idMatch ? idMatch[1] : slug;
        const data = await this.fetchJson<unknown>(
            `${SERIALIZD_API_URL}/api/list/${listId}`,
            `public list ${listId}`,
        );
        return this.extractItems(data, ['listItems', 'shows', 'items', 'entries']);
    }

    /** Pull the item array out of a list response, trying several known field names. */
    private extractItems(data: unknown, fields: string[]): SerializdItem[] {
        if (Array.isArray(data)) return data as SerializdItem[];
        if (!data || typeof data !== 'object') return [];
        const record = data as Record<string, unknown>;
        for (const field of fields) {
            const value = record[field];
            if (Array.isArray(value)) return value as SerializdItem[];
        }
        return [];
    }

    private async fetchJson<T>(url: string, label: string, retries = 3): Promise<T> {
        let lastError: unknown;
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await fetch(url, { headers: SERIALIZD_API_HEADERS });
                if (!response.ok) {
                    if (response.status === 404) throw new Error(`Not found (404): ${url}`);
                    if (response.status === 401 || response.status === 403) throw new Error(`Auth error (${response.status}): ${url}`);
                    throw new Error(`HTTP ${response.status}: ${url}`);
                }
                return await response.json() as T;
            } catch (error) {
                lastError = error;
                if (attempt < retries - 1) {
                    const delay = Math.min(2000 * Math.pow(2, attempt), 15000);
                    logger.warn(`Serializd: ${label} failed, retrying in ${delay / 1000}s (attempt ${attempt + 2}/${retries})`);
                    await sleep(delay);
                }
            }
        }
        throw lastError;
    }
}
