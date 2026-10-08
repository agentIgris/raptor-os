# 71 - FUTURE TRAVEL (requirements only - NOT implemented)
**Audit.md section:** 78 (SECTION 75)

## 1. Starting position
Absent (`39_TRAVEL.md`). The system knows a team bought a slot in an event on a date; nothing
about who travelled, how, or at what cost.

## 2. Requirements
### 2.1 Events and participation
* `Event` (or reuse `Competition` from `61_ORGANIZATION_MODEL.md`): name, organiser, game,
  venue, city, country, start/end dates (UTC + local), timezone, and the responsible `Entity`.
* `EventParticipation`: which team(s)/people are attending, their role, and their arrival/departure
  dates. **Travel attaches to a participation, not to a team**, because a five-person squad sends
  different people to different qualifiers.
* `Slot`/`Entry` (the migrated legacy ledger) links to the `Event`.

### 2.2 Itinerary
* `TravelPlan` per participation: `Traveler` (a `Person`), leg list, and per-leg detail
  (mode, carrier, reference, departure/arrival in UTC **and** local time, terminal, confirmation
  reference).
* `Booking` per leg, with the provider, the cost + currency, the payment status, and the
  confirmation document stored as a private `Asset`.
* `Accommodation`: property, check-in/out dates, room allocation per traveller, cost.
* `GroundTransport`: provider, cost.
* `ItineraryDocument`: a generated, shareable document with a **signed access token and an
  expiry** so it can be given to a traveller without granting access to the whole trip.

### 2.3 Documents and compliance
* `TravelDocument` per traveller per event: passport/ID (encrypted, access-logged), visa status
  and expiry, invitation letter, **travel authorisation**, and - critically for esports -
  **guardian consent for minors**, plus unaccompanied-minor arrangements where applicable.
* `VisaChecklist` per destination with a rule set per nationality; expiry alerts well ahead of
  travel.
* Insurance: policy reference, cover, validity, and a duty-of-care acknowledgement per traveller.

### 2.4 Budget, per diem, expenses
* `TravelBudget` per event or per period, by cost centre.
* `PerDiemPolicy` by location and duration, with the rate table and its effective dates.
* `TravelExpense` per traveller with `Receipt` assets, category, and an approval chain, posted to
  the ledger on approval (`66_FUTURE_FINANCE.md`).
* `Reconciliation`: budget vs committed vs spent, per event.

### 2.5 Duty of care
* A pre-travel checklist per participation (documents valid, insurance, emergency contacts,
  medical information, minors' consents, destination advisory).
* An in-trip check-in mechanism; an emergency contact record per traveller.
* Post-trip close-out.

## 3. Integrations
* **Travel-management providers** (TravelPerk, Navan, Spotter, Travelpayouts) for booking and duty
  of care - optional, per tenant.
* **Calendar** for the itinerary (`76_INTEGRATIONS.md`).
* **Maps/geocoding** for the venue.

## 4. Explicit non-goals
No ticketing, no visa application automation, no duty-of-care incident management beyond check-in,
no carbon accounting.

## 5. Special emphasis: minors
Travelling internationally with minors is the highest-risk operational activity in esports. The
platform must be able to demonstrate, for any given trip, that every traveller had valid
documents and, where required, guardian consent. That is a hard requirement, not a feature.

## 6. Migration
`slots` -> `Event` + `EventParticipation` + a `TravelPlan` created retrospectively where records
exist. Most historical travel will not exist in any system; budget for manual entry or accept the
gap.

## 7. Priority
Medium. Valuable for organisations that travel; for organisations that do not, it can be a later
module. The **document and consent** capability is the higher-priority part because it also serves
HR and contracts.
