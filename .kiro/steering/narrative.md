# TIDELOCK — Narrative Reference

Implement this story. Do not replace it, do not add supernatural or
chosen-one elements, and do not resolve it with a villain.

## Premise

The coastal borough of **Morrow Quay** was evacuated after a storm surge
overwhelmed its automated flood-management network. Three days later parts of
the borough are still sealed behind flood gates, pumps run inconsistently, and
maintenance machines enforce emergency access rules from corrupted maps. A
field clinic on higher ground runs on unstable backup power.

The player is **Mara Venn**, a former municipal field systems technician who
knows the borough's older infrastructure better than the contractors now
trying to recover it. She left after taking the blame for an earlier
maintenance incident caused by a management decision she was not allowed to
document publicly.

The storm was real. The failures were real. No single person caused the
disaster. But the evacuation and pump-priority tables had been quietly changed
months earlier.

## The central object

A **37-minute gap** in the flood network's audit history:

```
02:14:08 – 02:51:31   ARCHIVE UNAVAILABLE
```

During those minutes three people issued conflicting emergency overrides while
the system tried to preserve a field hospital, residential pumping, and an
emergency communications/data facility. The city later fragmented the audit
record because the full priority logic would expose years of politically
uncomfortable infrastructure decisions.

The question is not "who is the villain?" It is: **what does responsibility
mean when every option was bad, but some people were allowed to decide whose
risk counted?**

## The 37 minutes

| Time | Event |
| --- | --- |
| 02:14 | Storm surge exceeds forecast |
| 02:17 | Residential Pump Cluster B begins overcurrent shutdown |
| 02:21 | Hospital backup relay reports unstable transfer |
| 02:24 | Civic Relay Annex takes emergency dispatch traffic |
| 02:26 | Automatic optimizer begins shedding lower-priority pump loads |
| 02:31 | Dax's neighbourhood loses two pumps |
| 02:34 | Sera overrides the optimizer to restore one residential pump |
| 02:39 | Dispatch relay begins dropping calls |
| 02:42 | Ivo's predecessor requests priority for medical transport routing |
| 02:44 | Sera restores relay power |
| 02:47 | Pump Cluster B loses synchronisation |
| 02:51 | Manual flood gate attempt fails |

There is no evil button. The failure is a chain of constrained decisions. The
cover-up happened **afterward**, when the city published a simplified technical
failure report and split the original audit across departments.

## Cast

Four main characters. Six to eight minor NPCs, each with a name, a purpose,
2–8 lines, one visible action, and one detail unrelated to the plot.

- **Mara Venn** — player. 70–90 voiced lines.
- **Sera Holt** — flood systems engineer, coordinates recovery remotely, helped
  build the prioritisation model, signed the archive split. Not a villain: she
  believes releasing incomplete operational information mid-recovery invites
  panic, sabotage or political interference before the next tide. 80–100 lines.
- **Ivo Saye** — field clinic coordinator in an elevated transit depot, depends
  on stable power, Mara's most consistent human contact. Biased toward keeping
  power stable even if that delays disclosure. 65–85 lines.
- **Dax Ren** — local reporter/community archivist, entered the sealed district
  illegally. Wants the full audit published immediately even at operational
  risk. Not automatically correct. 60–80 lines.

Total campaign target: 300–380 voiced lines, 65–80% story dialogue.

## Structure

| Act | Target | Location | Ends with |
| --- | --- | --- | --- |
| Prologue — "Before the Waterline" | 10–15 min | Elevated transit depot | Mara crosses the service bridge into the sealed zone |
| Act I — "High Water" | 30–40 min | Residential edge, Pump Station 12 | Pump restarts; audit gap exposed; Dax makes contact |
| Act II — "The Quiet Floor" | 35–45 min | Commercial underpass, Civic Relay Annex | Partial audit found; Sera issued an override, reason unknown |
| Act III — "Thirty-Seven Minutes" | 40–50 min | Elevated rail, operations archive, flooded tunnel | Mara/Sera confrontation |
| Finale — "Open Gate" | 25–35 min | Main flood barrier control complex | One of three choices |
| Epilogue | 5–10 min | Depot | Consequences shown through world state, not text cards |

## The emotional centre

Sera: "I signed the archive split."
Mara: "Why?"
Sera: "Because at four in the morning we still had three gates stuck shut and a
second tide coming."
Mara: "That explains four in the morning."
*(pause)*
Mara: "What explains three days later?"

## Three endings

None is labelled good, bad or true.

- **A — Publish everything now.** Immediate accountability; sensitive
  resident/infrastructure data leaks; recovery coordination becomes chaotic;
  Sera loses operational authority. *Truth without curation has consequences.*
- **B — Restore first, release after.** Orderly recovery; Sera gets time to
  document technical context; Dax believes delay invites another institutional
  rewrite; epilogue confirms the archive does become public. *Timing can matter
  without being censorship.*
- **C — Release decisions, withhold the resident-risk dataset.** Accountability
  remains; proving discriminatory prioritisation becomes harder to verify
  independently; residents' data is protected. *Transparency and privacy can
  conflict.*

## Exposition rule

If information can be learned through level design, signage, object state, log
timestamps, player action, animation, a UI state or environmental audio, do not
also explain it in dialogue.

Environmental storytelling budget: 6–10 optional archival recordings, 12–18
short text notes. Not 50 audio diaries.

## Tone

Grounded near-future coastal industrial drama. Wet, cold, municipal,
improvised, recently evacuated, functional before the disaster, damaged by
systems failing under pressure. No skull piles, no zombies, no magic crystals.
The game must never explicitly lecture its themes — the player infers them.
