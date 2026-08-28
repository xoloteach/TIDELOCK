# TIDELOCK — Quality Rules

The authoritative specification is `TIDELOCK_ULTIMATE_FINAL_KIRO_PROMPT.md` at
the repository root. It wins any conflict with this file. This document is the
short, always-loaded reminder of the rules that are easiest to violate by
accident.

## The one-line goal

A player presses New Game, reaches an ending 2–3 hours later, and nothing
important felt like a placeholder.

## Never ship these

Visual:
- neon cyberpunk styling, purple/blue gradient UI, glassmorphism cards
- holograms, glowing every interactable, excessive bloom or chromatic aberration
- default Three.js materials with no art pass
- primitive-box placeholder geometry left in a final campaign space
- mixed asset packs without scale/material/colour normalisation

Narrative:
- runtime LLM-generated dialogue (all story dialogue is authored and committed)
- chosen-one plots, ancient secrets, evil sentient AI, evil-corporation caricature
- a villain explaining the plot in the finale
- NPCs whose only purpose is exposition
- every character speaking in complete, balanced paragraphs
- fake moral choices with one obviously correct option

Engineering:
- physics tied to render frame rate
- graphics presets that only change resolution
- menu toggles that do nothing
- tests that assert `true`, or assertions weakened to get green CI
- swallowed fatal initialisation errors
- claiming a feature works without launching the game

## Anti-slop dialogue test

Before committing a conversation, check:
1. Could a different character say these exact lines? (If yes, rewrite.)
2. Does it repeat something the environment or UI already told the player?
3. Does someone want something during the scene?
4. Is there subtext — something left unsaid?
5. Are line lengths varied, with interruptions and incomplete answers?
6. Is there at least one concrete, specific noun (a valve ID, a battery count)?
7. Does the scene end before it exhausts its point?

Major scenes are scored 0–2 on each of the ten questions in spec §63 and must
average ≥17/20. Below 15 means rewrite.

## Banned phrases

"This changes everything." "You have no idea." "It's bigger than all of us."
"I did what I had to do." "The truth deserves to be known." "There's no going
back." "They lied to us." "We're running out of time!" Trailer-speak generally.
Philosophical speeches during danger.

## Character voices

- **Mara** (player): short, direct, dry corrections. Gets quieter and more
  specific when emotional. No heroic speeches, no constant sarcasm.
- **Sera**: precise, names physical systems, avoids moral abstractions.
  Switches from institutional "we" to "I" when emotional. Never monologues
  past ~25 seconds.
- **Ivo**: conversational, human-scale detail ("six oxygen units and four
  batteries"), low-energy humour when he has the energy. Focuses on tasks when
  emotional. Not the moral compass — he has a bias toward stable power.
- **Dax**: questions, quoted claims, names and dates. Interrupts. Speaks too
  fast when emotional, then catches himself. Not automatically correct.

## Cut before shipping broken

A complete 2.2-hour game beats a broken 10-hour one. Before adding a system,
ask whether it improves the 2–3 hour campaign, whether the player will notice,
whether it can be tested automatically, and whether it runs on mobile.

## Definition of "done" for any change

Code compiling is not completion. Every change needs: typecheck, unit tests,
production build, the game actually launched, the changed path exercised in a
browser, console inspected, and a mobile viewport checked when UI, rendering
or input changed.
