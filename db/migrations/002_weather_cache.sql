BEGIN;
CREATE SCHEMA IF NOT EXISTS runcast_weather;
REVOKE ALL ON SCHEMA runcast_weather FROM PUBLIC;

-- One latest successful provider payload per environment/location/contract.
-- No device IDs, user-supplied names, API keys, or failure responses.
CREATE TABLE IF NOT EXISTS runcast_weather.forecast_cache (
  scope text NOT NULL CHECK (scope ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  cache_key text NOT NULL CHECK (length(cache_key) BETWEEN 1 AND 240),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144),
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > fetched_at),
  stale_until timestamptz NOT NULL CHECK (stale_until >= expires_at),
  PRIMARY KEY (scope, cache_key)
);
REVOKE ALL ON TABLE runcast_weather.forecast_cache FROM PUBLIC;
COMMIT;
