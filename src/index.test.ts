// Mutable mock state, read lazily by the env mock factory. All names are
// mock-prefixed so Jest allows referencing them from the hoisted jest.mock().
const mockEnv: any = {};
const mockFlags = { radarr: true, sonarr: false, plex: false };

jest.mock('./util/env', () => ({
  __esModule: true,
  default: mockEnv,
  isRadarrEnabled: () => mockFlags.radarr,
  isSonarrEnabled: () => mockFlags.sonarr,
  isPlexEnabled: () => mockFlags.plex,
}));
jest.mock('./util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('./scraper');
jest.mock('./scraper-tv');
jest.mock('./api/radarr');
jest.mock('./api/sonarr');
jest.mock('./api/plex');

import * as scraperModule from './scraper';
import * as scraperTvModule from './scraper-tv';
import * as radarrModule from './api/radarr';
import * as sonarrModule from './api/sonarr';
import * as plexModule from './api/plex';
import {
  main,
  startScheduledMonitoring,
  run,
  runMovies,
  runSeries,
  syncMovieRemovals,
  syncSeriesRemovals,
} from './index';

const resetEnv = () => {
  // Reset the SAME object reference that index.ts captured at import time.
  Object.keys(mockEnv).forEach(k => delete mockEnv[k]);
  Object.assign(mockEnv, {
    CHECK_INTERVAL_MINUTES: 10,
    LETTERBOXD_URL: 'https://letterboxd.com/user/watchlist',
    SERIALIZD_URL: 'https://serializd.com/user/bob/watchlist',
    SYNC_MODE: 'add',
    DRY_RUN: false,
    DELETE_FILES: true,
    ADD_IMPORT_EXCLUSION: false,
  });
  mockFlags.radarr = true;
  mockFlags.sonarr = false;
  mockFlags.plex = false;
};

// Seed before any test constructs run.
resetEnv();

describe('main application', () => {
  let setIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetEnv();
    jest.useFakeTimers();
    setIntervalSpy = jest.spyOn(global, 'setInterval');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    setIntervalSpy.mockRestore();
  });

  describe('startScheduledMonitoring', () => {
    it('should run immediately and schedule interval', async () => {
      const mockMovies = [{ id: 1, name: 'Test Movie', slug: '/film/test-movie/', tmdbId: '123', imdbId: null, publishedYear: null }];
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();
      await Promise.resolve();

      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalledTimes(1);
      expect(radarrModule.upsertMovies).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 600000);
    });

    it('logs sync-mode and sonarr-enabled notices', async () => {
      mockEnv.SYNC_MODE = 'sync';
      mockFlags.sonarr = true;
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue([]);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);
      (radarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([]);
      (scraperTvModule.fetchSeriesFromUrl as jest.Mock).mockResolvedValue([]);
      (sonarrModule.upsertSeries as jest.Mock).mockResolvedValue(undefined);
      (sonarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([]);

      startScheduledMonitoring();
      await Promise.resolve();

      expect(setIntervalSpy).toHaveBeenCalled();
    });

    it('runs again on interval tick', async () => {
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue([]);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();
      await Promise.resolve();
      jest.clearAllMocks();
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue([]);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      jest.advanceTimersByTime(600000);
      await Promise.resolve();

      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe('main', () => {
    it('should call startScheduledMonitoring', async () => {
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue([]);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);
      await main();
      await Promise.resolve();
      expect(setIntervalSpy).toHaveBeenCalled();
    });
  });

  describe('run', () => {
    it('runs only the movie pipeline when only Radarr is enabled', async () => {
      mockFlags.radarr = true;
      mockFlags.sonarr = false;
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue([]);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      await run();

      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalled();
      expect(scraperTvModule.fetchSeriesFromUrl).not.toHaveBeenCalled();
    });

    it('runs only the series pipeline when only Sonarr is enabled', async () => {
      mockFlags.radarr = false;
      mockFlags.sonarr = true;
      (scraperTvModule.fetchSeriesFromUrl as jest.Mock).mockResolvedValue([]);
      (sonarrModule.upsertSeries as jest.Mock).mockResolvedValue(undefined);

      await run();

      expect(scraperTvModule.fetchSeriesFromUrl).toHaveBeenCalled();
      expect(scraperModule.fetchMoviesFromUrl).not.toHaveBeenCalled();
    });

    it('runs both pipelines when both are enabled', async () => {
      mockFlags.radarr = true;
      mockFlags.sonarr = true;
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue([]);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);
      (scraperTvModule.fetchSeriesFromUrl as jest.Mock).mockResolvedValue([]);
      (sonarrModule.upsertSeries as jest.Mock).mockResolvedValue(undefined);

      await run();

      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalled();
      expect(scraperTvModule.fetchSeriesFromUrl).toHaveBeenCalled();
    });
  });

  describe('runMovies', () => {
    it('fetches, upserts, and (in sync mode) reconciles removals with parsed tmdb ids', async () => {
      mockEnv.SYNC_MODE = 'sync';
      const movies = [
        { id: 1, name: 'A', slug: '/film/a/', tmdbId: '123', imdbId: null, publishedYear: null },
        { id: 2, name: 'B', slug: '/film/b/', tmdbId: null, imdbId: null, publishedYear: null },
      ];
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(movies);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);
      (radarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([10]);
      (radarrModule.getMoviesByTagIds as jest.Mock).mockResolvedValue([]);
      (radarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([]);

      await runMovies();

      expect(radarrModule.upsertMovies).toHaveBeenCalledWith(movies);
      expect(radarrModule.getMoviesByTagIds).toHaveBeenCalledWith([10]);
    });

    it('does not reconcile removals in add mode', async () => {
      mockEnv.SYNC_MODE = 'add';
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue([]);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      await runMovies();

      expect(radarrModule.getAllRequiredTagIds).not.toHaveBeenCalled();
    });

    it('swallows errors', async () => {
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockRejectedValue(new Error('boom'));
      await expect(runMovies()).resolves.toBeUndefined();
    });

    it('labels movies in Plex (by tmdb id) when Plex is enabled', async () => {
      mockEnv.SYNC_MODE = 'add';
      mockFlags.plex = true;
      const movies = [
        { id: 1, name: 'A', slug: '/film/a/', tmdbId: '123', imdbId: 'tt1', publishedYear: null },
        { id: 2, name: 'B', slug: '/film/b/', tmdbId: null, imdbId: null, publishedYear: null },
      ];
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(movies);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);
      (plexModule.labelMovie as jest.Mock).mockResolvedValue(undefined);

      await runMovies();

      // Only the movie with a tmdb id is labelled.
      expect(plexModule.labelMovie).toHaveBeenCalledTimes(1);
      expect(plexModule.labelMovie).toHaveBeenCalledWith({ tmdbId: 123, imdbId: 'tt1' }, 'A');
    });

    it('does not touch Plex when Plex is disabled', async () => {
      mockEnv.SYNC_MODE = 'add';
      mockFlags.plex = false;
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue([
        { id: 1, name: 'A', slug: '/film/a/', tmdbId: '123', imdbId: null, publishedYear: null },
      ]);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      await runMovies();

      expect(plexModule.labelMovie).not.toHaveBeenCalled();
    });
  });

  describe('runSeries', () => {
    it('fetches, upserts, and (in sync mode) reconciles removals', async () => {
      mockEnv.SYNC_MODE = 'sync';
      const series = [{ tmdbId: 55, name: 'Show', seasons: [] }];
      (scraperTvModule.fetchSeriesFromUrl as jest.Mock).mockResolvedValue(series);
      (sonarrModule.upsertSeries as jest.Mock).mockResolvedValue(undefined);
      (sonarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([20]);
      (sonarrModule.getSeriesByTagIds as jest.Mock).mockResolvedValue([]);
      (sonarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([]);

      await runSeries();

      expect(sonarrModule.upsertSeries).toHaveBeenCalledWith(series);
      expect(sonarrModule.getSeriesByTagIds).toHaveBeenCalledWith([20]);
    });

    it('swallows errors', async () => {
      (scraperTvModule.fetchSeriesFromUrl as jest.Mock).mockRejectedValue(new Error('boom'));
      await expect(runSeries()).resolves.toBeUndefined();
    });
  });

  describe('syncMovieRemovals', () => {
    it('bails when no tag IDs resolve', async () => {
      (radarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([]);
      await syncMovieRemovals([1]);
      expect(radarrModule.getMoviesByTagIds).not.toHaveBeenCalled();
    });

    it('does nothing when Radarr and the list are in sync', async () => {
      (radarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([10]);
      (radarrModule.getMoviesByTagIds as jest.Mock).mockResolvedValue([{ id: 1, title: 'A', tmdbId: 123, tags: [10] }]);
      (radarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([]);

      await syncMovieRemovals([123]);

      expect(radarrModule.deleteMovie).not.toHaveBeenCalled();
      expect(radarrModule.removeTagsFromMovie).not.toHaveBeenCalled();
    });

    it('deletes unprotected movies no longer on the list', async () => {
      (radarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([10]);
      (radarrModule.getMoviesByTagIds as jest.Mock).mockResolvedValue([{ id: 7, title: 'Gone', tmdbId: 999, tags: [10] }]);
      (radarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([]);
      (radarrModule.deleteMovie as jest.Mock).mockResolvedValue(undefined);

      await syncMovieRemovals([123]);

      expect(radarrModule.deleteMovie).toHaveBeenCalledWith(7, { deleteFiles: true, addImportExclusion: false });
    });

    it('untags (does not delete) protected movies', async () => {
      (radarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([10]);
      (radarrModule.getMoviesByTagIds as jest.Mock).mockResolvedValue([{ id: 8, title: 'Keep', tmdbId: 888, tags: [10, 99] }]);
      (radarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([99]);
      (radarrModule.removeTagsFromMovie as jest.Mock).mockResolvedValue(undefined);

      await syncMovieRemovals([123]);

      expect(radarrModule.removeTagsFromMovie).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }), [10]);
      expect(radarrModule.deleteMovie).not.toHaveBeenCalled();
    });

    it('strips Plex labels for every movie that left the list (protected or not) when Plex is enabled', async () => {
      mockFlags.plex = true;
      (radarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([10]);
      (radarrModule.getMoviesByTagIds as jest.Mock).mockResolvedValue([
        { id: 7, title: 'Gone', tmdbId: 999, tags: [10] },
        { id: 8, title: 'Keep', tmdbId: 888, tags: [10, 99] },
      ]);
      (radarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([99]);
      (radarrModule.deleteMovie as jest.Mock).mockResolvedValue(undefined);
      (radarrModule.removeTagsFromMovie as jest.Mock).mockResolvedValue(undefined);
      (plexModule.unlabelMovie as jest.Mock).mockResolvedValue(undefined);

      await syncMovieRemovals([123]);

      expect(plexModule.unlabelMovie).toHaveBeenCalledWith({ tmdbId: 999 }, 'Gone');
      expect(plexModule.unlabelMovie).toHaveBeenCalledWith({ tmdbId: 888 }, 'Keep');
      expect(plexModule.unlabelMovie).toHaveBeenCalledTimes(2);
    });

    it('logs instead of acting in dry-run mode', async () => {
      mockEnv.DRY_RUN = true;
      (radarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([10]);
      (radarrModule.getMoviesByTagIds as jest.Mock).mockResolvedValue([
        { id: 7, title: 'Gone', tmdbId: 999, tags: [10] },
        { id: 8, title: 'Keep', tmdbId: 888, tags: [10, 99] },
      ]);
      (radarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([99]);

      await syncMovieRemovals([123]);

      expect(radarrModule.deleteMovie).not.toHaveBeenCalled();
      expect(radarrModule.removeTagsFromMovie).not.toHaveBeenCalled();
    });

    it('handles delete errors without throwing', async () => {
      (radarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([10]);
      (radarrModule.getMoviesByTagIds as jest.Mock).mockResolvedValue([{ id: 7, title: 'Gone', tmdbId: 999, tags: [10] }]);
      (radarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([]);
      (radarrModule.deleteMovie as jest.Mock).mockRejectedValue(new Error('fail'));

      await expect(syncMovieRemovals([123])).resolves.toBeUndefined();
    });

    it('swallows top-level errors', async () => {
      (radarrModule.getAllRequiredTagIds as jest.Mock).mockRejectedValue(new Error('boom'));
      await expect(syncMovieRemovals([1])).resolves.toBeUndefined();
    });
  });

  describe('syncSeriesRemovals', () => {
    it('bails when no tag IDs resolve', async () => {
      (sonarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([]);
      await syncSeriesRemovals([1]);
      expect(sonarrModule.getSeriesByTagIds).not.toHaveBeenCalled();
    });

    it('does nothing when Sonarr and the list are in sync', async () => {
      (sonarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([20]);
      (sonarrModule.getSeriesByTagIds as jest.Mock).mockResolvedValue([{ id: 1, title: 'S', tmdbId: 55, tags: [20] }]);
      (sonarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([]);

      await syncSeriesRemovals([55]);

      expect(sonarrModule.deleteSeries).not.toHaveBeenCalled();
      expect(sonarrModule.removeTagsFromSeries).not.toHaveBeenCalled();
    });

    it('deletes unprotected series no longer on the list', async () => {
      (sonarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([20]);
      (sonarrModule.getSeriesByTagIds as jest.Mock).mockResolvedValue([{ id: 7, title: 'Gone', tmdbId: 999, tags: [20] }]);
      (sonarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([]);
      (sonarrModule.deleteSeries as jest.Mock).mockResolvedValue(undefined);

      await syncSeriesRemovals([55]);

      expect(sonarrModule.deleteSeries).toHaveBeenCalledWith(7, { deleteFiles: true, addImportExclusion: false });
    });

    it('untags (does not delete) protected series', async () => {
      (sonarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([20]);
      (sonarrModule.getSeriesByTagIds as jest.Mock).mockResolvedValue([{ id: 8, title: 'Keep', tmdbId: 888, tags: [20, 99] }]);
      (sonarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([99]);
      (sonarrModule.removeTagsFromSeries as jest.Mock).mockResolvedValue(undefined);

      await syncSeriesRemovals([55]);

      expect(sonarrModule.removeTagsFromSeries).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }), [20]);
      expect(sonarrModule.deleteSeries).not.toHaveBeenCalled();
    });

    it('logs instead of acting in dry-run mode', async () => {
      mockEnv.DRY_RUN = true;
      (sonarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([20]);
      (sonarrModule.getSeriesByTagIds as jest.Mock).mockResolvedValue([
        { id: 7, title: 'Gone', tmdbId: 999, tags: [20] },
        { id: 8, title: 'Keep', tmdbId: 888, tags: [20, 99] },
      ]);
      (sonarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([99]);

      await syncSeriesRemovals([55]);

      expect(sonarrModule.deleteSeries).not.toHaveBeenCalled();
      expect(sonarrModule.removeTagsFromSeries).not.toHaveBeenCalled();
    });

    it('handles delete errors without throwing', async () => {
      (sonarrModule.getAllRequiredTagIds as jest.Mock).mockResolvedValue([20]);
      (sonarrModule.getSeriesByTagIds as jest.Mock).mockResolvedValue([{ id: 7, title: 'Gone', tmdbId: 999, tags: [20] }]);
      (sonarrModule.getExcludedTagIds as jest.Mock).mockResolvedValue([]);
      (sonarrModule.deleteSeries as jest.Mock).mockRejectedValue(new Error('fail'));

      await expect(syncSeriesRemovals([55])).resolves.toBeUndefined();
    });

    it('swallows top-level errors', async () => {
      (sonarrModule.getAllRequiredTagIds as jest.Mock).mockRejectedValue(new Error('boom'));
      await expect(syncSeriesRemovals([1])).resolves.toBeUndefined();
    });
  });
});
