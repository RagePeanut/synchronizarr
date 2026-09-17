jest.mock('../util/env', () => ({}));
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

import { SerializdScraper } from './serializd';
import { SerializdListType } from './index';

const jsonResponse = (data: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => data,
});

describe('SerializdScraper', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    // Speed up the internal sleep between watchlist pages / retries.
    jest.spyOn(global, 'setTimeout' as any).mockImplementation((fn: any) => { fn(); return 0 as any; });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('fetches a single-page watchlist and maps showId to tmdbId', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      totalPages: 1,
      items: [
        { showId: 100, showName: 'Alpha', seasonIds: [] },
        { showId: 200, showName: 'Beta', seasonIds: [] },
      ],
    })) as any;

    const scraper = new SerializdScraper('https://serializd.com/user/bob/watchlist', SerializdListType.WATCHLIST);
    const result = await scraper.getSeries();

    expect(result).toEqual([
      { tmdbId: 100, name: 'Alpha', seasons: [] },
      { tmdbId: 200, name: 'Beta', seasons: [] },
    ]);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/api/user/bob/watchlistpage_v2/1');
  });

  it('paginates a multi-page watchlist and de-duplicates by tmdbId', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ totalPages: 2, items: [{ showId: 1, showName: 'One', seasonIds: [] }] }))
      .mockResolvedValueOnce(jsonResponse({ totalPages: 2, items: [{ showId: 1, showName: 'One', seasonIds: [] }] })) as any;

    const scraper = new SerializdScraper('https://serializd.com/user/bob/watchlist', SerializdListType.WATCHLIST);
    const result = await scraper.getSeries();

    expect(result).toHaveLength(1);
    expect(result[0].tmdbId).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('resolves season ids to season numbers via show details', async () => {
    global.fetch = jest.fn()
      // watchlist page
      .mockResolvedValueOnce(jsonResponse({ totalPages: 1, items: [{ showId: 55, showName: 'Gamma', seasonIds: [900, 901] }] }))
      // show details lookup
      .mockResolvedValueOnce(jsonResponse({ seasons: [{ id: 900, seasonNumber: 1 }, { id: 901, seasonNumber: 2 }] })) as any;

    const scraper = new SerializdScraper('https://serializd.com/user/bob/watchlist', SerializdListType.WATCHLIST);
    const result = await scraper.getSeries();

    expect(result).toEqual([{ tmdbId: 55, name: 'Gamma', seasons: [1, 2] }]);
  });

  it('fetches a user list', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      shows: [{ show_id: 7, show_name: 'Delta', season_ids: [] }],
    })) as any;

    const scraper = new SerializdScraper('https://serializd.com/user/bob/lists/faves', SerializdListType.USER_LIST);
    const result = await scraper.getSeries();

    expect(result).toEqual([{ tmdbId: 7, name: 'Delta', seasons: [] }]);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/api/user/bob/list/faves');
  });

  it('fetches a public list keyed by trailing numeric id', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      listItems: [{ showId: 42, title: 'Epsilon' }],
    })) as any;

    const scraper = new SerializdScraper('https://serializd.com/list/Cool-Shows-321', SerializdListType.PUBLIC_LIST);
    const result = await scraper.getSeries();

    expect(result).toEqual([{ tmdbId: 42, name: 'Epsilon', seasons: [] }]);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/api/list/321');
  });

  it('skips items without a showId', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      totalPages: 1,
      items: [{ showName: 'No Id' }, { showId: 5, showName: 'Has Id', seasonIds: [] }],
    })) as any;

    const scraper = new SerializdScraper('https://serializd.com/user/bob/watchlist', SerializdListType.WATCHLIST);
    const result = await scraper.getSeries();

    expect(result).toEqual([{ tmdbId: 5, name: 'Has Id', seasons: [] }]);
  });

  it('falls back to monitoring all seasons when show details fetch fails', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ totalPages: 1, items: [{ showId: 9, showName: 'Zeta', seasonIds: [111] }] }))
      // show details fails on every retry
      .mockResolvedValue(jsonResponse({}, false, 500)) as any;

    const scraper = new SerializdScraper('https://serializd.com/user/bob/watchlist', SerializdListType.WATCHLIST);
    const result = await scraper.getSeries();

    expect(result).toEqual([{ tmdbId: 9, name: 'Zeta', seasons: [] }]);
  });

  it('throws when the API returns a 404', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, false, 404)) as any;

    const scraper = new SerializdScraper('https://serializd.com/user/bob/watchlist', SerializdListType.WATCHLIST);
    await expect(scraper.getSeries()).rejects.toThrow('Not found (404)');
  });

  it('extracts the TMDB id from alternate field names (tmdbId / mediaId)', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      listItems: [
        { tmdbId: 111, name: 'Aliased' },
        { mediaId: 222, title: 'MediaId' },
      ],
    })) as any;

    const scraper = new SerializdScraper('https://serializd.com/list/Whatever-9', SerializdListType.PUBLIC_LIST);
    const result = await scraper.getSeries();

    expect(result).toEqual([
      { tmdbId: 111, name: 'Aliased', seasons: [] },
      { tmdbId: 222, name: 'MediaId', seasons: [] },
    ]);
  });

  it('extracts the TMDB id and name from a nested show object', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      listItems: [
        { show: { id: 333, name: 'Nested Show' }, seasonIds: [] },
      ],
    })) as any;

    const scraper = new SerializdScraper('https://serializd.com/list/Nested-3', SerializdListType.PUBLIC_LIST);
    const result = await scraper.getSeries();

    expect(result).toEqual([{ tmdbId: 333, name: 'Nested Show', seasons: [] }]);
  });

  it('falls back to the bare `id` field when no show-specific id is present', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      listItems: [{ id: 444, title: 'BareId' }],
    })) as any;

    const scraper = new SerializdScraper('https://serializd.com/list/Bare-4', SerializdListType.PUBLIC_LIST);
    const result = await scraper.getSeries();

    expect(result).toEqual([{ tmdbId: 444, name: 'BareId', seasons: [] }]);
  });

  it('warns and skips an entry with no recognisable id', async () => {
    const logger = require('../util/logger');
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      listItems: [
        { somethingElse: true, title: 'Mystery' },
        { showId: 5, title: 'Good' },
      ],
    })) as any;

    const scraper = new SerializdScraper('https://serializd.com/list/Mixed-5', SerializdListType.PUBLIC_LIST);
    const result = await scraper.getSeries();

    expect(result).toEqual([{ tmdbId: 5, name: 'Good', seasons: [] }]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not extract a TMDB id'));
  });
});
