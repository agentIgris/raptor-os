# 47 - SEARCH
**Audit.md section:** 54 (SECTION 51 - SEARCH)

## 1. Current capability, exhaustively
| Entity the Audit.md asks about | Searchable today? | Mechanism | Status |
| --- | --- | --- | --- |
| People | **Partially** | `GET /api/profile/search?q=&role=&team=&status=` | **BROKEN and injectable** |
| Teams | **No** | `GET /api/teams` returns all; the client filters | no search |
| Matches / performances | **No** | filters are `timeframe`, `teamId`, `playerId`, `map` - exact match only | no text search |
| Sessions | **No** | `date`, `team_id`, `session_type` filters | no text search |
| Contracts / agreements | **No** | no search | no text search |
| Sponsors | **No** | entity does not exist | - |
| Content | **No** | entity does not exist | - |
| Documents | **No** | no document store | - |
| Tryouts / applications | **No** | `GET /api/tryouts` list only | no search |
| Attendance | **No** | date/team filters | no search |
| Finances | **No** | unbounded lists | no search |
| Global / cross-domain search | **No** | — | **does not exist** |

## 2. The one search endpoint, analysed
`app/api/profile/search/route.ts` (95 lines):
* `:8` authenticates with `getUser`;
* `:15-17` restricts to `admin` and `manager`;
* `:20-25` accepts `q`, `role`, `team`, `status`, `limit`, `offset` — with **no cap on `limit`**
  and **no validation of `role`/`team`**;
* `:27` builds the query with the **module-level anon `supabase` client** (imported at line 3),
  not the user-scoped client — so `auth.uid()` is `NULL` and the `users` RLS policy
  (`auth.uid() = id`) denies every row;
* `:52-57` interpolates `q` directly into a PostgREST `.or()` filter — a filter-injection surface
  (`15_API_SECURITY.md` F-API-10);
* `:80-82` computes a total count with an unfiltered `select('*', { count:'exact', head:true })`.

**Net result: the endpoint is non-functional (returns nothing under RLS), injectable, uncapped,
and it runs its data query on a client with no identity.**

## 3. Findings

### F-SRC-01 - HIGH: there is effectively no search
**Evidence.** the table above; the single search endpoint is broken.
**Impact:** in any organisation above a few dozen people, finding "the player who is in Berlin
and plays support" or "the contract that expires in March" is impossible. This is a primary
driver of user workarounds ( spreadsheets, asking in Discord) and therefore of product churn.
**Severity:** HIGH | **Confidence:** HIGH

### F-SRC-02 - HIGH: no global search
**Evidence.** absence. There is no cross-entity index, no `search` table, no external search
service, and `cmdk` (the natural basis for a command palette) is a dead dependency with a dead
`components/ui/command.tsx`.
**Impact:** the platform cannot answer "where is X?" for any entity. For an OS spanning people,
teams, contracts, sponsors and documents this is table stakes.
**Severity:** HIGH | **Confidence:** HIGH

### F-SRC-03 - MEDIUM: no full-text index anywhere
**Evidence.** no `tsvector`, no `GIN` index, no `pg_trgm`, no external search index in any of the
43 SQL files. Every "search" is either an exact-match filter or a client-side `includes()`.
**Impact:** even where search exists it is unindexed and unscalable.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-SRC-04 - MEDIUM: no search across the entities that will matter commercially
**Evidence.** contracts, sponsors, campaigns, deliverables, documents, tasks, invoices and assets
do not exist, so they cannot be searched.
**Severity:** MEDIUM | **Confidence:** HIGH

## 4. Future global-search requirements (Audit.md asks explicitly)
1. **A single search entry point** returning ranked, permission-filtered results across people,
   teams, competitions, matches, sessions, contracts, documents, sponsors, campaigns, assets,
   tasks and content.
2. **Authorisation applied inside the query**, never after it: the search index must be
   tenant-scoped (`org_id`) and row-scoped by the same policy engine as the rest of the system, so
   a player never sees a sponsor contract in results.
3. **Per-entity field-level visibility** — a search result must not leak a field the viewer may not
   see (for example a contract's compensation terms).
4. **Postgres full text** (`tsvector` + GIN) for Postgres-resident entities, with a
   `pg_trgm` fallback for fuzzy matching of names and handles; a dedicated index only if scale
   requires it.
5. **A denormalised, permission-aware search projection** maintained by trigger or outbox
   consumer, containing only the fields each role may see.
6. **A command palette** (`cmd-K`) reusing the same API, with recent and pinned items.
7. **Saved searches** and search-result exports for admin roles.
8. **Search analytics** (zero-result queries) to drive content and naming improvements.
9. **No secrets in the index**: webhook URLs, tokens and compensation terms must be excluded from
   any indexed text, and search must never return a document the caller cannot open.

## 5. Verdict
**BUILD NEW.** Reuse the *idea* of a filtered user search, discard the implementation. Wire
`cmdk` + `components/ui/command.tsx` (currently dead) into a real global search once the search
API exists.
