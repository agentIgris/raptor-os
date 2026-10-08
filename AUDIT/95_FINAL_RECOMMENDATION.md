# 95 - FINAL RECOMMENDATION
**Audit.md section:** 103 (SECTION 100)

## 1. The verdict in one paragraph
**Raptor is a well-implemented prototype with an unsound foundation, and it should be rebuilt
rather than patched - but rebuilt on the same stack, preserving the domain knowledge, not the
code.** The technology (Next.js, Postgres, Supabase) is sound and was never the problem. The
problem is that the product's most valuable capabilities - paying people correctly, binding them
contractually, tracking what a sponsor is owed, supporting minors, and operating for more than
one organisation - are **entirely absent**, while the capabilities that are present are the least
valuable ones. Nothing in the current system is production-ready: **0 of 62 assessed capabilities
are complete, and 0 are secure enough to hand to a customer's employees**
(`85_FEATURE_MATRIX.md`).

## 2. The five findings that matter most
1. **It is not a multi-tenant product, and cannot become one by addition.** There is no
   organisation, no `organization_id`, and no `OrgMembership` anywhere in 32 tables
   (`60_MULTITENANCY.md`). Adding tenancy later is a rewrite of every table, every policy and
   every query. This is the single most consequential finding.
2. **Security is not a hardening gap; it is a design gap.** 14 of 32 tables have no RLS;
   `database/README.md` documents RLS as *disabled* for development and gives no re-enable
   procedure; `profiles` - 100% PII including government identifiers and bank details - is
   **readable by `anon`**; three endpoints accept unauthenticated uploads; ~25
   `SECURITY DEFINER` functions have no `REVOKE`; the Discord webhook is exposed
   (`13_RLS_SECURITY.md`, `15_API_SECURITY.md`, `19_SECRETS.md`, `20_STORAGE.md`).
3. **The money is wrong.** `integer` with no currency, no ledger, no invoice, and prize money
   that is **never allocated to anyone** - the single most important flow in esports is absent
   (`31_FINANCE.md` F-FIN-01, F-FIN-02). `GET /api/finance` leaks all finance rows to any team
   member (F-FIN-04).
4. **There is no way to know who did what.** 0 of 15 sensitive action classes are audited, there
   is no `updated_at` on most tables, no soft delete, and `removeConsole` deletes production logs
   (`49_AUDIT_LOGGING.md`, `50_DATA_RETENTION.md`, `52_OBSERVABILITY.md`).
5. **There is no engineering safety net.** Zero tests, no CI, typecheck and lint disabled in
   production builds, 27 dead UI components, and a live `ReferenceError` in the attendance API
   that shipped because nothing ran (`53_TESTING.md`, `54_CICD.md`, `next.config.mjs`).

## 3. What is genuinely worth keeping
This audit found real value, and it should not be lost in the criticism:
* **The tryout domain model** - six well-designed tables with a proper state machine
  (`29_TRYOUTS.md`). The data is salvageable; the plumbing is not.
* **The business rules** - attendance cutoffs, session generation, slot-expense calculation,
  the OCK/SSF/WWF tier ladder, Discord message vocabulary (`26_ATTENDANCE.md`,
  `31_FINANCE.md`, `22_DISCORD.md`). These took domain effort and are portable as
  specifications and test cases.
* **The tier pricing semantics** - a real, coherent pricing model that predates the code.
* **A genuine user base and brand** - the product is used, the roles are understood, and the
  Discord integration is valued.
* **A coherent technology choice** - Next.js + Postgres + Supabase + Vercel is right for this
  product and should be retained.

## 4. What to stop doing immediately
Ordered by urgency, regardless of the rebuild decision:
| Priority | Action | Why now |
| --- | --- | --- |
| **P0** | **Rotate every exposed secret** - the Discord webhook, all provider keys, the database URL | They are in git history and were readable (`19_SECRETS.md` F-SEC-01/02) |
| **P0** | **Make `profiles` and `contact_files` private** and disable the three unauthenticated upload/delete endpoints | Anonymous PII read and unauthenticated write are active exposures (`20_STORAGE.md` F-STOR-01, `15_API_SECURITY.md` F-API-12) |
| **P0** | **Remove `/api/public/stats`** and the fabricated figures | The product publishes invented statistics as fact (`31_FINANCE.md` F-FIN-03) |
| **P0** | **Enable RLS on every table** and revoke `anon` grants on people data, following the documented procedure | 14 tables exposed; the procedure exists but was never run (`13_RLS_SECURITY.md`) |
| **P0** | **Disable `/debug/*`** in production | Unauthenticated admin tooling in production (`06_UI_COMPONENTS.md`) |
| **P1** | **Fix or disable the broken attendance, tryout, roster, notifications and admin APIs** | These throw `ReferenceError`s and undefined-RPC errors in normal use (`14_API.md`) |
| **P1** | **Add a `.gitleaks`-style scan and a pre-commit secret hook** | Prevents a repeat |
| **P1** | **Turn on typecheck and lint in the production build** | Would have caught the shipped `ReferenceError` |
| **P1** | **Stop writing production logs to nowhere** - replace `removeConsole` with a real logger | No incident can be diagnosed today |
| **P2** | **Do not accept new enterprise customers** until Phase 1 is done | The procurement questionnaire cannot be answered (`92_COMPLIANCE.md` §6) |

None of these P0 items require the rebuild. **They are the containment steps while the rebuild
proceeds**, and they should start this week.

## 5. The recommended path
**Rebuild on the same stack. Sell-first. Migrate as a service. Do not compete on breadth.**
1. **Contain** (P0 above) - days, not months.
2. **Phase 0** - tests, CI, migrations, observability, staging, restore test. The project has
   never had a safety net; this is the prerequisite for everything.
3. **Phase 1** - multi-tenancy, the person/engagement model, the policy engine, the audit log.
   This is what makes an enterprise sale possible at all.
4. **Phase 2** - competitive operations, with the legacy tryout data and attendance rules carried
   across.
5. **Phase 3** - the ledger and the prize allocation engine. **This is the product.** It is the
   capability no competitor has and the reason an owner signs.
6. **Phase 4-5** - contracts, HR, payroll, sponsorships, content, billing, integrations, public
   site. Widen only after the core is proven with real money.
7. **Migrate each customer** with the assessed process (`83_DATA_MIGRATION.md`), sold as a service,
   with a mandatory dry run and a customer sign-off report.

## 6. The strategic case, in one paragraph
The esports organisation software market is underserved for a structural reason, not an
execution one: almost every product is team-centric, single-title, one-role-per-person, and treats
finance as a spreadsheet (`86_MARKET_GAP.md` §2). Raptor made the same six errors. Rebuilding
correctly is therefore not defensive work - it is the only way to compete. The wedge is not a
dashboard; it is **the prize and compensation engine, sponsor obligation tracking, and provable
contracts** - the three things that hold money and trust, and the three nobody else does. The
buyer is the organisation, not the player, and the organisation buys when it can prove it will pay
people correctly.

## 7. Confidence statement
* **High confidence**: the repository analysis, the schema and RLS findings, the route and
  permission analysis, the data-quality register, the feature matrix. All are derived from the
  code and the migration scripts.
* **Medium confidence**: production impact and prevalence of the data defects, because no live
  database was queried; the Phase 0 assessment must measure these (`84_DATA_QUALITY.md` §4).
* **Low confidence / unverified**: deployed Supabase RLS state, actual grants, storage bucket
  configuration, real row counts, real traffic, and whether any compensating control exists
  outside this repository (a WAF, a Supabase advisor-clean project, a manual process).
  **Every such statement in this audit is marked as unverified, per Audit.md Rule 1.**
* **Market claims** are desk research from public positioning and require commercial validation
  (`86_MARKET_GAP.md` §6).
* **Legal statements** are requirements, not advice, and require counsel per jurisdiction
  (`92_COMPLIANCE.md`).

## 8. The one-sentence recommendation
**Contain the exposure now, then rebuild the platform on the existing stack around a
multi-tenant, effective-dated, ledger-backed person-centric model - and lead with the prize
allocation engine, because that is the only capability in this market that touches money and
trust and that no competitor provides.**
