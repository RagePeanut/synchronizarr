import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // ── Letterboxd → Radarr (movies) ──
  // All optional so the Serializd → Sonarr pipeline can run standalone. The
  // refine() below enforces that a Letterboxd source is fully configured
  // (URL + Radarr connection) if any of these are provided.
  LETTERBOXD_URL: z.string().url().optional(),
  RADARR_API_URL: z.string().optional(),
  RADARR_API_KEY: z.string().optional(),
  RADARR_QUALITY_PROFILE: z.string().optional(),
  RADARR_MINIMUM_AVAILABILITY: z.string().default('released'),
  RADARR_ROOT_FOLDER_ID: z.string().optional(),
  RADARR_TAGS: z.string().optional(),
  RADARR_ADD_UNMONITORED: z.string().default('false').transform(val => val.toLowerCase() === 'true'),

  // ── Serializd → Sonarr (TV shows) ──
  // Optional so the Letterboxd → Radarr pipeline can run standalone. The
  // refine() below enforces that a Serializd source is fully configured
  // (URL + Sonarr connection) if any of these are provided.
  SERIALIZD_URL: z.string().url().optional(),
  SONARR_API_URL: z.string().optional(),
  SONARR_API_KEY: z.string().optional(),
  SONARR_QUALITY_PROFILE: z.string().optional(),
  SONARR_ROOT_FOLDER_ID: z.string().optional(),
  SONARR_TAGS: z.string().optional(),
  SONARR_ADD_UNMONITORED: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  // Comma-separated list of season numbers to monitor for every added series
  // (e.g. "1,2"). When unset, all seasons of a series are monitored. Note that
  // Serializd list entries that pin specific seasons always take precedence.
  SONARR_MONITOR_SEASONS: z.string().optional(),

  // ── Plex labels (optional, applies to BOTH pipelines) ──
  // When PLEX_URL and PLEX_TOKEN are set, synced items are also labelled in
  // Plex, mirroring the tags applied in Radarr/Sonarr. This is entirely opt-in:
  // with these unset, nothing touches Plex. Plex is never used to add or remove
  // media — only to add/remove labels on items already in your library.
  PLEX_URL: z.string().url().optional(),
  PLEX_TOKEN: z.string().optional(),
  // Plex library section names to search. When unset, movie/show libraries are
  // auto-detected. Set these when you have multiple libraries of a given type.
  PLEX_MOVIE_LIBRARY: z.string().optional(),
  PLEX_TV_LIBRARY: z.string().optional(),
  // Override the labels applied in Plex (comma-separated). When unset, Plex
  // labels default to the same custom tags configured for Radarr/Sonarr
  // (RADARR_TAGS / SONARR_TAGS). Unlike Radarr/Sonarr, the 'letterboxd' /
  // 'serializd' default tag is NOT applied to Plex labels.
  PLEX_MOVIE_TAGS: z.string().optional(),
  PLEX_TV_TAGS: z.string().optional(),

  CHECK_INTERVAL_MINUTES: z.string().default('10').transform(Number).pipe(z.number().min(10)),
  LETTERBOXD_TAKE_AMOUNT: z.string().optional().transform(val => val ? Number(val) : undefined).pipe(z.number().positive().optional()),
  LETTERBOXD_TAKE_STRATEGY: z.enum(['oldest', 'newest']).optional(),
  DRY_RUN: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  // Sync mode: 'add' (default, original behavior) or 'sync' (bidirectional: add + remove).
  // In 'sync' mode, items removed from the source list are also removed from
  // Radarr/Sonarr. Applies to both the Letterboxd and Serializd pipelines.
  SYNC_MODE: z.enum(['add', 'sync']).default('add'),
  // When true, update tags on items that already exist in Radarr/Sonarr. When
  // false (default), existing items are silently skipped — matching the
  // original upstream behavior. Required for SYNC_MODE=sync to work correctly.
  UPDATE_EXISTING_TAGS: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  // When removing items in sync mode, also delete the files from disk.
  DELETE_FILES: z.string().default('true').transform(val => val.toLowerCase() === 'true'),
  // When removing items in sync mode, add an import exclusion to prevent re-adding.
  ADD_IMPORT_EXCLUSION: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  // Comma-separated tag names that protect an item from removal in sync mode.
  // An item carrying ANY of these tags in Radarr/Sonarr is never removed, even
  // if it is no longer on the source list. Useful to protect a curated collection.
  EXCLUDE_TAGS: z.string().optional(),
}).superRefine((data, ctx) => {
  const hasTakeAmount = data.LETTERBOXD_TAKE_AMOUNT !== undefined;
  const hasTakeStrategy = data.LETTERBOXD_TAKE_STRATEGY !== undefined;

  // If one take option is specified, both must be specified.
  if (hasTakeAmount !== hasTakeStrategy) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'When using movie limiting, both LETTERBOXD_TAKE_AMOUNT and LETTERBOXD_TAKE_STRATEGY must be specified',
      path: ['LETTERBOXD_TAKE_AMOUNT', 'LETTERBOXD_TAKE_STRATEGY'],
    });
  }

  // A Letterboxd → Radarr pipeline requires the source URL and full Radarr connection.
  const radarrFields = [data.LETTERBOXD_URL, data.RADARR_API_URL, data.RADARR_API_KEY, data.RADARR_QUALITY_PROFILE];
  const radarrProvided = radarrFields.some(v => v !== undefined);
  const radarrComplete = radarrFields.every(v => v !== undefined);
  if (radarrProvided && !radarrComplete) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'The Letterboxd → Radarr pipeline requires LETTERBOXD_URL, RADARR_API_URL, RADARR_API_KEY and RADARR_QUALITY_PROFILE to all be set',
      path: ['LETTERBOXD_URL'],
    });
  }

  // A Serializd → Sonarr pipeline requires the source URL and full Sonarr connection.
  const sonarrFields = [data.SERIALIZD_URL, data.SONARR_API_URL, data.SONARR_API_KEY, data.SONARR_QUALITY_PROFILE];
  const sonarrProvided = sonarrFields.some(v => v !== undefined);
  const sonarrComplete = sonarrFields.every(v => v !== undefined);
  if (sonarrProvided && !sonarrComplete) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'The Serializd → Sonarr pipeline requires SERIALIZD_URL, SONARR_API_URL, SONARR_API_KEY and SONARR_QUALITY_PROFILE to all be set',
      path: ['SERIALIZD_URL'],
    });
  }

  // Plex labelling requires both the URL and a token when either is provided.
  const plexFields = [data.PLEX_URL, data.PLEX_TOKEN];
  const plexProvided = plexFields.some(v => v !== undefined);
  const plexComplete = plexFields.every(v => v !== undefined);
  if (plexProvided && !plexComplete) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Plex labelling requires both PLEX_URL and PLEX_TOKEN to be set',
      path: ['PLEX_URL'],
    });
  }

  // At least one complete pipeline must be configured.
  if (!radarrComplete && !sonarrComplete) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'No source configured. Configure the Letterboxd → Radarr pipeline (LETTERBOXD_URL + RADARR_*) and/or the Serializd → Sonarr pipeline (SERIALIZD_URL + SONARR_*)',
      path: ['LETTERBOXD_URL'],
    });
  }
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Environment validation failed:');
    result.error.issues.forEach(error => {
      console.error(`- ${error.path.join('.')}: ${error.message}`);
    });
    process.exit(1);
  }

  return result.data;
}

const env = validateEnv();
export default env;

/** True when the Letterboxd → Radarr pipeline is fully configured. */
export const isRadarrEnabled = (): boolean =>
  !!(env.LETTERBOXD_URL && env.RADARR_API_URL && env.RADARR_API_KEY && env.RADARR_QUALITY_PROFILE);

/** True when the Serializd → Sonarr pipeline is fully configured. */
export const isSonarrEnabled = (): boolean =>
  !!(env.SERIALIZD_URL && env.SONARR_API_URL && env.SONARR_API_KEY && env.SONARR_QUALITY_PROFILE);

/**
 * True when Plex labelling is configured. Opt-in: setting PLEX_URL + PLEX_TOKEN
 * enables labelling synced items in Plex. Plex is only ever used to add/remove
 * labels — never to add or remove media.
 */
export const isPlexEnabled = (): boolean => !!(env.PLEX_URL && env.PLEX_TOKEN);
