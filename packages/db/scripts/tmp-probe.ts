import { PGlite } from "@electric-sql/pglite";

const db = await PGlite.create();

await db.exec(`
  CREATE TABLE par (id uuid primary key, org_id uuid not null, constraint par_key unique (org_id, id));
  CREATE TABLE chi (id uuid primary key, org_id uuid not null, par_id uuid not null,
    constraint chi_fk foreign key (org_id, par_id) references par (org_id, id));
  CREATE INDEX chi_two ON chi (org_id, par_id, id);
`);

const run = async (name: string, sql: string, params: unknown[] = []): Promise<void> => {
  try {
    const r = await db.query<Record<string, unknown>>(sql, params);
    process.stdout.write(`PASS  ${name}\n${JSON.stringify(r.rows, null, 1)}\n`);
  } catch (error) {
    process.stdout.write(`FAIL  ${name}: ${String((error as Error).message).slice(0, 200)}\n`);
  }
};

await run(
  "composite FK columns in declared order",
  `
  SELECT child.relname AS child_table, parent.relname AS parent_table, con.conname,
         array_agg(att.attname ORDER BY key.ord) AS cols
    FROM pg_constraint con
    JOIN pg_class child  ON child.oid  = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord) ON true
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key.attnum
   WHERE con.contype = 'f'
   GROUP BY child.relname, parent.relname, con.conname
   ORDER BY child.relname
  `,
);

await run(
  "composite-capable tenant tables",
  `
  SELECT c.relname
    FROM pg_class c
   WHERE c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND a.attnotnull)
     AND EXISTS (SELECT 1 FROM pg_constraint u
                  WHERE u.conrelid = c.oid AND u.contype = 'u'
                    AND u.conkey = ARRAY[
                          (SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'org_id'),
                          (SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'id')
                        ]::smallint[])
   ORDER BY c.relname
  `,
);

await run(
  "index leading columns",
  `
  SELECT t.relname AS table_name, idx.relname AS index_name,
         array_length(x.indkey, 1) AS ncols,
         array_agg(a.attname ORDER BY k.ord) AS cols
    FROM pg_index x
    JOIN pg_class idx ON idx.oid = x.indexrelid
    JOIN pg_class t   ON t.oid   = x.indrelid
    JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
   WHERE t.relname = ANY($1) AND k.attnum > 0
   GROUP BY t.relname, idx.relname, x.indkey
   ORDER BY t.relname, idx.relname
  `,
  [["par", "chi"]],
);

await run(
  "policies with tenant predicate first",
  `
  SELECT c.relname AS table_name, p.polname, pg_get_expr(p.polqual, p.polrelid) AS using_expr
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   ORDER BY c.relname, p.polname
  `,
);

await run(
  "numeric precision/scale reflection",
  `
  SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
   WHERE table_name = ANY($1) AND data_type = 'numeric'
   ORDER BY table_name, column_name
  `,
  [["par", "chi"]],
);

await run(
  "timestamptz-only scan",
  `
  SELECT table_name, column_name, data_type
    FROM information_schema.columns
   WHERE table_name = ANY($1)
     AND (column_name ~ '(_at|_from|_to|_on|_deadline|_since|_until)$'
          OR column_name LIKE '%time%' OR column_name LIKE '%date%')
   ORDER BY table_name, column_name
  `,
  [["par", "chi"]],
);

await db.close();