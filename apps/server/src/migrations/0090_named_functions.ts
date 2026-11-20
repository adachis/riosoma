import type { Migration } from '@riosoma/db';

export const m0090: Migration = {
  id: '0090_named_functions',
  sql: `
CREATE TABLE {{app}}.named_functions (
  id text PRIMARY KEY,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z_0-9]{0,63}$'),
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'array' AND jsonb_array_length(parameters) <= 32),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000 AND length(btrim(body)) > 0),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  updated_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);
CREATE UNIQUE INDEX named_functions_name ON {{app}}.named_functions (database_id, lower(name COLLATE "C"));
`,
};
