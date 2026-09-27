// Mock axios before importing plex
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
};

jest.mock('axios', () => {
  return {
    create: jest.fn(() => mockAxiosInstance),
    default: {
      create: jest.fn(() => mockAxiosInstance),
    },
  };
});

// Mock logger
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock env — mutable so individual tests can tweak fields.
const mockEnv: Record<string, unknown> = {
  PLEX_URL: 'http://localhost:32400',
  PLEX_TOKEN: 'test-token',
  PLEX_MOVIE_LIBRARY: undefined,
  PLEX_TV_LIBRARY: undefined,
  PLEX_MOVIE_TAGS: undefined,
  PLEX_TV_TAGS: undefined,
  RADARR_TAGS: 'watchlist',
  SONARR_TAGS: 'tv-watchlist',
  EXCLUDE_TAGS: undefined,
  DRY_RUN: false,
};
jest.mock('../util/env', () => ({
  __esModule: true,
  get default() {
    return mockEnv;
  },
}));

import {
  getMovieLabels,
  getTvLabels,
  getRemovableLabels,
  labelMovie,
  unlabelMovie,
  labelSeries,
  __resetSectionCaches,
} from './plex';

// Helpers to build Plex API responses.
const sectionsResponse = (dirs: Array<{ key: string; type: string; title: string }>) => ({
  data: { MediaContainer: { Directory: dirs } },
});
const itemsResponse = (items: any[]) => ({
  data: { MediaContainer: { Metadata: items } },
});

describe('plex API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetSectionCaches();
    // Reset env to defaults.
    mockEnv.PLEX_MOVIE_LIBRARY = undefined;
    mockEnv.PLEX_TV_LIBRARY = undefined;
    mockEnv.PLEX_MOVIE_TAGS = undefined;
    mockEnv.PLEX_TV_TAGS = undefined;
    mockEnv.RADARR_TAGS = 'watchlist';
    mockEnv.SONARR_TAGS = 'tv-watchlist';
    mockEnv.EXCLUDE_TAGS = undefined;
    mockEnv.DRY_RUN = false;
  });

  describe('label resolution', () => {
    it('defaults movie labels to RADARR_TAGS (no letterboxd default)', () => {
      mockEnv.RADARR_TAGS = 'watchlist, collection';
      expect(getMovieLabels()).toEqual(['watchlist', 'collection']);
    });

    it('uses PLEX_MOVIE_TAGS override when set', () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockEnv.PLEX_MOVIE_TAGS = 'Collection';
      expect(getMovieLabels()).toEqual(['Collection']);
    });

    it('defaults tv labels to SONARR_TAGS and uses PLEX_TV_TAGS override', () => {
      mockEnv.SONARR_TAGS = 'shows';
      expect(getTvLabels()).toEqual(['shows']);
      mockEnv.PLEX_TV_TAGS = 'MyShows';
      expect(getTvLabels()).toEqual(['MyShows']);
    });

    it('returns empty array when no tags configured', () => {
      mockEnv.RADARR_TAGS = undefined;
      expect(getMovieLabels()).toEqual([]);
    });
  });

  describe('getRemovableLabels', () => {
    it('drops excluded labels (case-insensitive), keeps the rest', () => {
      mockEnv.EXCLUDE_TAGS = 'Collection';
      expect(getRemovableLabels(['watchlist', 'collection'])).toEqual(['watchlist']);
    });

    it('keeps all labels when none are excluded', () => {
      mockEnv.EXCLUDE_TAGS = undefined;
      expect(getRemovableLabels(['watchlist'])).toEqual(['watchlist']);
    });
  });

  describe('labelMovie', () => {
    it('adds the label to a matching movie via a full PUT of the label set', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '55', title: 'The Matrix', type: 'movie', Guid: [{ id: 'tmdb://603' }], Label: [] },
        ]));
      mockAxiosInstance.put.mockResolvedValue({});

      await labelMovie({ tmdbId: 603 }, 'The Matrix');

      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(1);
      const url = mockAxiosInstance.put.mock.calls[0][0] as string;
      expect(url).toContain('/library/sections/1/all?');
      expect(url).toContain('id=55');
      expect(url).toContain('label%5B0%5D.tag.tag=watchlist');
      expect(url).toContain('label.locked=1');
    });

    it('preserves existing labels when adding a new one', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '55', title: 'The Matrix', type: 'movie', Guid: [{ id: 'tmdb://603' }], Label: [{ tag: 'manual' }] },
        ]));
      mockAxiosInstance.put.mockResolvedValue({});

      await labelMovie({ tmdbId: 603 }, 'The Matrix');

      const url = mockAxiosInstance.put.mock.calls[0][0] as string;
      expect(url).toContain('label%5B0%5D.tag.tag=manual');
      expect(url).toContain('label%5B1%5D.tag.tag=watchlist');
    });

    it('does nothing (no PUT) when the label is already present', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '55', title: 'The Matrix', type: 'movie', Guid: [{ id: 'tmdb://603' }], Label: [{ tag: 'watchlist' }] },
        ]));

      await labelMovie({ tmdbId: 603 }, 'The Matrix');

      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });

    it('skips silently when the movie is not found in Plex', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '99', title: 'Other', type: 'movie', Guid: [{ id: 'tmdb://111' }], Label: [] },
        ]));

      await labelMovie({ tmdbId: 603 }, 'The Matrix');

      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });

    it('respects DRY_RUN (no PUT)', async () => {
      mockEnv.DRY_RUN = true;
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '55', title: 'The Matrix', type: 'movie', Guid: [{ id: 'tmdb://603' }], Label: [] },
        ]));

      await labelMovie({ tmdbId: 603 }, 'The Matrix');

      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });

    it('uses the explicitly configured movie library by title', async () => {
      mockEnv.PLEX_MOVIE_LIBRARY = 'Films';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([
          { key: '1', type: 'movie', title: 'Movies' },
          { key: '2', type: 'movie', title: 'Films' },
        ]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '7', title: 'The Matrix', type: 'movie', Guid: [{ id: 'tmdb://603' }], Label: [] },
        ]));
      mockAxiosInstance.put.mockResolvedValue({});

      await labelMovie({ tmdbId: 603 }, 'The Matrix');

      // Second GET must query section key 2 (Films), not 1 (Movies).
      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(2, '/library/sections/2/all', expect.anything());
    });
  });

  describe('unlabelMovie', () => {
    it('removes only this list\'s label and keeps excluded + unknown labels', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockEnv.EXCLUDE_TAGS = 'collection';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([
          {
            ratingKey: '55',
            title: 'The Matrix',
            type: 'movie',
            Guid: [{ id: 'tmdb://603' }],
            Label: [{ tag: 'watchlist' }, { tag: 'collection' }, { tag: 'manual' }],
          },
        ]));
      mockAxiosInstance.put.mockResolvedValue({});

      await unlabelMovie({ tmdbId: 603 }, 'The Matrix');

      const url = mockAxiosInstance.put.mock.calls[0][0] as string;
      // watchlist removed; collection + manual preserved.
      expect(url).not.toContain('watchlist');
      expect(url).toContain('label%5B0%5D.tag.tag=collection');
      expect(url).toContain('label%5B1%5D.tag.tag=manual');
    });

    it('does nothing when the item has none of this list\'s labels', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '55', title: 'The Matrix', type: 'movie', Guid: [{ id: 'tmdb://603' }], Label: [{ tag: 'collection' }] },
        ]));

      await unlabelMovie({ tmdbId: 603 }, 'The Matrix');

      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });
  });

  describe('labelSeries', () => {
    it('matches a show by tvdb guid and auto-detects the show library', async () => {
      mockEnv.SONARR_TAGS = 'tv-watchlist';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([
          { key: '1', type: 'movie', title: 'Movies' },
          { key: '2', type: 'show', title: 'TV Shows' },
        ]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '80', title: 'Severance', type: 'show', Guid: [{ id: 'tmdb://95396' }], Label: [] },
        ]));
      mockAxiosInstance.put.mockResolvedValue({});

      await labelSeries({ tmdbId: 95396 }, 'Severance');

      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(2, '/library/sections/2/all', expect.anything());
      const url = mockAxiosInstance.put.mock.calls[0][0] as string;
      expect(url).toContain('label%5B0%5D.tag.tag=tv-watchlist');
    });
  });
});
