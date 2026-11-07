BEGIN;

CREATE SCHEMA IF NOT EXISTS runcast_stats;
REVOKE ALL ON SCHEMA runcast_stats FROM PUBLIC;

CREATE TABLE IF NOT EXISTS runcast_stats.visit_stats_state (
  scope text PRIMARY KEY CHECK (scope ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  collection_started_at timestamptz NOT NULL,
  last_cleanup_day date
);

CREATE TABLE IF NOT EXISTS runcast_stats.visit_daily_devices (
  scope text NOT NULL,
  day date NOT NULL,
  visitor_id uuid NOT NULL,
  category smallint NOT NULL CHECK (category BETWEEN 0 AND 3),
  PRIMARY KEY (scope, day, visitor_id)
);

CREATE TABLE IF NOT EXISTS runcast_stats.visit_daily_counts (
  scope text NOT NULL,
  day date NOT NULL,
  ios_web integer NOT NULL DEFAULT 0 CHECK (ios_web >= 0),
  ios_pwa integer NOT NULL DEFAULT 0 CHECK (ios_pwa >= 0),
  android_web integer NOT NULL DEFAULT 0 CHECK (android_web >= 0),
  android_pwa integer NOT NULL DEFAULT 0 CHECK (android_pwa >= 0),
  PRIMARY KEY (scope, day)
);

-- One statement/transaction owns cleanup, deduplication and the counter update.
-- p_at is an internal clock seam for SQL tests; the API never accepts it.
CREATE OR REPLACE FUNCTION runcast_stats.record_visit(
  p_scope text, p_visitor uuid, p_category smallint,
  p_at timestamptz DEFAULT statement_timestamp()
) RETURNS TABLE (registered boolean, as_of timestamptz)
LANGUAGE plpgsql SET search_path = pg_catalog, runcast_stats AS $$
DECLARE
  v_at timestamptz := COALESCE(p_at, statement_timestamp());
  v_day date := (v_at AT TIME ZONE 'Asia/Seoul')::date;
  v_claimed integer;
  v_inserted integer;
BEGIN
  IF p_visitor IS NULL OR p_category IS NULL OR p_category NOT BETWEEN 0 AND 3 THEN
    RAISE EXCEPTION 'Invalid visit' USING ERRCODE = '22023';
  END IF;

  INSERT INTO runcast_stats.visit_stats_state(scope, collection_started_at)
  VALUES (p_scope, v_at) ON CONFLICT (scope) DO NOTHING;

  -- Always take maintenance locks before touching deduplication/counter rows.
  UPDATE runcast_stats.visit_stats_state SET last_cleanup_day = v_day
  WHERE scope = p_scope AND (last_cleanup_day IS NULL OR last_cleanup_day < v_day);
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed > 0 THEN
    DELETE FROM runcast_stats.visit_daily_devices
    WHERE scope = p_scope AND day < v_day - 13;
  END IF;

  INSERT INTO runcast_stats.visit_daily_devices(scope, day, visitor_id, category)
  VALUES (p_scope, v_day, p_visitor, p_category)
  ON CONFLICT (scope, day, visitor_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted > 0 THEN
    INSERT INTO runcast_stats.visit_daily_counts(scope, day, ios_web, ios_pwa, android_web, android_pwa)
    VALUES (p_scope, v_day,
      (p_category = 0)::integer, (p_category = 1)::integer,
      (p_category = 2)::integer, (p_category = 3)::integer)
    ON CONFLICT (scope, day) DO UPDATE SET
      ios_web = visit_daily_counts.ios_web + EXCLUDED.ios_web,
      ios_pwa = visit_daily_counts.ios_pwa + EXCLUDED.ios_pwa,
      android_web = visit_daily_counts.android_web + EXCLUDED.android_web,
      android_pwa = visit_daily_counts.android_pwa + EXCLUDED.android_pwa;
  END IF;

  RETURN QUERY SELECT v_inserted > 0, v_at;
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA runcast_stats FROM PUBLIC;
REVOKE ALL ON FUNCTION runcast_stats.record_visit(text, uuid, smallint, timestamptz) FROM PUBLIC;
COMMIT;
