# synchronizarr

A fork of [Lettarrboxd](https://github.com/ryanpag3/lettarrboxd) with **bidirectional sync** and **Serializd → Sonarr** support: movies removed from your Letterboxd list are also removed from Radarr, and TV shows on your Serializd lists are synced to Sonarr the same way.

## What's new vs upstream Lettarrboxd

- **Serializd → Sonarr (TV shows)**: point `SERIALIZD_URL` at a Serializd watchlist or list and configure `SONARR_*`, and your tracked shows are added to Sonarr — with the same tagging, sync, and protection features as the movie side. You can run the Letterboxd→Radarr pipeline, the Serializd→Sonarr pipeline, or **both at once**.
- **Sync mode** (`SYNC_MODE=sync`): makes your source list the single source of truth. Items added to the list are added to Radarr/Sonarr; items removed from the list are removed from Radarr/Sonarr (with optional file deletion).
- **Removal protection** (`EXCLUDE_TAGS`): protect items carrying specific tags from sync removal — essential when running multiple sync instances (e.g. a watchlist that auto-cleans watched titles alongside a protected collection).
- **Tag updating for existing items** (`UPDATE_EXISTING_TAGS=true`): when an item already exists in Radarr/Sonarr (e.g. added by another instance), the configured tags are applied to it instead of silently skipping. Required for sync mode to work correctly. Defaults to `false` to preserve original behavior.
- Fully **backward-compatible**: if you only set the Letterboxd/Radarr variables and don't set `SYNC_MODE`, the behavior is identical to the original upstream Lettarrboxd.

## Overview

synchronizarr monitors your Letterboxd lists (watchlists, regular lists, watched movies, filmographies, collections, etc.) and syncs them with Radarr, and monitors your Serializd lists/watchlists and syncs them with Sonarr. It runs continuously, checking for updates at configurable intervals. Both pipelines share the same scheduler and sync-behavior settings.

Serializd is a TMDB-backed TV tracking site, so a show's Serializd id is its TMDB id. Because Sonarr keys series on TVDB, synchronizarr resolves each show through Sonarr's own lookup (`/api/v3/series/lookup?term=tmdb:<id>`) before adding it, so the correct series is matched automatically.

## Supported Letterboxd URLs

The application supports various types of Letterboxd URLs for the `LETTERBOXD_URL` environment variable:

- **Watchlists**: `https://letterboxd.com/username/watchlist/`
- **Regular Lists**: `https://letterboxd.com/username/list/list-name/`
- **Watched Movies**: `https://letterboxd.com/username/films/`
- **Collections**: `https://letterboxd.com/films/in/collection-name/`
- **Popular Movies**: `https://letterboxd.com/films/popular/`
- **Actor Filmography**: `https://letterboxd.com/actor/actor-name/`
- **Director Filmography**: `https://letterboxd.com/director/director-name/`
- **Writer Filmography**: `https://letterboxd.com/writer/writer-name/`

### Examples
```bash
# User's watchlist
LETTERBOXD_URL=https://letterboxd.com/moviefan123/watchlist/

# User's custom list
LETTERBOXD_URL=https://letterboxd.com/dave/list/official-top-250-narrative-feature-films/

# User's watched movies
LETTERBOXD_URL=https://letterboxd.com/moviefan123/films/

# Movie collection
LETTERBOXD_URL=https://letterboxd.com/films/in/the-dark-knight-collection/

# Popular movies
LETTERBOXD_URL=https://letterboxd.com/films/popular/

# Another user's list
LETTERBOXD_URL=https://letterboxd.com/criterion/list/the-criterion-collection/

# Actor filmography (e.g., Tom Hanks)
LETTERBOXD_URL=https://letterboxd.com/actor/tom-hanks/

# Director filmography (e.g., Christopher Nolan)
LETTERBOXD_URL=https://letterboxd.com/director/christopher-nolan/

# Writer filmography (e.g., Aaron Sorkin)
LETTERBOXD_URL=https://letterboxd.com/writer/aaron-sorkin/
```

**Note**: All Letterboxd lists must be public for the application to access them.

## Supported Serializd URLs

To sync TV shows to Sonarr, set the `SERIALIZD_URL` environment variable to one of:

- **Watchlists**: `https://serializd.com/user/username/watchlist`
- **User Lists**: `https://serializd.com/user/username/lists/list-slug`
- **Public Lists**: `https://serializd.com/list/public-list-slug-or-id`

### Examples
```bash
# A user's Serializd watchlist
SERIALIZD_URL=https://serializd.com/user/tvfan123/watchlist

# A user's custom list
SERIALIZD_URL=https://serializd.com/user/tvfan123/lists/comfort-shows

# A public list
SERIALIZD_URL=https://serializd.com/list/best-of-2024-4567
```

**Note**: Serializd lists/watchlists must be public. Season selections made on Serializd are honored — if you track only specific seasons of a show, only those seasons are monitored in Sonarr; otherwise all seasons are monitored (see `SONARR_MONITOR_SEASONS` to change the default).

## Quick Start

### Prebuilt image (GitHub Container Registry)

Prebuilt multi-arch images (`linux/amd64` + `linux/arm64`) are published automatically to the [GitHub Container Registry](https://ghcr.io) by CI — no Docker Hub account or manual build required. Just pull:

```bash
docker pull ghcr.io/ragepeanut/synchronizarr:latest
```

- `:latest` — tracks the newest code merged to `main` (refreshed on every push to `main`).
- `vX.Y.Z` / `vX.Y` / `vX` — published on each GitHub release.

> The image is private until you make it public: on GitHub go to your profile → **Packages** → `synchronizarr` → **Package settings** → set visibility to **Public**. If you'd rather keep it private, run `docker login ghcr.io -u <your-username>` on your host once, using a personal access token with the `read:packages` scope.

### Docker

```bash
docker run -d \
  --name synchronizarr \
  -e LETTERBOXD_URL=https://letterboxd.com/your_username/watchlist/ \
  -e RADARR_API_URL=http://your-radarr:7878 \
  -e RADARR_API_KEY=your_api_key \
  -e RADARR_QUALITY_PROFILE="HD-1080p" \
  -e RADARR_TAGS="watchlist,must-watch" \
  -e DRY_RUN=false \
  ghcr.io/ragepeanut/synchronizarr:latest
```

For testing purposes, you can enable dry run mode:
```bash
docker run -d \
  --name synchronizarr-test \
  -e LETTERBOXD_URL=https://letterboxd.com/your_username/watchlist/ \
  -e RADARR_API_URL=http://your-radarr:7878 \
  -e RADARR_API_KEY=your_api_key \
  -e RADARR_QUALITY_PROFILE="HD-1080p" \
  -e DRY_RUN=true \
  ghcr.io/ragepeanut/synchronizarr:latest
```
See [docker-compose.yaml](./docker-compose.yaml) for complete example.

### Serializd → Sonarr (TV shows)

Run the TV pipeline on its own:

```bash
docker run -d \
  --name synchronizarr-tv \
  -e SERIALIZD_URL=https://serializd.com/user/your_username/watchlist \
  -e SONARR_API_URL=http://your-sonarr:8989 \
  -e SONARR_API_KEY=your_api_key \
  -e SONARR_QUALITY_PROFILE="HD-1080p" \
  -e SONARR_TAGS="serializd-watchlist" \
  -e DRY_RUN=false \
  ghcr.io/ragepeanut/synchronizarr:latest
```

Or run **both** pipelines in a single instance by providing the Letterboxd/Radarr **and** Serializd/Sonarr variables together:

```yaml
services:
  synchronizarr:
    image: ghcr.io/ragepeanut/synchronizarr:latest
    container_name: synchronizarr
    environment:
      # Movies
      - LETTERBOXD_URL=https://letterboxd.com/your_username/watchlist/
      - RADARR_API_URL=http://radarr:7878
      - RADARR_API_KEY=your_radarr_api_key
      - RADARR_QUALITY_PROFILE=HD-1080p
      # TV shows
      - SERIALIZD_URL=https://serializd.com/user/your_username/watchlist
      - SONARR_API_URL=http://sonarr:8989
      - SONARR_API_KEY=your_sonarr_api_key
      - SONARR_QUALITY_PROFILE=HD-1080p
      # Shared
      - SYNC_MODE=sync
      - UPDATE_EXISTING_TAGS=true
      - CHECK_INTERVAL_MINUTES=60
    volumes:
      - ./data:/data
    restart: unless-stopped
```

## Watching Multiple Lists

To monitor multiple Letterboxd lists simultaneously, deploy one synchronizarr instance per list. Each instance operates independently with its own configuration, allowing you to:

- Watch different lists with different quality profiles
- Use custom tags to organize movies from different sources
- Set different check intervals for each list
- Maintain separate data directories to track each list's state

### Docker Compose Multi-List Example

```yaml
services:
  synchronizarr-watchlist:
    image: ghcr.io/ragepeanut/synchronizarr:latest
    container_name: synchronizarr-watchlist
    environment:
      - LETTERBOXD_URL=https://letterboxd.com/your_username/watchlist/
      - RADARR_API_URL=http://radarr:7878
      - RADARR_API_KEY=your_api_key
      - RADARR_QUALITY_PROFILE=HD-1080p
      - RADARR_TAGS=watchlist,personal
      - CHECK_INTERVAL_MINUTES=60
    volumes:
      - ./data/watchlist:/data
    restart: unless-stopped

  synchronizarr-criterion:
    image: ghcr.io/ragepeanut/synchronizarr:latest
    container_name: synchronizarr-criterion
    environment:
      - LETTERBOXD_URL=https://letterboxd.com/criterion/list/the-criterion-collection/
      - RADARR_API_URL=http://radarr:7878
      - RADARR_API_KEY=your_api_key
      - RADARR_QUALITY_PROFILE=HD-1080p
      - RADARR_TAGS=criterion,classics
      - CHECK_INTERVAL_MINUTES=120
    volumes:
      - ./data/criterion:/data
    restart: unless-stopped

  synchronizarr-nolan:
    image: ghcr.io/ragepeanut/synchronizarr:latest
    container_name: synchronizarr-nolan
    environment:
      - LETTERBOXD_URL=https://letterboxd.com/director/christopher-nolan/
      - RADARR_API_URL=http://radarr:7878
      - RADARR_API_KEY=your_api_key
      - RADARR_QUALITY_PROFILE=Ultra HD
      - RADARR_TAGS=nolan,director-filmography
      - CHECK_INTERVAL_MINUTES=1440  # Check once per day
    volumes:
      - ./data/nolan:/data
    restart: unless-stopped
```

### Docker CLI Multi-List Example

```bash
# Watch your personal watchlist
docker run -d \
  --name synchronizarr-watchlist \
  -e LETTERBOXD_URL=https://letterboxd.com/your_username/watchlist/ \
  -e RADARR_API_URL=http://radarr:7878 \
  -e RADARR_API_KEY=your_api_key \
  -e RADARR_QUALITY_PROFILE="HD-1080p" \
  -e RADARR_TAGS="watchlist,personal" \
  -e CHECK_INTERVAL_MINUTES=60 \
  -v ./data/watchlist:/data \
  ghcr.io/ragepeanut/synchronizarr:latest

# Watch the Criterion Collection
docker run -d \
  --name synchronizarr-criterion \
  -e LETTERBOXD_URL=https://letterboxd.com/criterion/list/the-criterion-collection/ \
  -e RADARR_API_URL=http://radarr:7878 \
  -e RADARR_API_KEY=your_api_key \
  -e RADARR_QUALITY_PROFILE="HD-1080p" \
  -e RADARR_TAGS="criterion,classics" \
  -e CHECK_INTERVAL_MINUTES=120 \
  -v ./data/criterion:/data \
  ghcr.io/ragepeanut/synchronizarr:latest

# Watch Christopher Nolan's filmography
docker run -d \
  --name synchronizarr-nolan \
  -e LETTERBOXD_URL=https://letterboxd.com/director/christopher-nolan/ \
  -e RADARR_API_URL=http://radarr:7878 \
  -e RADARR_API_KEY=your_api_key \
  -e RADARR_QUALITY_PROFILE="Ultra HD" \
  -e RADARR_TAGS="nolan,director-filmography" \
  -e CHECK_INTERVAL_MINUTES=1440 \
  -v ./data/nolan:/data \
  ghcr.io/ragepeanut/synchronizarr:latest
```

### Best Practices for Multi-List Setup

1. **Unique Container Names**: Each instance must have a unique container name (e.g., `synchronizarr-watchlist`, `synchronizarr-criterion`)

2. **Separate Data Directories**: Use different volume mounts for each instance to maintain independent state tracking:
   ```yaml
   volumes:
     - ./data/watchlist:/data    # Instance 1
     - ./data/criterion:/data    # Instance 2
   ```

3. **Distinctive Tags**: Use the `RADARR_TAGS` variable to organize movies by source:
   ```yaml
   - RADARR_TAGS=watchlist,personal
   - RADARR_TAGS=criterion,classics
   - RADARR_TAGS=nolan,director-filmography
   ```

4. **Appropriate Check Intervals**: Adjust `CHECK_INTERVAL_MINUTES` based on how frequently each list updates:
   - Personal watchlists: 30-60 minutes
   - Curated lists: 2-24 hours
   - Static collections: 24 hours or more

5. **Quality Profiles**: Each instance can use different quality profiles based on content type:
   ```yaml
   - RADARR_QUALITY_PROFILE=HD-1080p      # Standard content
   - RADARR_QUALITY_PROFILE=Ultra HD       # Premium content
   ```

## Configuration

You can enable **either or both** pipelines. At least one complete pipeline must be configured.

### Letterboxd → Radarr (movies)

Required together to enable the movie pipeline:

| Variable | Description | Example |
|----------|-------------|---------|
| `LETTERBOXD_URL` | Your Letterboxd list URL | `https://letterboxd.com/moviefan123/watchlist/` |
| `RADARR_API_URL` | Radarr base URL | `http://radarr:7878` |
| `RADARR_API_KEY` | Radarr API key | `abc123...` |
| `RADARR_QUALITY_PROFILE` | Quality profile name in Radarr | `HD-1080p` |

Optional (movie pipeline):

| Variable | Default | Description |
|----------|---------|-------------|
| `RADARR_MINIMUM_AVAILABILITY` | `released` | When movie becomes available (`announced`, `inCinemas`, `released`) |
| `RADARR_ROOT_FOLDER_ID` | - | Specific root folder ID to use in Radarr (uses first available if not set) |
| `RADARR_ADD_UNMONITORED` | `false` | When `true`, adds movies to Radarr in an unmonitored state |
| `RADARR_TAGS` | - | Additional tags to apply to movies (comma-separated). Movies are always tagged with `letterboxd` |
| `LETTERBOXD_TAKE_AMOUNT` | - | Number of movies to sync (requires `LETTERBOXD_TAKE_STRATEGY`) |
| `LETTERBOXD_TAKE_STRATEGY` | - | Movie selection strategy: `newest` or `oldest` (requires `LETTERBOXD_TAKE_AMOUNT`) |

### Serializd → Sonarr (TV shows)

Required together to enable the TV pipeline:

| Variable | Description | Example |
|----------|-------------|---------|
| `SERIALIZD_URL` | Your Serializd list/watchlist URL | `https://serializd.com/user/tvfan123/watchlist` |
| `SONARR_API_URL` | Sonarr base URL | `http://sonarr:8989` |
| `SONARR_API_KEY` | Sonarr API key | `abc123...` |
| `SONARR_QUALITY_PROFILE` | Quality profile name in Sonarr | `HD-1080p` |

Optional (TV pipeline):

| Variable | Default | Description |
|----------|---------|-------------|
| `SONARR_ROOT_FOLDER_ID` | - | Specific root folder ID to use in Sonarr (uses first available if not set) |
| `SONARR_ADD_UNMONITORED` | `false` | When `true`, adds series to Sonarr in an unmonitored state |
| `SONARR_TAGS` | - | Additional tags to apply to series (comma-separated). Series are always tagged with `serializd` |
| `SONARR_MONITOR_SEASONS` | - | Comma-separated season numbers to monitor for every added series (e.g. `1,2`). When unset, all seasons are monitored. Season selections made on Serializd always take precedence for that series |

### Shared Environment Variables

These apply to whichever pipeline(s) you enable:

| Variable | Default | Description |
|----------|---------|-------------|
| `CHECK_INTERVAL_MINUTES` | `10` | How often to check for new items (minimum 10) |
| `DRY_RUN` | `false` | When `true`, logs what would be added/removed without making actual API calls |
| `DATA_DIR` | `/data` | Directory for storing application data. You generally do not need to worry about this. |
| `SYNC_MODE` | `add` | `add` (default): only add items. `sync`: bidirectional — also remove items from Radarr/Sonarr when they are removed from the source list |
| `DELETE_FILES` | `true` | When removing items in sync mode, also delete the files from disk |
| `ADD_IMPORT_EXCLUSION` | `false` | When removing items in sync mode, add an import exclusion to prevent Radarr/Sonarr from re-adding the item |
| `UPDATE_EXISTING_TAGS` | `false` | When `true`, update tags on items that already exist in Radarr/Sonarr. Required for `SYNC_MODE=sync` to work correctly. When `false` (default), existing items are silently skipped (original upstream behavior) |
| `EXCLUDE_TAGS` | - | Comma-separated tag names that protect items from **deletion** in sync mode. When an item leaves this list but carries an excluded tag, it is **not deleted** — instead this instance's own tags are stripped from it (the item is kept, owned by whatever gave it the excluded tag). Useful when running multiple sync instances (e.g. a watchlist and a collection) |

### Plex Labels (optional)

When `PLEX_URL` and `PLEX_TOKEN` are set, synced items are also **labelled in Plex**, mirroring the tags applied in Radarr/Sonarr. This lets you build [Plex Smart Collections](https://support.plex.tv/articles/201273953-collections/) driven by those labels, so a film added to your Letterboxd list shows up in the right Plex collection automatically — no manual tagging.

This feature is entirely **opt-in**: leave `PLEX_URL`/`PLEX_TOKEN` unset and nothing touches Plex.

| Variable | Default | Description |
|----------|---------|-------------|
| `PLEX_URL` | - | Base URL of your Plex server (e.g. `http://localhost:32400`). Setting this + `PLEX_TOKEN` enables Plex labelling |
| `PLEX_TOKEN` | - | Plex authentication token ([how to find it](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)) |
| `PLEX_MOVIE_LIBRARY` | *(auto-detect)* | Plex movie library name to label. When unset, all movie libraries are auto-detected. Set this if you have multiple movie libraries |
| `PLEX_TV_LIBRARY` | *(auto-detect)* | Plex TV library name to label. When unset, all show libraries are auto-detected |
| `PLEX_MOVIE_TAGS` | *(= `RADARR_TAGS`)* | Override the labels applied to movies in Plex (comma-separated). Defaults to the same custom tags configured for Radarr |
| `PLEX_TV_TAGS` | *(= `SONARR_TAGS`)* | Override the labels applied to series in Plex (comma-separated). Defaults to the same custom tags configured for Sonarr |

**How it works:**

- Items are matched in Plex by their **TMDB id** (and IMDB id for movies), so an item that isn't scanned into your Plex library yet is skipped and picked up on a later run once it appears.
- Unlike Radarr/Sonarr, the `letterboxd` / `serializd` default tag is **not** applied to Plex labels — only your custom tags (or the `PLEX_*_TAGS` overrides). So if `RADARR_TAGS=watchlist`, the Plex label is just `watchlist`.
- **Plex is never used to add or remove media** — only to add/remove labels. Media deletion stays with Radarr/Sonarr (and any other tooling you use).
- In `SYNC_MODE=sync`, when an item leaves the list, only **this list's own labels** are removed from the Plex item. Excluded labels (`EXCLUDE_TAGS`) and any other labels you've added in Plex are left untouched, and the item itself is always kept.
- Respects `DRY_RUN`: label changes are logged but not executed.

**Example — a "Collection" label auto-applied from a Letterboxd list:**

```yaml
  synchronizarr-collection:
    build: ./synchronizarr
    environment:
      - LETTERBOXD_URL=https://letterboxd.com/your_username/list/digital-collection/
      - RADARR_API_URL=http://radarr:7878
      - RADARR_API_KEY=your_api_key
      - RADARR_QUALITY_PROFILE=Any
      - RADARR_TAGS=collection          # tags in Radarr AND labels in Plex
      - SYNC_MODE=sync
      - UPDATE_EXISTING_TAGS=true
      - PLEX_URL=http://plex:32400
      - PLEX_TOKEN=your_plex_token
      # PLEX_MOVIE_LIBRARY=Movies       # optional; auto-detected when unset
      # PLEX_MOVIE_TAGS=Collection      # optional; defaults to RADARR_TAGS (collection)
    restart: unless-stopped
```

Every film on the list gets a `collection` label in Plex; build a Smart Collection filtered by that label and it stays in sync automatically.

## Sync Mode (Bidirectional)

When `SYNC_MODE=sync`, the Letterboxd list becomes the **single source of truth** for which movies should be in Radarr (with your configured tags). Each cycle:

1. The list is scraped and new movies are added to Radarr (same as `add` mode).
2. All Radarr movies carrying the configured `RADARR_TAGS` are queried.
3. Movies in Radarr (with matching tags) that are **no longer on the Letterboxd list** are **removed** from Radarr.

This is ideal for curated collections — add a movie to your Letterboxd list and it downloads; remove it and it's cleaned up automatically.

### How removal works

- Removal only targets movies with **all** your configured tags. Movies added by other instances (with different tags) are never touched.
- `DELETE_FILES=true` (default): files are deleted from disk, freeing space. Plex reflects the removal automatically.
- `ADD_IMPORT_EXCLUSION=false` (default): the movie can be re-added later (e.g. by another synchronizarr instance monitoring your watchlist). Set to `true` if you want removal to be permanent.
- Respects `DRY_RUN`: when enabled, removals are logged but not executed.

### Tag updating for existing movies

When a movie on the Letterboxd list **already exists** in Radarr (e.g. added by a different instance), the original upstream Lettarrboxd silently skips it without applying tags. When `UPDATE_EXISTING_TAGS=true`, synchronizarr instead **updates the existing movie's tags** to include the configured tags. This ensures the sync-mode removal logic can correctly identify which movies belong to which list.

> **Note:** `UPDATE_EXISTING_TAGS` defaults to `false` to preserve the original upstream behavior. If you use `SYNC_MODE=sync`, you should set `UPDATE_EXISTING_TAGS=true` — otherwise movies that already exist in Radarr won't get the tags needed for sync removal to work.

### Protecting movies from removal (`EXCLUDE_TAGS`)

When running **multiple sync instances**, a movie removed from one list might still belong to another. `EXCLUDE_TAGS` protects movies carrying specific tags from being removed.

**Example — watchlist auto-cleanup + a protected collection:**

Letterboxd automatically removes a film from your watchlist once you log it as watched. Combined with `SYNC_MODE=sync`, this means watched films are automatically cleaned up from Radarr. But you may want to keep some films permanently — put those on a separate "Digital Collection" list (tagged `collection`), and tell the watchlist instance to never remove `collection`-tagged films:

```yaml
  # Watchlist: adds films you want; removes them once watched (dropped from watchlist)
  synchronizarr-watchlist:
    build: ./synchronizarr
    container_name: synchronizarr-watchlist
    environment:
      - LETTERBOXD_URL=https://letterboxd.com/your_username/watchlist/
      - RADARR_API_URL=http://radarr:7878
      - RADARR_API_KEY=your_api_key
      - RADARR_QUALITY_PROFILE=Any
      - RADARR_TAGS=watchlist
      - SYNC_MODE=sync
      - UPDATE_EXISTING_TAGS=true
      - EXCLUDE_TAGS=collection      # never remove films in the collection
      - DELETE_FILES=true
    volumes:
      - ./data/watchlist:/data
    restart: unless-stopped

  # Digital Collection: your permanent keepers, tagged `collection`
  synchronizarr-collection:
    build: ./synchronizarr
    container_name: synchronizarr-collection
    environment:
      - LETTERBOXD_URL=https://letterboxd.com/your_username/list/digital-collection/
      - RADARR_API_URL=http://radarr:7878
      - RADARR_API_KEY=your_api_key
      - RADARR_QUALITY_PROFILE=Any
      - RADARR_TAGS=collection
      - SYNC_MODE=sync
      - UPDATE_EXISTING_TAGS=true
      - DELETE_FILES=true
    volumes:
      - ./data/collection:/data
    restart: unless-stopped
```

Now: watch a film → it drops off your watchlist → removed from Radarr. But if that film is also on your Digital Collection, the `collection` tag protects it: instead of deleting it, the watchlist instance simply **removes its own `watchlist` tag**, leaving the movie in place (still owned by the collection).

#### How protection avoids both wrongful deletion and deadlocks

When a movie leaves a list but is protected by an excluded tag, the instance **strips only its own tags** rather than deleting the movie. This is important when both instances exclude each other's tag:

- A film on both lists is tagged `watchlist` + `collection`.
- Remove it from the watchlist → the watchlist instance strips `watchlist` (movie kept, now only `collection`).
- Remove it from the collection too → the collection instance sees no protecting tag left → **deletes it**.

Because protection *untags* rather than *skips*, a movie removed from every list is always eventually deleted — there's no deadlock where two instances each refuse to remove a movie the other "owns". You can safely set `EXCLUDE_TAGS` symmetrically on both instances (`EXCLUDE_TAGS=collection` on the watchlist instance, `EXCLUDE_TAGS=watchlist` on the collection instance).

### Example: Digital Collection

Use a dedicated Letterboxd list as your "permanent collection" — movies you want to keep on disk:

```yaml
  synchronizarr-collection:
    build: ./synchronizarr
    container_name: synchronizarr-collection
    environment:
      - LETTERBOXD_URL=https://letterboxd.com/your_username/list/digital-collection/
      - RADARR_API_URL=http://radarr:7878
      - RADARR_API_KEY=your_api_key
      - RADARR_QUALITY_PROFILE=Any
      - RADARR_TAGS=collection
      - SYNC_MODE=sync
      - UPDATE_EXISTING_TAGS=true
      - DELETE_FILES=true
      - ADD_IMPORT_EXCLUSION=false
      - CHECK_INTERVAL_MINUTES=120
      - DRY_RUN=true   # Verify first, then set to false
    volumes:
      - ./data/collection:/data
    restart: unless-stopped
```

- Add a film to "Digital Collection" on Letterboxd → it downloads, tagged `collection`.
- Remove a film from the list → next sync removes it from Radarr + deletes the files.
- Movies added by your watchlist instance (tagged `watchlist`) are unaffected.

## Development

### Prerequisites

- Node.js 20+
- Yarn package manager

### Setup

```bash
# Clone the repository
git clone https://github.com/RagePeanut/synchronizarr.git
cd synchronizarr

# Install dependencies
yarn install

# Create environment file
cp .env.example .env
# Edit .env with your configuration

# Run in development mode
yarn start:dev
```

### Development Commands

```bash
yarn start:dev    # Run with auto-reload
yarn tsc          # Compile TypeScript
yarn tsc --noEmit # Type check only
```

### Development Mode

When `NODE_ENV=development`, the application:
- Only processes the first 5 movies (for faster testing)
- Uses more verbose logging
- Includes additional debug information

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Troubleshooting

### Common Issues

**Movies not being added**
- Verify your Radarr API key and URL are correct
- Check that the quality profile name matches exactly (case-sensitive)
- Ensure your Letterboxd list is public

**Docker container won't start**
- Verify all required environment variables are set
- Check container logs: `docker logs synchronizarr`

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Legal Disclaimer

This project is intended for use with legally sourced media only. It is designed to help users organize and manage their personal media collections. The developers of synchronizarr do not condone or support piracy in any form. Users are solely responsible for ensuring their use of this software complies with all applicable laws and regulations in their jurisdiction.
