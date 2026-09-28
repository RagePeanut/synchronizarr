// Mock axios before importing plex
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
};

jest.mock('axios', () => {
  const isAxiosError = (e: any) => !!(e && e.isAxiosError);
  return {
    create: jest.fn(() => mockAxiosInstance),
    isAxiosError,
    default: {
      create: jest.fn(() => mockAxiosInstance),
      isAxiosError,
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
  unlabelSeries,
  describeError,
  __resetSectionCaches,
} from './plex';

// Build a fake Axios error shaped like the real thing for describeError tests.
const axiosError = (opts: {
  status?: number;
  statusText?: string;
  code?: string;
  method?: string;
  url?: string;
  message?: string;
}) => ({
  isAxiosError: true,
  code: opts.code,
  message: opts.message ?? 'Request failed',
  config: opts.method || opts.url ? { method: opts.method, url: opts.url } : undefined,
  response: opts.status ? { status: opts.status, statusText: opts.statusText } : undefined,
});

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

    it('matches a show by tvdb guid (tmdb absent)', async () => {
      mockEnv.SONARR_TAGS = 'tv-watchlist';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '2', type: 'show', title: 'TV Shows' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '80', title: 'Show', type: 'show', Guid: [{ id: 'tvdb://12345' }], Label: [] },
        ]));
      mockAxiosInstance.put.mockResolvedValue({});

      await labelSeries({ tvdbId: 12345 }, 'Show');

      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(1);
    });
  });

  describe('unlabelSeries', () => {
    it('removes the list label from a matching series', async () => {
      mockEnv.SONARR_TAGS = 'tv-watchlist';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '2', type: 'show', title: 'TV Shows' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '80', title: 'Show', type: 'show', Guid: [{ id: 'tmdb://5' }], Label: [{ tag: 'tv-watchlist' }] },
        ]));
      mockAxiosInstance.put.mockResolvedValue({});

      await unlabelSeries({ tmdbId: 5 }, 'Show');

      const url = mockAxiosInstance.put.mock.calls[0][0] as string;
      // Full clear: field emptied because the only label was removed.
      expect(url).toContain('label%5B0%5D.tag.tag=');
      expect(url).toContain('label.locked=1');
    });
  });

  // ── Edge / error branch coverage ──

  describe('early returns', () => {
    it('labelMovie does nothing when no labels are configured', async () => {
      mockEnv.RADARR_TAGS = undefined;
      await labelMovie({ tmdbId: 1 }, 'X');
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('unlabelMovie does nothing when no removable labels remain', async () => {
      mockEnv.RADARR_TAGS = 'collection';
      mockEnv.EXCLUDE_TAGS = 'collection'; // the only label is excluded → nothing removable
      await unlabelMovie({ tmdbId: 1 }, 'X');
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('labelSeries does nothing when no labels are configured', async () => {
      mockEnv.SONARR_TAGS = undefined;
      await labelSeries({ tmdbId: 1 }, 'X');
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('unlabelSeries does nothing when no removable labels remain', async () => {
      mockEnv.SONARR_TAGS = undefined;
      await unlabelSeries({ tmdbId: 1 }, 'X');
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('returns early when there are no matching sections', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      // Only a show library exists → no movie sections resolved.
      mockAxiosInstance.get.mockResolvedValueOnce(sectionsResponse([{ key: '9', type: 'show', title: 'TV' }]));
      await labelMovie({ tmdbId: 1 }, 'X');
      // Section lookup happened once; no item query / PUT.
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });

    it('labelSeries returns early when there are no matching sections', async () => {
      mockEnv.SONARR_TAGS = 'tv-watchlist';
      mockAxiosInstance.get.mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]));
      await labelSeries({ tmdbId: 1 }, 'X');
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });

    it('unlabelSeries returns early when there are no matching sections', async () => {
      mockEnv.SONARR_TAGS = 'tv-watchlist';
      mockAxiosInstance.get.mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]));
      await unlabelSeries({ tmdbId: 1 }, 'X');
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });
  });

  describe('section resolution edge cases', () => {
    it('returns [] and warns when a configured library is not found', async () => {
      mockEnv.PLEX_MOVIE_LIBRARY = 'Nonexistent';
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get.mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]));
      await labelMovie({ tmdbId: 1 }, 'X');
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });

    it('warns when auto-detect finds no libraries of the type', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get.mockResolvedValueOnce(sectionsResponse([]));
      await labelMovie({ tmdbId: 1 }, 'X');
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });

    it('returns [] when fetching sections throws', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('network'));
      await labelMovie({ tmdbId: 1 }, 'X');
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });

    it('handles a missing Directory list in the sections response', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { MediaContainer: {} } });
      await labelMovie({ tmdbId: 1 }, 'X');
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });
  });

  describe('findItem edge cases', () => {
    it('treats a non-array Metadata as no items', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce({ data: { MediaContainer: {} } });
      await labelMovie({ tmdbId: 603 }, 'X');
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });

    it('continues past a section query error and finds the item in the next section', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([
          { key: '1', type: 'movie', title: 'A' },
          { key: '2', type: 'movie', title: 'B' },
        ]))
        .mockRejectedValueOnce(new Error('boom')) // section 1 query fails
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '5', title: 'M', type: 'movie', Guid: [{ id: 'tmdb://603' }], Label: [] },
        ]));
      mockAxiosInstance.put.mockResolvedValue({});
      await labelMovie({ tmdbId: 603 }, 'M');
      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(1);
    });

    it('ignores guids with no id and non-matching ids', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '5', title: 'M', type: 'movie', Guid: [{}, { id: 'imdb://tt999' }], Label: [] },
        ]));
      // Match by imdb only.
      mockAxiosInstance.put.mockResolvedValue({});
      await labelMovie({ tmdbId: 603, imdbId: 'tt999' }, 'M');
      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(1);
    });
  });

  describe('write error handling', () => {
    it('logs but does not throw when the label PUT fails (add)', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '5', title: 'M', type: 'movie', Guid: [{ id: 'tmdb://603' }], Label: [] },
        ]));
      mockAxiosInstance.put.mockRejectedValue(new Error('put failed'));
      await expect(labelMovie({ tmdbId: 603 }, 'M')).resolves.toBeUndefined();
    });

    it('logs but does not throw when the label PUT fails (remove)', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '5', title: 'M', type: 'movie', Guid: [{ id: 'tmdb://603' }], Label: [{ tag: 'watchlist' }] },
        ]));
      mockAxiosInstance.put.mockRejectedValue(new Error('put failed'));
      await expect(unlabelMovie({ tmdbId: 603 }, 'M')).resolves.toBeUndefined();
    });

    it('unlabelMovie skips silently when the item is not found', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([]));
      await unlabelMovie({ tmdbId: 603 }, 'M');
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });

    it('unlabelMovie respects DRY_RUN (no PUT)', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockEnv.DRY_RUN = true;
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValueOnce(itemsResponse([
          { ratingKey: '5', title: 'M', type: 'movie', Guid: [{ id: 'tmdb://603' }], Label: [{ tag: 'watchlist' }] },
        ]));
      await unlabelMovie({ tmdbId: 603 }, 'M');
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });
  });

  describe('section cache', () => {
    it('resolves sections once and reuses them across calls', async () => {
      mockEnv.RADARR_TAGS = 'watchlist';
      mockAxiosInstance.get
        .mockResolvedValueOnce(sectionsResponse([{ key: '1', type: 'movie', title: 'Movies' }]))
        .mockResolvedValue(itemsResponse([])); // subsequent item queries
      await labelMovie({ tmdbId: 1 }, 'A');
      await labelMovie({ tmdbId: 2 }, 'B');
      // /library/sections fetched only once (call 1); calls 2 & 3 are item queries.
      const sectionCalls = mockAxiosInstance.get.mock.calls.filter(c => c[0] === '/library/sections');
      expect(sectionCalls).toHaveLength(1);
    });
  });

  describe('describeError', () => {
    it('surfaces status + method + url and a token hint for 401', () => {
      const msg = describeError(axiosError({ status: 401, statusText: 'Unauthorized', method: 'get', url: '/library/sections' }));
      expect(msg).toContain('HTTP 401 Unauthorized');
      expect(msg).toContain('on GET /library/sections');
      expect(msg).toContain('PLEX_TOKEN');
    });

    it('hints at an unreachable URL for connection errors', () => {
      expect(describeError(axiosError({ code: 'ECONNREFUSED' }))).toContain('reachable');
      expect(describeError(axiosError({ code: 'ENOTFOUND' }))).toContain('reachable');
    });

    it('hints at a timeout', () => {
      expect(describeError(axiosError({ code: 'ETIMEDOUT' }))).toContain('did not respond');
    });

    it('hints at a self-signed TLS certificate', () => {
      expect(describeError(axiosError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }))).toContain('self-signed');
    });

    it('falls back to the message for a plain Error', () => {
      expect(describeError(new Error('boom'))).toBe('boom');
    });

    it('stringifies non-error values', () => {
      expect(describeError('nope')).toBe('nope');
    });
  });
});
