# Migrations moved

The 42 migrations that used to live here (`001_initial_schema.sql`
through `042_message_failure_reason.sql`) were carried over verbatim
into [`prisma/migrations/`](../../prisma/migrations) — same SQL, same
order, just replayed by Prisma Migrate instead of the Supabase CLI.

This directory is now empty on purpose and kept only so the Supabase
CLI still recognises `supabase/` as a project directory (see
`supabase/config.toml`, used by `.github/workflows/migrations.yml` to
provision a local Postgres with the `auth`/`storage` schema fixtures).

See [docs/prisma-migrations.md](../../docs/prisma-migrations.md).
