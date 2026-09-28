import Axios, { AxiosInstance } from 'axios';
import env from '../util/env';
import logger from '../util/logger';

/**
 * Plex labelling client.
 *
 * This module mirrors the tags applied in Radarr/Sonarr as *labels* on the
 * matching items in Plex. It is entirely opt-in (see isPlexEnabled()): with
 * PLEX_URL / PLEX_TOKEN unset, none of this runs.
 *
 * Design constraints (by request):
 *   • Plex is NEVER used to add or remove media. We only add/remove labels on
 *     items that already exist in the Plex library.
 *   • The 'letterboxd' / 'serializd' default tag is NOT forced onto Plex labels.
 *     Plex labels default to the custom RADARR_TAGS / SONARR_TAGS, and can be
 *     overridden with PLEX_MOVIE_TAGS / PLEX_TV_TAGS.
 *   • Exclusion (EXCLUDE_TAGS) is honoured the same way as Radarr/Sonarr: when
 *     an item leaves a list we strip only that list's labels and keep any
 *     excluded label — we never remove the item itself.
 */

// Plex library section types.
const PLEX_TYPE_MOVIE = 1;
const PLEX_TYPE_SHOW = 2;

// PLEX_URL/TOKEN are optional at the env level. Fall back to empty strings
// here; this module's functions only run when isPlexEnabled() is true.
const axios: AxiosInstance = Axios.create({
    baseURL: env.PLEX_URL ?? '',
    headers: {
        'X-Plex-Token': env.PLEX_TOKEN ?? '',
        Accept: 'application/json',
    },
});

/**
 * Turn an unknown thrown value (usually an Axios error) into a concise,
 * human-readable string. Logging the raw Axios error object tends to produce
 * unhelpful output (circular references get stripped, the useful fields are
 * buried), so we surface the bits that actually explain the failure: the HTTP
 * status, the low-level error code (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, …) and
 * the request target.
 */
export function describeError(error: unknown): string {
    if (Axios.isAxiosError(error)) {
        const parts: string[] = [];
        if (error.response?.status) {
            parts.push(`HTTP ${error.response.status}${error.response.statusText ? ` ${error.response.statusText}` : ''}`);
        }
        if (error.code) parts.push(error.code);
        const method = error.config?.method?.toUpperCase();
        const url = error.config?.url;
        if (method && url) parts.push(`on ${method} ${url}`);
        parts.push(error.message);

        let hint = '';
        const status = error.response?.status;
        if (status === 401 || status === 403) {
            hint = ' — check PLEX_TOKEN is valid.';
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
            hint = ' — check PLEX_URL is reachable from this container (use the Plex host/container name and port, not localhost).';
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
            hint = ' — the Plex server did not respond in time; check PLEX_URL and that Plex is running.';
        } else if (error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.code === 'SELF_SIGNED_CERT_IN_CHAIN' || error.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
            hint = ' — Plex is using a self-signed TLS certificate; use the plain http:// URL and port (default 32400) instead of https://.';
        }

        return parts.filter(Boolean).join(' ') + hint;
    }
    if (error instanceof Error) return error.message;
    return String(error);
}

interface PlexSection {
    key: string;
    type: string;
    title: string;
}

interface PlexGuid {
    id: string; // e.g. "tmdb://12345", "tvdb://67890", "imdb://tt123"
}

interface PlexItem {
    ratingKey: string;
    title: string;
    type: string;
    Guid?: PlexGuid[];
    Label?: Array<{ tag: string }>;
}

/** External IDs used to match a Plex item. At least one should be present. */
export interface PlexMatchIds {
    tmdbId?: number | null;
    tvdbId?: number | null;
    imdbId?: string | null;
}

/**
 * Parse a comma-separated tag string into a clean, de-duplicated list.
 * Empty / whitespace-only entries are dropped.
 */
function parseTags(raw: string | undefined): string[] {
    if (!raw) return [];
    return [...new Set(
        raw.split(',').map(t => t.trim()).filter(t => t.length > 0)
    )];
}

/**
 * The labels to apply to movies in Plex: PLEX_MOVIE_TAGS if set, otherwise the
 * same custom tags configured for Radarr (RADARR_TAGS). The default
 * 'letterboxd' tag is intentionally not included.
 */
export function getMovieLabels(): string[] {
    return parseTags(env.PLEX_MOVIE_TAGS ?? env.RADARR_TAGS);
}

/**
 * The labels to apply to series in Plex: PLEX_TV_TAGS if set, otherwise the
 * same custom tags configured for Sonarr (SONARR_TAGS). The default 'serializd'
 * tag is intentionally not included.
 */
export function getTvLabels(): string[] {
    return parseTags(env.PLEX_TV_TAGS ?? env.SONARR_TAGS);
}

/** The exclusion labels (from EXCLUDE_TAGS), lower-cased for comparison. */
function getExcludedLabelsLower(): Set<string> {
    return new Set(parseTags(env.EXCLUDE_TAGS).map(t => t.toLowerCase()));
}

/**
 * Given the labels this list manages, return the subset that should be removed
 * from a Plex item when it leaves the list. Labels that are also in
 * EXCLUDE_TAGS are kept (the item stays "protected" in Plex too).
 */
export function getRemovableLabels(managedLabels: string[]): string[] {
    const excluded = getExcludedLabelsLower();
    return managedLabels.filter(l => !excluded.has(l.toLowerCase()));
}

/** Fetch all library sections from Plex. */
async function getSections(): Promise<PlexSection[]> {
    const response = await axios.get('/library/sections');
    const dirs = response.data?.MediaContainer?.Directory;
    return Array.isArray(dirs) ? dirs : [];
}

/**
 * Resolve which Plex section keys to search for a given media type.
 * If an explicit library name is configured, only that section is used
 * (matched case-insensitively by title). Otherwise every section of the right
 * type is auto-detected.
 */
async function resolveSectionKeys(
    plexType: number,
    configuredLibraryName: string | undefined
): Promise<string[]> {
    let sections: PlexSection[];
    try {
        sections = await getSections();
    } catch (error) {
        logger.error(`Plex: failed to fetch library sections: ${describeError(error)}`);
        return [];
    }

    const wantType = plexType === PLEX_TYPE_MOVIE ? 'movie' : 'show';

    if (configuredLibraryName) {
        const wanted = configuredLibraryName.trim().toLowerCase();
        const match = sections.filter(s => s.title.trim().toLowerCase() === wanted);
        if (match.length === 0) {
            logger.warn(`Plex: configured library "${configuredLibraryName}" not found among sections: ${sections.map(s => s.title).join(', ') || '(none)'}`);
        }
        return match.map(s => s.key);
    }

    const auto = sections.filter(s => s.type === wantType);
    if (auto.length === 0) {
        logger.warn(`Plex: no ${wantType} libraries found to label. Set ${plexType === PLEX_TYPE_MOVIE ? 'PLEX_MOVIE_LIBRARY' : 'PLEX_TV_LIBRARY'} if your library uses a custom type.`);
    }
    return auto.map(s => s.key);
}

/** Does a Plex item's Guid list match any of the given external IDs? */
function itemMatchesIds(item: PlexItem, ids: PlexMatchIds): boolean {
    const guids = item.Guid ?? [];
    return guids.some(g => {
        const id = g.id ?? '';
        if (ids.tmdbId != null && id === `tmdb://${ids.tmdbId}`) return true;
        if (ids.tvdbId != null && id === `tvdb://${ids.tvdbId}`) return true;
        if (ids.imdbId && id === `imdb://${ids.imdbId}`) return true;
        return false;
    });
}

/**
 * Find a Plex item within the given sections by external ID. Returns the first
 * match (with its current labels) or null if not found in any section.
 */
async function findItem(
    sectionKeys: string[],
    plexType: number,
    ids: PlexMatchIds
): Promise<{ item: PlexItem; sectionKey: string } | null> {
    for (const sectionKey of sectionKeys) {
        try {
            const response = await axios.get(`/library/sections/${sectionKey}/all`, {
                params: { type: plexType, includeGuids: 1 },
            });
            const metadata = response.data?.MediaContainer?.Metadata;
            const items: PlexItem[] = Array.isArray(metadata) ? metadata : [];
            const found = items.find(it => itemMatchesIds(it, ids));
            if (found) return { item: found, sectionKey };
        } catch (error) {
            logger.error(`Plex: failed to query section ${sectionKey}: ${describeError(error)}`);
        }
    }
    return null;
}

/**
 * Write the full desired label set onto a Plex item. Plex label editing is
 * "set the whole field": we send every desired label indexed, and lock the
 * field so Plex doesn't overwrite it on the next metadata refresh.
 */
async function writeLabels(
    sectionKey: string,
    plexType: number,
    ratingKey: string,
    labels: string[]
): Promise<void> {
    const params = new URLSearchParams();
    params.set('type', String(plexType));
    params.set('id', ratingKey);
    if (labels.length === 0) {
        // Clear the field entirely.
        params.set('label[0].tag.tag', '');
    } else {
        labels.forEach((label, i) => {
            params.set(`label[${i}].tag.tag`, label);
        });
    }
    params.set('label.locked', '1');

    await axios.put(`/library/sections/${sectionKey}/all?${params.toString()}`);
}

/** Compute the union of an item's existing labels with the ones to add. */
function unionLabels(existing: string[], toAdd: string[]): string[] {
    const seen = new Map<string, string>(); // lower -> original casing
    for (const l of existing) seen.set(l.toLowerCase(), l);
    for (const l of toAdd) if (!seen.has(l.toLowerCase())) seen.set(l.toLowerCase(), l);
    return [...seen.values()];
}

/** Remove a set of labels (case-insensitive) from an existing label list. */
function subtractLabels(existing: string[], toRemove: string[]): string[] {
    const remove = new Set(toRemove.map(l => l.toLowerCase()));
    return existing.filter(l => !remove.has(l.toLowerCase()));
}

interface ApplyContext {
    plexType: number;
    sectionKeys: string[];
    displayName: string; // for logging, e.g. movie/series name
}

/**
 * Add labels to a matching Plex item (idempotent, additive). Existing labels
 * (including unrelated ones and excluded ones) are preserved.
 */
async function addLabels(ctx: ApplyContext, ids: PlexMatchIds, labelsToAdd: string[]): Promise<void> {
    if (labelsToAdd.length === 0) return;

    const match = await findItem(ctx.sectionKeys, ctx.plexType, ids);
    if (!match) {
        logger.debug(`Plex: no library item found for "${ctx.displayName}" yet — will retry on a later run once it's scanned.`);
        return;
    }

    const existing = (match.item.Label ?? []).map(l => l.tag);
    const desired = unionLabels(existing, labelsToAdd);

    // Nothing to do if all labels are already present.
    if (desired.length === existing.length && labelsToAdd.every(l => existing.some(e => e.toLowerCase() === l.toLowerCase()))) {
        logger.debug(`Plex: "${ctx.displayName}" already has labels [${labelsToAdd.join(', ')}]`);
        return;
    }

    if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Plex: would label "${ctx.displayName}" with [${labelsToAdd.join(', ')}]`);
        return;
    }

    try {
        await writeLabels(match.sectionKey, ctx.plexType, match.item.ratingKey, desired);
        logger.info(`Plex: labelled "${ctx.displayName}" with [${labelsToAdd.join(', ')}]`);
    } catch (error) {
        logger.error(`Plex: failed to label "${ctx.displayName}": ${describeError(error)}`);
    }
}

/**
 * Remove the given labels from a matching Plex item (never removes the item).
 * Excluded labels are expected to already be filtered out by the caller.
 */
async function stripLabels(ctx: ApplyContext, ids: PlexMatchIds, labelsToRemove: string[]): Promise<void> {
    if (labelsToRemove.length === 0) return;

    const match = await findItem(ctx.sectionKeys, ctx.plexType, ids);
    if (!match) {
        logger.debug(`Plex: no library item found for "${ctx.displayName}" — nothing to unlabel.`);
        return;
    }

    const existing = (match.item.Label ?? []).map(l => l.tag);
    const remaining = subtractLabels(existing, labelsToRemove);

    if (remaining.length === existing.length) {
        logger.debug(`Plex: "${ctx.displayName}" has none of [${labelsToRemove.join(', ')}] — nothing to remove.`);
        return;
    }

    if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Plex: would remove labels [${labelsToRemove.join(', ')}] from "${ctx.displayName}" (item kept).`);
        return;
    }

    try {
        await writeLabels(match.sectionKey, ctx.plexType, match.item.ratingKey, remaining);
        logger.info(`Plex: removed labels [${labelsToRemove.join(', ')}] from "${ctx.displayName}" (item kept).`);
    } catch (error) {
        logger.error(`Plex: failed to remove labels from "${ctx.displayName}": ${describeError(error)}`);
    }
}

// ── Public API: movies ──

let movieSectionKeysCache: string[] | null = null;

async function getMovieSectionKeys(): Promise<string[]> {
    if (movieSectionKeysCache === null) {
        movieSectionKeysCache = await resolveSectionKeys(PLEX_TYPE_MOVIE, env.PLEX_MOVIE_LIBRARY);
    }
    return movieSectionKeysCache;
}

/** Label a movie in Plex, matched by TMDB / IMDB id. */
export async function labelMovie(ids: PlexMatchIds, displayName: string): Promise<void> {
    const labels = getMovieLabels();
    if (labels.length === 0) return;
    const sectionKeys = await getMovieSectionKeys();
    if (sectionKeys.length === 0) return;
    await addLabels({ plexType: PLEX_TYPE_MOVIE, sectionKeys, displayName }, ids, labels);
}

/**
 * Remove this list's labels from a movie in Plex (used when a movie leaves the
 * list). Excluded labels are preserved; the movie itself is never removed.
 */
export async function unlabelMovie(ids: PlexMatchIds, displayName: string): Promise<void> {
    const removable = getRemovableLabels(getMovieLabels());
    if (removable.length === 0) return;
    const sectionKeys = await getMovieSectionKeys();
    if (sectionKeys.length === 0) return;
    await stripLabels({ plexType: PLEX_TYPE_MOVIE, sectionKeys, displayName }, ids, removable);
}

// ── Public API: series ──

let tvSectionKeysCache: string[] | null = null;

async function getTvSectionKeys(): Promise<string[]> {
    if (tvSectionKeysCache === null) {
        tvSectionKeysCache = await resolveSectionKeys(PLEX_TYPE_SHOW, env.PLEX_TV_LIBRARY);
    }
    return tvSectionKeysCache;
}

/** Label a series in Plex, matched by TVDB / TMDB id. */
export async function labelSeries(ids: PlexMatchIds, displayName: string): Promise<void> {
    const labels = getTvLabels();
    if (labels.length === 0) return;
    const sectionKeys = await getTvSectionKeys();
    if (sectionKeys.length === 0) return;
    await addLabels({ plexType: PLEX_TYPE_SHOW, sectionKeys, displayName }, ids, labels);
}

/**
 * Remove this list's labels from a series in Plex (used when a series leaves
 * the list). Excluded labels are preserved; the series itself is never removed.
 */
export async function unlabelSeries(ids: PlexMatchIds, displayName: string): Promise<void> {
    const removable = getRemovableLabels(getTvLabels());
    if (removable.length === 0) return;
    const sectionKeys = await getTvSectionKeys();
    if (sectionKeys.length === 0) return;
    await stripLabels({ plexType: PLEX_TYPE_SHOW, sectionKeys, displayName }, ids, removable);
}

/** Reset cached section lookups. Exposed for tests. */
export function __resetSectionCaches(): void {
    movieSectionKeysCache = null;
    tvSectionKeysCache = null;
}
