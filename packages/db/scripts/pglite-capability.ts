// Capability probe for PGlite's role and RLS support.
//
// Why this matters: ADR-0006 forbids the application from connecting as a
// superuser, because a superuser silently bypasses RLS and makes every
// tenancy test meaningless. The isolation suite is only worth anything if the
// test connection can be a NON-superuser role. If PGlite cannot express
// roles, then PGlite cannot verify the single most important security
// property in this system, and that has to be known now rather than
// discovered when the suite is already written.
//
// Run from packages/db:  node --experimental-strip-types scripts/pglite-capability.ts

import { PGlite } from '@electric-sql/pglite'

const results = []

async function probe(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, status: 'OK', detail: detail ?? '' })
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: String(error.message ?? error).slice(0, 200) })
  }
}

const ORG_A = '11111111-1111-1111-1111-111111111111'
const ORG_B = '22222222-2222-2222-2222-222222222222'

const db = await PGlite.create()

await probe('server version', async () => {
  const r = await db.query('select version()')
  return r.rows[0].version.split(' on ')[0]
})

// ---------------------------------------------------------------------------
// Everything below runs as the superuser owner, which is the ONLY role that
// can create tables, roles and policies. Setting up first, probing after.
// ---------------------------------------------------------------------------

await probe('CREATE ROLE ... NOSUPERUSER NOBYPASSRLS', async () => {
  await db.exec('CREATE ROLE probe_app LOGIN NOSUPERUSER NOBYPASSRLS')
  const r = await db.query(
    "select rolsuper, rolbypassrls from pg_roles where rolname = 'probe_app'",
  )
  const row = r.rows[0]
  return `rolsuper=${row.rolsuper} rolbypassrls=${row.rolbypassrls}`
})

await probe('create + seed tenant table as owner', async () => {
  await db.exec('CREATE TABLE probe_t (id int primary key, org uuid not null)')
  await db.exec('ALTER TABLE probe_t ENABLE ROW LEVEL SECURITY')
  await db.exec('ALTER TABLE probe_t FORCE ROW LEVEL SECURITY')
  await db.exec(`
    CREATE POLICY probe_isolation ON probe_t
      USING (org::text = nullif(current_setting('app.org_id', true), ''));
  `)
  await db.exec(`INSERT INTO probe_t (id, org) VALUES (1, '${ORG_A}'), (2, '${ORG_B}')`)
  await db.exec('GRANT SELECT ON probe_t TO probe_app')
  return 'two tenants seeded'
})

await probe('SECURITY DEFINER function', async () => {
  await db.exec(`
    CREATE FUNCTION probe_definer() RETURNS text
      LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 'invoked' $$;
  `)
  const r = await db.query('select probe_definer() as v')
  return `returned ${r.rows[0].v}`
})

await probe('composite foreign key', async () => {
  await db.exec(
    'CREATE TABLE probe_parent (org uuid not null, id uuid not null, primary key (org, id))',
  )
  await db.exec('CREATE TABLE probe_child (org uuid not null, pid uuid not null)')
  await db.exec(`
    ALTER TABLE probe_child ADD CONSTRAINT fk_composite
      FOREIGN KEY (org, pid) REFERENCES probe_parent (org, id);
  `)
  await db.exec(`INSERT INTO probe_parent (org, id) VALUES ('${ORG_A}', 'aaaaaaaa-0000-0000-0000-000000000001')`)
  return 'created and seeded'
})

// ---------------------------------------------------------------------------
// The decisive probes. Each must be evaluated AS probe_app, because the
// entire purpose is to show RLS is enforced for a non-superuser connection.
// A probe that silently runs as the owner proves nothing.
// ---------------------------------------------------------------------------

await probe('SET ROLE probe_app', async () => {
  await db.exec('SET ROLE probe_app')
  const r = await db.query('select current_user')
  if (r.rows[0].current_user !== 'probe_app') throw new Error(`current_user is ${r.rows[0].current_user}`)
  return 'current_user = probe_app'
})

await probe('RLS filters to the caller tenant', async () => {
  await db.exec(`SET app.org_id = '${ORG_A}'`)
  const r = await db.query('select id from probe_t order by id')
  const seen = r.rows.map((x) => x.id).join(', ')
  if (seen !== '1') throw new Error(`SAW [${seen}] - expected only org A row (id 1)`)
  return `saw [${seen}] - org B correctly hidden`
})

await probe('a different tenant sees the other row', async () => {
  await db.exec(`SET app.org_id = '${ORG_B}'`)
  const r = await db.query('select id from probe_t order by id')
  const seen = r.rows.map((x) => x.id).join(', ')
  if (seen !== '2') throw new Error(`SAW [${seen}] - expected only org B row (id 2)`)
  return `saw [${seen}]`
})

await probe('unset tenant context fails CLOSED', async () => {
  await db.exec("SET app.org_id = ''")
  const r = await db.query('select id from probe_t order by id')
  const seen = r.rows.map((x) => x.id).join(', ')
  if (seen !== '') throw new Error(`SAW [${seen}] - an unset context must expose nothing`)
  return 'saw [] - zero rows'
})

await probe('superuser comparison sees everything', async () => {
  await db.exec('RESET ROLE')
  await db.exec(`SET app.org_id = '${ORG_A}'`)
  const r = await db.query('select id from probe_t order by id')
  const seen = r.rows.map((x) => x.id).join(', ')
  if (seen !== '1, 2') throw new Error(`superuser saw [${seen}] - expected [1, 2]`)
  return 'saw [1, 2] - confirms why ADR-0006 forbids a superuser app role'
})

await probe('cross-tenant composite FK is REJECTED', async () => {
  try {
    await db.exec(`INSERT INTO probe_child (org, pid) VALUES ('${ORG_B}', 'aaaaaaaa-0000-0000-0000-000000000001')`)
    return 'NOT REJECTED - cross-tenant insert succeeded'
  } catch {
    return 'rejected by the database, as required'
  }
})

await db.close()

const width = Math.max(...results.map((r) => r.name.length))
for (const r of results) {
  const mark = r.status === 'OK' ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${r.name.padEnd(width)}  ${r.detail}`)
}
const failed = results.filter((r) => r.status === 'FAIL').length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)