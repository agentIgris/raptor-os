# 21 — OCR
**Audit.md section:** 28 (SECTION 25 — OCR AUDIT)
**Verdict up front: OCR output must NOT be trusted automatically.** Evidence below.

## 1. Pipeline as implemented

```
User selects a screenshot (client component, no upload)
   └─ components/performance/ocr-extract.tsx (19,547 B)
        └─ lib/ocr-service.ts
             ├─ getWorker()  → tesseract.js createWorker()          :16-19
             ├─ URL.createObjectURL(file)  → the image NEVER leaves the device  :23
             ├─ worker.setParameters({ logger })                    :27-35
             ├─ worker.reinitialize("eng")                          :39
             ├─ worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })  :41
             ├─ worker.recognize(imageUrl)  → { text, confidence }   :44-49
             └─ OCRService.parsePerformanceData(text)               :60-146
                  ├─ Pattern 1: /^([A-Za-z][A-Za-z0-9_]{2,15})\s*[|\s]+(\d+)\s*[|\s]+(\d+)\s*[|\s]+(\d+)\s*[|\s]+(\d+\.?\d*)/g
                  ├─ Pattern 2: player-name line, then a 4-number line
                  ├─ Pattern 3: take ALL numbers, group into arbitrary sets of 4  :116-131
                  └─ while (results.length < 4) push { player_name: "PlayerN", kills: "", … }  :134-142
   └─ Values are placed into an EDITABLE form for human confirmation   (correct design)
   └─ On submit → POST /api/performances
```

## 2. Findings

### F-OCR-01 — HIGH: the parser fabricates data
**Evidence.** `lib/ocr-service.ts:116-131` (Pattern 3):
```ts
const allNumbers = text.match(/\d+\.?\d*/g) || []
const playerNames = text.match(/[A-Za-z][A-Za-z0-9_]{2,15}/g) || []
for (let i = 0; i < Math.min(playerNames.length, Math.floor(allNumbers.length / 4)); i++) {
  results.push({ player_name: playerNames[i] || `Player${i + 1}`,
                 kills: allNumbers[i * 4] || "0", assists: allNumbers[i * 4 + 1] || "0",
                 damage: allNumbers[i * 4 + 2] || "0", survival_time: allNumbers[i * 4 + 3] || "0" })
}
```
It takes **every number found anywhere in the screenshot** and assigns them positionally to
kills/assists/damage/survival in groups of four, matching them against **every alphabetic token**
in the image. A BGMI results screen contains many other numbers (rank points, damage dealt,
time, teammate index, item counts, a player-ID, the match clock) and many other words
(`Winner Winner Chicken Dinner`, `RANK`, `FINISH`, `K/D`, …). The resulting mapping is
essentially arbitrary.
Then `:134-142` pads to exactly four rows with placeholder players:
```ts
while (results.length < 4) { results.push({ player_name: `Player${results.length + 1}`, kills: "", … }) }
```
**Impact:** if Patterns 1 and 2 both fail, the user is shown a **fully populated, entirely
fabricated** statistics table that looks legitimate. If the user does not carefully inspect it,
com fabricated competitive statistics enter the organisation's record — and those statistics feed
`/api/performances`, `get_player_stats`, `get_team_performance_summary`, the analytics page, the
public `/api/public/stats` counters and PDF reports.
**Severity:** HIGH · **Confidence:** HIGH
**Recommendation:** never auto-populate from an unvalidated parse. Require explicit per-field
confirmation; show the raw OCR text alongside the parse; highlight low-confidence fields;
**refuse to submit** any row that was not confirmed; never synthesise placeholder rows.

### F-OCR-02 — HIGH: the single confidence threshold is meaningless
**Evidence.** `lib/ocr-service.ts:152-156`
```ts
const { text, confidence } = await this.extractTextFromImage(file, onProgress)
if (confidence < 30) { throw new Error(`OCR confidence only ${…}%. Try a clearer screenshot.`) }
return this.parsePerformanceData(text)
```
Tesseract returns a **document-level** confidence. There is **no per-word or per-field
confidence**, so a document can score 85 % overall while the one number that matters (kills) is
wrong. There is also **no cross-check** against the roster, the expected team size, plausible
ranges, or the sum of team kills versus the team's total.
**Impact:** false confidence. A confidently wrong value is worse than an obviously failed parse.
**Severity:** HIGH · **Confidence:** HIGH
**Recommendation:** use word-level bounding boxes and confidence; require confirmation below a
per-field threshold; validate against the roster (a parsed name must match a team member);
validate ranges (`kills ≤ 60`, `0 < damage < 5000`, `placement ≥ 1`); cross-check the team total
against the match's own figures; and record the OCR confidence **with the resulting record** so
the data's provenance is auditable.

### F-OCR-03 — MEDIUM: OCR is entirely client-side, so it is neither auditable nor enforceable
**Evidence.** `lib/ocr-service.ts:16-19` `createWorker()` is invoked from a `'use client'`
component. No image is uploaded; the `ocr_uploads` bucket and its policies
(`automation-scripts/08:145-161`) are **never referenced by application code**.
**Impact.**
* There is no server-side record that a screenshot was ever submitted or parsed — so
  "OCR-assisted entry" is not a defensible data-provenance claim.
* Any client-side transformation can be bypassed or forged; a user can POST arbitrary values.
* The parse logic ships to every browser (bundle cost) and can be trivially inspected.
* CPU and memory cost falls on the user's device — and the target user is often on a mid-range
  phone.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** move OCR server-side (a small, sandboxed service), keep the raw upload for a
short retention window for dispute resolution, and persist the confidence and the raw text
alongside the confirmed values.

### F-OCR-04 — MEDIUM: third-party runtime code fetch with no integrity control
**Evidence.** `createWorker()` is called with no `workerPath`, `corePath`, `langPath` or
`cacheMethod`, so Tesseract's defaults fetch WASM and `eng.traineddata` from a jsDelivr CDN at
runtime. The dependency is pinned to `"latest"` (`package.json:68`).
**Impact:** an availability dependency on a third party inside a business workflow; no
Subresource Integrity; the executed code is whatever the CDN serves at that moment; the version
is not reproducible.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** pin the version and self-host the model assets, or use a server-side OCR
provider with a data-processing agreement.

### F-OCR-05 — MEDIUM: raw OCR text is logged to the console
**Evidence.** `lib/ocr-service.ts:61` `console.log("Raw OCR text:", text)`; `:144`
`console.log("Parsed results:", results.slice(0, 4))`.
**Impact:** the full text of a player's screenshot — potentially containing in-game identifiers,
which are personal data in a minors-skewed population — is written to the browser console. In
production this is stripped by `removeConsole` (an accidental mitigation — see
`18_LOGGING.md` F-LOG-03).
**Severity:** MEDIUM · **Confidence:** HIGH

### F-OCR-06 — MEDIUM: no image validation at all
**Evidence.** `OCRService.extractTextFromImage(imageFile: File, …)` accepts any `File`; there is
no type check, no size check, and no dimension check. `URL.createObjectURL` is used on whatever
is supplied.
**Impact:** a very large image can exhaust browser memory (a DoS against the user's own
browser, but also a support burden); a non-image is passed to Tesseract with an opaque failure.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** validate type, size and pixel dimensions before processing; downscale
client-side for performance.

## 3. Can OCR results be trusted automatically?

**No.** Three independent reasons:
1. The parser's fallback path (`Pattern 3`) **invents** numbers and player names.
2. Confidence is measured at document level and is not attached to any field.
3. There is no reconciliation against the roster, the team size, or any plausible range.

The *design choice* of putting the parsed values into an **editable form before submission** is
correct and should be preserved — but the UI presents the fabricated fallback rows exactly like
genuinely parsed ones, so the human-in-the-loop control is not actually effective.

**V2 requirement:** OCR is an **input-assistance** feature, never an authoritative source. Every
OCR-derived value must be individually confirmed, must carry its confidence and the raw-text
offset into the immutable record, and must be reconcilable against independent sources (the
game's own API, where licensing permits) before it can be used in prize-money or eligibility
decisions.
