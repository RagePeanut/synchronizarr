require('dotenv').config();
require('dotenv').config();

import env, { isRadarrEnabled, isSonarrEnabled, isPlexEnabled } from './util/env';
import logger from './util/logger';
import { fetchMoviesFromUrl, LetterboxdMovie } from './scraper';
import { fetchSeriesFromUrl, SerializdSeries } from './scraper-tv';
import { upsertMovies, getAllRequiredTagIds, getMoviesByTagIds, deleteMovie, getExcludedTagIds, removeTagsFromMovie } from './api/radarr';
import {
  upsertSeries,
  getAllRequiredTagIds as getAllRequiredSeriesTagIds,
  getSeriesByTagIds,
  deleteSeries,
  getExcludedTagIds as getExcludedSeriesTagIds,
  removeTagsFromSeries,
} from './api/sonarr';
import { labelMovie, unlabelMovie, labelSeries, unlabelSeries } from './api/plex';

function startScheduledMonitoring(): void {
  const intervalMs = env.CHECK_INTERVAL_MINUTES * 60 * 1000;

  logger.info(`Starting scheduled monitoring. Will check every ${env.CHECK_INTERVAL_MINUTES} minutes.`);
  if (isRadarrEnabled()) {
    logger.info(`Letterboxd → Radarr enabled: ${env.LETTERBOXD_URL}`);
  }
  if (isSonarrEnabled()) {
    logger.info(`Serializd → Sonarr enabled: ${env.SERIALIZD_URL}`);
  }
  if (env.SYNC_MODE === 'sync') {
    logger.info('Sync mode enabled: items removed from the source list will be removed from Radarr/Sonarr.');
  }

  // Run immediately on startup
  run();

  // Then run on interval
  setInterval(async () => {
    await run();
  }, intervalMs);
}

async function run() {
  await Promise.all([
    isRadarrEnabled() ? runMovies() : Promise.resolve(),
    isSonarrEnabled() ? runSeries() : Promise.resolve(),
  ]);
}

/** Letterboxd → Radarr pipeline. */
async function runMovies() {
  try {
    const movies = await fetchMoviesFromUrl(env.LETTERBOXD_URL!);
    await upsertMovies(movies);

    if (isPlexEnabled()) {
      await labelMoviesInPlex(movies);
    }

    if (env.SYNC_MODE === 'sync') {
      await syncMovieRemovals(movies.map(m => m.tmdbId ? parseInt(m.tmdbId) : null).filter((id): id is number => id !== null));
    }
  } catch (error) {
    logger.error('Error during Letterboxd → Radarr run:', error);
  }
}

/** Serializd → Sonarr pipeline. */
async function runSeries() {
  try {
    const series = await fetchSeriesFromUrl(env.SERIALIZD_URL!);
    await upsertSeries(series);

    if (isPlexEnabled()) {
      await labelSeriesInPlex(series);
    }

    if (env.SYNC_MODE === 'sync') {
      await syncSeriesRemovals(series.map(s => s.tmdbId));
    }
  } catch (error) {
    logger.error('Error during Serializd → Sonarr run:', error);
  }
}

/**
 * Mirror the configured Plex movie labels onto each movie currently on the
 * list. Runs regardless of SYNC_MODE. Matching is by TMDB (and IMDB) id, so a
 * movie that isn't scanned into Plex yet is simply skipped and picked up on a
 * later run.
 */
async function labelMoviesInPlex(movies: LetterboxdMovie[]): Promise<void> {
  for (const movie of movies) {
    const tmdbId = movie.tmdbId ? parseInt(movie.tmdbId) : null;
    if (!tmdbId) continue;
    await labelMovie({ tmdbId, imdbId: movie.imdbId ?? null }, movie.name);
  }
}

/** Mirror the configured Plex TV labels onto each series currently on the list. */
async function labelSeriesInPlex(series: SerializdSeries[]): Promise<void> {
  for (const s of series) {
    if (!s.tmdbId) continue;
    await labelSeries({ tmdbId: s.tmdbId }, s.name);
  }
}

/**
 * Remove movies from Radarr that are tagged with our tags but no longer on the
 * Letterboxd list. This makes the Letterboxd list the single source of truth.
 */
async function syncMovieRemovals(currentTmdbIds: number[]): Promise<void> {
  try {
    const tagIds = await getAllRequiredTagIds();
    if (tagIds.length === 0) {
      logger.warn('No tag IDs resolved — cannot determine which Radarr movies belong to this list. Skipping removal sync.');
      return;
    }

    const radarrMovies = await getMoviesByTagIds(tagIds);
    const currentSet = new Set(currentTmdbIds);
    const excludedTagIds = await getExcludedTagIds();

    // Movies in Radarr (with our tags) that are NOT on the current Letterboxd list.
    const candidates = radarrMovies.filter(m => !currentSet.has(m.tmdbId));

    // Split candidates into two groups:
    //  - protected: carry an excluded tag (owned by another instance/list). We
    //    don't delete these; instead we strip THIS instance's tags so the movie
    //    is no longer considered part of this list. It stays in Radarr, owned by
    //    whatever gave it the excluded tag. This avoids the "deadlock" where a
    //    movie protected both ways could never be removed.
    //  - toRemove: not protected → delete the whole movie.
    const protectedCandidates = candidates.filter(m => excludedTagIds.some(tid => m.tags.includes(tid)));
    const toRemove = candidates.filter(m => !excludedTagIds.some(tid => m.tags.includes(tid)));

    if (toRemove.length === 0 && protectedCandidates.length === 0) {
      logger.debug('No changes needed — Radarr and Letterboxd list are in sync.');
      return;
    }

    // Handle protected movies: remove only this instance's tags (untag, don't delete).
    for (const movie of protectedCandidates) {
      const ourTagsOnMovie = tagIds.filter(tid => movie.tags.includes(tid));
      if (ourTagsOnMovie.length === 0) continue;

      if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Would untag "${movie.title}" (TMDB: ${movie.tmdbId}) — removing this list's tags; movie kept (protected by another tag).`);
        continue;
      }

      try {
        await removeTagsFromMovie(movie, ourTagsOnMovie);
        logger.info(`Untagged "${movie.title}" (TMDB: ${movie.tmdbId}) — no longer part of this list; movie kept (protected by another tag).`);
      } catch {
        // error already logged in removeTagsFromMovie
      }
    }

    // Handle unprotected movies: delete them entirely.
    for (const movie of toRemove) {
      if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Would remove from Radarr: "${movie.title}" (TMDB: ${movie.tmdbId}, deleteFiles=${env.DELETE_FILES}, addImportExclusion=${env.ADD_IMPORT_EXCLUSION})`);
        continue;
      }

      try {
        await deleteMovie(movie.id, {
          deleteFiles: env.DELETE_FILES,
          addImportExclusion: env.ADD_IMPORT_EXCLUSION,
        });
        logger.info(`Removed from Radarr: "${movie.title}" (TMDB: ${movie.tmdbId}, files ${env.DELETE_FILES ? 'deleted' : 'kept'})`);
      } catch (error) {
        logger.error(`Error removing "${movie.title}" (ID: ${movie.id}):`, error);
      }
    }

    // Mirror the removal in Plex: strip this list's labels from every movie that
    // left the list (protected or not). Plex items and excluded labels are kept.
    if (isPlexEnabled()) {
      for (const movie of candidates) {
        await unlabelMovie({ tmdbId: movie.tmdbId }, movie.title);
      }
    }
  } catch (error) {
    logger.error('Error during movie removal sync:', error);
  }
}

/**
 * Remove series from Sonarr that are tagged with our tags but no longer on the
 * Serializd list. This makes the Serializd list the single source of truth.
 * Mirrors syncMovieRemovals for the TV pipeline.
 */
async function syncSeriesRemovals(currentTmdbIds: number[]): Promise<void> {
  try {
    const tagIds = await getAllRequiredSeriesTagIds();
    if (tagIds.length === 0) {
      logger.warn('No tag IDs resolved — cannot determine which Sonarr series belong to this list. Skipping removal sync.');
      return;
    }

    const sonarrSeries = await getSeriesByTagIds(tagIds);
    const currentSet = new Set(currentTmdbIds);
    const excludedTagIds = await getExcludedSeriesTagIds();

    // Series in Sonarr (with our tags) that are NOT on the current Serializd list.
    const candidates = sonarrSeries.filter(s => !currentSet.has(s.tmdbId));

    const protectedCandidates = candidates.filter(s => excludedTagIds.some(tid => s.tags.includes(tid)));
    const toRemove = candidates.filter(s => !excludedTagIds.some(tid => s.tags.includes(tid)));

    if (toRemove.length === 0 && protectedCandidates.length === 0) {
      logger.debug('No changes needed — Sonarr and Serializd list are in sync.');
      return;
    }

    // Handle protected series: remove only this instance's tags (untag, don't delete).
    for (const series of protectedCandidates) {
      const ourTagsOnSeries = tagIds.filter(tid => series.tags.includes(tid));
      if (ourTagsOnSeries.length === 0) continue;

      if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Would untag "${series.title}" (TMDB: ${series.tmdbId}) — removing this list's tags; series kept (protected by another tag).`);
        continue;
      }

      try {
        await removeTagsFromSeries(series, ourTagsOnSeries);
        logger.info(`Untagged "${series.title}" (TMDB: ${series.tmdbId}) — no longer part of this list; series kept (protected by another tag).`);
      } catch {
        // error already logged in removeTagsFromSeries
      }
    }

    // Handle unprotected series: delete them entirely.
    for (const series of toRemove) {
      if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Would remove from Sonarr: "${series.title}" (TMDB: ${series.tmdbId}, deleteFiles=${env.DELETE_FILES}, addImportExclusion=${env.ADD_IMPORT_EXCLUSION})`);
        continue;
      }

      try {
        await deleteSeries(series.id, {
          deleteFiles: env.DELETE_FILES,
          addImportExclusion: env.ADD_IMPORT_EXCLUSION,
        });
        logger.info(`Removed from Sonarr: "${series.title}" (TMDB: ${series.tmdbId}, files ${env.DELETE_FILES ? 'deleted' : 'kept'})`);
      } catch (error) {
        logger.error(`Error removing "${series.title}" (ID: ${series.id}):`, error);
      }
    }

    // Mirror the removal in Plex: strip this list's labels from every series that
    // left the list (protected or not). Plex items and excluded labels are kept.
    if (isPlexEnabled()) {
      for (const series of candidates) {
        await unlabelSeries({ tmdbId: series.tmdbId }, series.title);
      }
    }
  } catch (error) {
    logger.error('Error during series removal sync:', error);
  }
}

export async function main() {
  startScheduledMonitoring();
}

export { startScheduledMonitoring, run, runMovies, runSeries, syncMovieRemovals, syncSeriesRemovals };

// Only run main if this file is executed directly
if (require.main === module) {
  main().catch(logger.error);
}
