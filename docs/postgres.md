# PostgreSQL

A Crewly server keeps its data in SQLite unless it is given a PostgreSQL URL:

```sh
CREWLY_DATABASE_URL=postgres://crewly:secret@db.internal:5432/crewly   # or --database-url
```

Self-hosting needs none of this: SQLite stays the default and the single
`crewly-server` binary does not include PostgreSQL support at all. PostgreSQL
is for hosted servers, where Superserver provisions a database for each one.
The data directory is still used in either case, for attachments and the
secrets key.

## How it works

Everything above `src/db` is synchronous, written against SQLite.
`src/db/postgres.ts` keeps that: a `pg` client runs in a worker thread and
each statement blocks on it, the way every SQLite statement already blocks.
That is only reasonable because the database is close by (Superserver runs it
on the same host), so a round trip is well under a millisecond. Do not point a
server at a database across a WAN.

The server's SQL stays SQLite's. The driver translates what differs, once per
statement: `?`/`@name` placeholders, `INSERT OR IGNORE`, null-safe `x IS ?`,
`COLLATE NOCASE`, and camelCase aliases (which PostgreSQL folds to lower case).
Inside a transaction every write runs under a savepoint, because a failed
statement aborts a whole PostgreSQL transaction where SQLite fails only that
statement. Every table carries a `rowid` identity column, so `ORDER BY ...,
rowid` keeps insertion order as it does on SQLite; the driver leaves it out of
results. SQL the two engines cannot share branches on `db.dialect`.

## Migrations

PostgreSQL does not replay SQLite's history. It starts from
`src/db/migrations-postgres/0001_baseline.sql`, which is the SQLite schema as of
migration 0044, including the rows those migrations seed.

**Every SQLite migration after 0044 needs a PostgreSQL counterpart** in
`src/db/migrations-postgres/`, then `npm run build:migrations`. The schema
parity test in `src/db/postgres.test.ts` compares both engines' tables,
columns and seeded rows after migrating, and fails until the counterpart
exists. New tables need a `rowid BIGINT GENERATED ALWAYS AS IDENTITY` column.

## Tests

```sh
CREWLY_TEST_DATABASE_URL=postgres://localhost/crewly_test npm test
```

runs the whole suite against PostgreSQL: every in-memory database a test
opens becomes a fresh schema on that server. CI runs both.
