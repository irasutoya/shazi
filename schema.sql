CREATE TABLE IF NOT EXISTS friends (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  order_index INTEGER NOT NULL,
  name TEXT NOT NULL UNIQUE,
  contact TEXT NOT NULL DEFAULT '',
  markdown TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friends_order ON friends(order_index);
