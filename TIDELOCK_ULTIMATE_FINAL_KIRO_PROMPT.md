# TIDELOCK — Ultimate Kiro Game Master Spec, Build Prompt & Benchmark

> **Purpose:** This file is the single source of truth for building a complete, polished, open-source, 2–3 hour 3D story game in Three.js that runs from low-end Android/WebGL2 devices through high-end desktop/macOS/WebGPU hardware.
>
> **Primary implementer:** Kiro Max / Kiro Cloud Sessions.
>
> **Primary human test device:** Android.
>
> **Primary continuous playtest target:** GitHub Pages.
>
> **Core rule:** Do not optimize for code volume. Optimize for a finished game that feels authored, deliberate, technically competent, and enjoyable.
>
> **Revision:** Final consolidated spec including cinematic sequencing, contextual first-use tutorials, first-class mobile controls, and continuous Kiro → GitHub → Pages execution gates.

---

# 0. Executive Mission

Build **TIDELOCK**, a complete 2–3 hour third-person 3D narrative action-adventure set in a flooded coastal district during a failed evacuation and infrastructure emergency.

The game must feel like a **real small commercial game**, not a Three.js demo, not an AI-generated asset dump, and not a generic “survival extraction” prototype.

The project must include:

- a beginning, middle, climax, ending, and epilogue;
- a coherent world and visual identity;
- authored NPCs with distinct voices;
- fully structured dialogue and subtitles;
- authored cinematic interaction/cutscene sequences for major NPC/story moments;
- a data-driven first-use contextual tutorial system that teaches mechanics only when they become relevant;
- generated voice assets through a build-time TTS pipeline;
- non-graphic combat primarily against malfunctioning machines;
- stealth, traversal, light environmental puzzles, exploration, and recovery objectives;
- deterministic NPC and enemy AI;
- real 3D positional audio;
- six graphics presets from **Potato** to **Cinematic**;
- WebGPU-first rendering with WebGL2 fallback;
- scalable physics, navigation, particles, shadows, water, vegetation, and post-processing;
- Android/iOS touch as a first-class control scheme, plus mouse/keyboard and controller support;
- customizable mobile HUD/control layout with contextual controls and correct tutorial glyphs;
- PWA/offline support;
- robust saves and settings;
- automated tests and browser-driven validation;
- GitHub Actions;
- continuous playable GitHub Pages builds;
- clear asset licensing;
- developer diagnostics;
- performance benchmarks;
- a rigorous definition of done.

This game should be small enough to finish but polished enough that a player can complete it in one sitting and say:

> “This is an actual game running in the browser.”

---

# 1. Non-Negotiable Quality Rules

## 1.1 Never ship “AI slop”

“AI slop” in this project means any of the following:

- generic neon cyberpunk everywhere;
- excessive purple/blue gradient UI;
- floating translucent glass cards for every screen;
- meaningless holograms;
- giant empty maps;
- random props with inconsistent art direction;
- obvious primitive-box placeholder environments left in the final build;
- NPCs whose entire purpose is exposition;
- dialogue that sounds like a trailer;
- every character speaking in perfect complete paragraphs;
- “chosen one” plots;
- “ancient secret awakens” plots;
- evil corporation caricatures;
- “the AI became sentient” as a lazy twist;
- a villain explaining the whole story in the finale;
- identical NPC personalities;
- fake moral choices where one choice is obviously correct;
- collectible lore that exists only because the game needs collectibles;
- giant lore dumps before the player cares;
- excessive bloom;
- excessive chromatic aberration;
- excessive screen shake;
- fake film grain everywhere;
- default Three.js materials with no art pass;
- asset packs mixed without material/color/scale normalization;
- mobile controls copied directly from a generic joystick demo;
- unreadable tiny text on phones;
- menus full of “Coming Soon” buttons;
- systems that technically exist but are not integrated into the campaign.

If a feature cannot be polished, cut it.

## 1.2 Finish before expanding

A complete 2.2-hour game is better than a broken 10-hour game.

Before adding a new system, ask:

1. Does it improve the 2–3 hour campaign?
2. Will the player notice it?
3. Can it be tested automatically?
4. Can it run on mobile?
5. Is there already a simpler system that solves the same problem?

If not, do not add it.

## 1.3 No runtime generative dialogue

NPC dialogue is authored.

No live LLM calls are required to play the game.

Reasons:

- quality consistency;
- offline support;
- latency;
- cost;
- safety;
- reproducibility;
- story pacing;
- subtitle synchronization;
- voice asset generation;
- deterministic testing.

NPC “AI” means behavior, perception, pathfinding, schedules, context, and state — not randomly generated conversations.

---

# 2. Game Identity

## Title

# **TIDELOCK**

Working subtitle:

**TIDELOCK: Thirty-Seven Minutes**

Do not use the subtitle in the main logo unless it survives the final art review.

## Genre

Third-person narrative action-adventure with:

- exploration;
- environmental traversal;
- light stealth;
- non-graphic machine combat;
- environmental puzzles;
- dialogue choices;
- story investigation;
- small hub areas connected by authored routes.

## Length

Target:

- first-time player: **2h 15m – 2h 50m**;
- fast player: **1h 40m minimum**;
- exploration-heavy player: **3h 15m maximum**.

Do not pad playtime with:

- repeated fetch quests;
- grind;
- arbitrary locked doors;
- duplicated enemy arenas;
- slow walking scenes;
- excessive collectibles;
- mandatory repeated travel through unchanged areas.

## Camera

Default: third-person over-the-shoulder.

Optional:
- close exploration camera;
- accessibility-adjustable FOV;
- photo/debug free camera in developer builds only.

Do not make first-person the primary mode.

## Tone

Grounded near-future coastal industrial drama.

The world should feel:

- wet;
- cold;
- municipal;
- improvised;
- recently evacuated;
- inhabited only hours/days ago;
- functional before the disaster;
- damaged by systems failing under pressure rather than fantasy destruction.

Avoid:
- post-apocalyptic skull piles;
- generic zombies;
- magic crystals;
- random military bases;
- abandoned-city clichés without environmental logic.

---

# 3. Story Bible

## 3.1 Core premise

The coastal borough of **Morrow Quay** was evacuated after a severe storm surge overwhelmed its automated flood-management network.

Officially, the disaster was blamed on a cascade of sensor failures.

Three days later, portions of the borough are still isolated behind sealed flood gates. Pumps are working inconsistently. Maintenance machines are enforcing emergency access rules using corrupted maps. A field clinic on higher ground is running from unstable backup power.

The city needs the old flood-control network brought back under manual supervision before the next tide.

The player is **Mara Venn**, a former municipal field systems technician who knows Morrow Quay’s older infrastructure better than the contractors currently trying to recover it.

Mara did not leave Morrow Quay because she hated the place. She left after taking the blame for an earlier maintenance incident caused by a management decision she was not allowed to document publicly.

She returns because the city needs someone who knows where the systems disagree with their own diagrams.

During the recovery, Mara discovers the storm was real, the failures were real, and no single person “caused” the disaster.

But the evacuation and pump-priority tables had quietly been changed months earlier.

The most important discovery is not a secret superweapon.

It is a **37-minute gap** in the flood network’s audit history.

During those 37 minutes, three people issued conflicting emergency overrides while the system tried to preserve:
- a field hospital;
- residential pumping;
- an emergency communications/data facility.

The city later fragmented the audit record because revealing the full priority logic would expose years of politically uncomfortable infrastructure decisions.

The central question is not:

> “Who is the villain?”

It is:

> “What does responsibility mean when every available option was bad, but some people were allowed to decide whose risk counted?”

## 3.2 Themes

Primary:
- institutional responsibility;
- maintenance versus spectacle;
- truth versus immediate stability;
- how systems encode human priorities;
- guilt without a simple villain.

Secondary:
- local knowledge matters;
- infrastructure becomes invisible when it works;
- a city is remembered through ordinary objects, not lore terminals.

The game must never explicitly lecture the player about these themes.

The player should infer them.

---

# 4. Main Characters

Keep the primary cast small.

Four memorable people are better than twenty generic NPCs.

## 4.1 Mara Venn — Player Character

Age: adult.

Role:
- former municipal field systems technician;
- physically capable but not a soldier;
- understands pumps, relays, maintenance access, old municipal layouts.

Personality:
- observant;
- dry;
- impatient with vague instructions;
- avoids talking about her old disciplinary case;
- does not deliver heroic speeches.

Dialogue behavior:
- asks practical questions first;
- notices inconsistencies;
- rarely says exactly what she feels;
- short responses under pressure;
- can choose empathetic, skeptical, or task-focused phrasing without becoming three different personalities.

Important:
Mara should be voiced sparingly enough that the player still inhabits her, but enough to support character chemistry.

Target:
- 70–90 voiced lines for Mara.

## 4.2 Sera Holt — Flood Systems Engineer

Role:
- senior engineer coordinating recovery remotely;
- knows the current infrastructure;
- helped create the emergency prioritization model;
- participated in the post-disaster audit fragmentation.

Surface personality:
- calm;
- exact;
- operational.

Under pressure:
- becomes more specific, not louder;
- starts quoting exact times and valve identifiers;
- refuses moral abstractions.

Not a villain.

She genuinely believes releasing incomplete operational information during the recovery could trigger panic, sabotage, or political interference before the next tide.

Speech signature:
- names physical systems;
- avoids words like “truth,” “betrayal,” “destiny,” or “sacrifice”;
- corrects imprecise technical language;
- pauses before personal answers;
- never monologues for more than 20–25 seconds.

Target:
- 80–100 voiced lines.

## 4.3 Ivo Saye — Field Clinic Coordinator

Role:
- running a temporary clinic in an elevated transit depot;
- depends on stable power;
- becomes Mara’s most consistent human contact.

Personality:
- tired;
- practical;
- funny only when he has enough energy to be funny;
- notices people more than systems.

He is not “the moral compass.”

He has a bias:
- he will prioritize keeping power stable even if that delays disclosure.

Speech signature:
- concrete human details;
- never says “people will die” as melodrama;
- instead says things like “I have six oxygen units and four batteries.”
- mild understatement;
- occasionally changes subject rather than answering emotionally.

Target:
- 65–85 voiced lines.

## 4.4 Dax Ren — Local Reporter / Community Archivist

Role:
- stayed near the evacuation perimeter;
- has been collecting public records and eyewitness accounts;
- enters the sealed district illegally before Mara meets him.

Personality:
- sharp;
- impatient with institutional vagueness;
- brave but not fearless;
- capable of being unfair when he thinks someone is hiding behind procedure.

Not automatically correct.

He wants the complete audit published immediately, even when there are operational risks.

Speech signature:
- asks for names, dates, and exact claims;
- repeats someone’s vague wording back to them;
- interrupts long explanations;
- notices omissions.

Target:
- 60–80 voiced lines.

## 4.5 Incidental NPCs

Maximum 6–8 minor survivors/workers.

Each minor NPC gets:
- name;
- purpose;
- 2–8 lines;
- one visible action;
- one detail unrelated to the main plot.

Examples:
- transit cleaner recovering keys;
- electrical contractor looking for a missing tool case;
- resident trying to retrieve medication from a sealed apartment;
- rescue worker marking safe stairwells.

Do not make them quest-vending statues.

---

# 5. Campaign Structure — 2–3 Hours

## Prologue — “Before the Waterline”
**Target: 10–15 minutes**

Location:
- elevated transit depot / temporary recovery base.

Goals:
- calibrate controls;
- meet Ivo;
- establish Sera over radio;
- learn traversal;
- receive maintenance pulse tool;
- show Morrow Quay from above;
- let player see lights still flickering in flooded blocks.

Story beat:
Mara asks why the old pump diagrams were requested if the new digital map is supposedly accurate.

Sera:
“It’s accurate where it was updated.”

Mara:
“That isn’t the same sentence.”

Do not explain the 37-minute gap.

End:
Mara crosses the service bridge into the sealed zone.

---

## Act I — “High Water”
**Target: 30–40 minutes**

Primary location:
- residential edge;
- pump station 12;
- flooded service alleys;
- rooftop bypass.

Gameplay introduced:
- world interaction;
- shallow/deep water rules;
- environmental electricity hazard;
- maintenance drone avoidance;
- first controlled machine-combat encounter;
- optional survivor rescue;
- first compact puzzle.

Objective:
restore Pump Station 12 so the clinic grid stops brownout cycling.

Narrative discoveries:
- pump station logs show two different priority maps;
- one map includes “Civic Relay Annex” as critical infrastructure;
- one does not;
- Mara finds a handwritten maintenance note contradicting the official commissioning date.

Act ending:
pump restarts, but a system status page exposes a missing audit interval:

**02:14:08 – 02:51:31: ARCHIVE UNAVAILABLE**

Dax contacts Mara on an unsecured channel:
“Don’t ask Holt where the log went. Ask who was allowed to delete it.”

Cut immediately back to gameplay/radio response.

No dramatic sting.

---

## Act II — “The Quiet Floor”
**Target: 35–45 minutes**

Locations:
- abandoned shopping/service street;
- maintenance underpass;
- Civic Relay Annex;
- dry server floor beneath a partially flooded lobby.

Gameplay:
- more complex traversal;
- navigation around patrol routes;
- optional disable/avoid approach;
- timed power rerouting puzzle;
- environmental storytelling;
- short dialogue encounter with Dax in person.

Story:
The Civic Relay Annex was not just a private data center.

During the storm, it temporarily carried emergency dispatch traffic after another relay failed.

That means keeping it powered was not obviously corrupt.

However, its designation as “life-safety priority” had been granted months before the storm using a policy document that also changed pumping guarantees for two residential sectors.

Dax sees this as proof the district was sold out.

Sera insists the relay designation was necessary because the old emergency radio network was already failing.

Mara finds part one of the missing audit.

Important:
The audit shows Sera did issue an override.

It does **not** show why yet.

The player should be suspicious but not certain.

---

## Act III — “Thirty-Seven Minutes”
**Target: 40–50 minutes**

Locations:
- elevated rail;
- municipal operations archive;
- flooded maintenance tunnel;
- gate-control approach.

Gameplay:
- largest contiguous traversal sequence;
- changing water levels;
- machine patrols coordinating;
- optional route discovered through local maintenance knowledge;
- one major environmental set piece;
- no giant boss.

Story:
The player reconstructs the missing 37 minutes from:
- partial audit records;
- local controller logs;
- dispatch audio;
- relay load history;
- manual valve state.

Timeline:

02:14 — storm surge exceeds forecast.

02:17 — residential Pump Cluster B begins overcurrent shutdown.

02:21 — hospital backup relay reports unstable transfer.

02:24 — Civic Relay Annex takes emergency dispatch traffic.

02:26 — automatic optimizer begins shedding lower-priority pump loads.

02:31 — Dax’s neighborhood loses two pumps.

02:34 — Sera overrides the optimizer to restore one residential pump.

02:39 — dispatch relay begins dropping calls.

02:42 — Ivo’s predecessor requests priority for medical transport routing.

02:44 — Sera restores relay power.

02:47 — Pump Cluster B loses synchronization.

02:51 — manual flood gate attempt fails.

There is no single “evil button.”

The failure is a chain of constrained decisions.

The cover-up happened **afterward**, when the city chose to publish a simplified technical failure report and split the original audit across departments.

Act confrontation:
Mara speaks directly with Sera.

No screaming.

No confession monologue.

Sera says:
“I signed the archive split.”

Mara:
“Why?”

Sera:
“Because at four in the morning we still had three gates stuck shut and a second tide coming.”

Mara:
“That explains four in the morning.”

Pause.

Mara:
“What explains three days later?”

That is the emotional center.

---

## Finale — “Open Gate”
**Target: 25–35 minutes**

Location:
- main flood barrier control complex.

Gameplay:
- combine traversal, puzzle logic, AI avoidance, limited combat;
- route power;
- physically inspect gate controls;
- restore manual authority;
- final system operates based on decisions made during the campaign.

No giant monster.

No evil-AI final boss.

Climax is the player doing a difficult physical recovery operation while the human conflict resolves over radio.

### Final choice

The player has recovered:
- full audit timeline;
- private priority map;
- resident-linked infrastructure risk data;
- gate restoration procedure.

Three choices, each imperfect.

### Ending A — Publish Everything Now

Mara gives Dax the entire archive immediately.

Effect:
- public accountability begins immediately;
- sensitive resident/infrastructure data also leaks;
- recovery coordination becomes more chaotic;
- Sera loses operational authority;
- Ivo’s clinic experiences a difficult power transfer but remains functioning if the player completed an optional stabilization task.

Theme:
truth without curation has consequences.

### Ending B — Restore First, Release the Audit After

Mara keeps the archive offline until gates and pumps are stable, then releases the decision timeline and policy documents.

Effect:
- recovery is more orderly;
- Sera gets time to document technical context;
- Dax believes delay risks another institutional rewrite;
- epilogue confirms the archive does eventually become public.

Theme:
timing can matter without automatically being censorship.

### Ending C — Release Decisions, Withhold Resident-Risk Dataset

Mara publishes the complete human/technical decision trail but destroys or seals the dataset that maps households to infrastructure-risk modeling.

Effect:
- key accountability remains;
- some evidence used to prove discriminatory prioritization becomes harder to independently verify;
- residents’ sensitive information is protected.

Theme:
transparency and privacy can conflict.

No ending is labelled Good/Bad/True.

---

## Epilogue
**Target: 5–10 minutes**

Return to the elevated depot.

Show consequences through:
- altered radio news;
- NPC placement;
- short conversations;
- background repair activity;
- player’s final view of Morrow Quay.

Do not use paragraph-heavy ending cards unless absolutely necessary.

One concise ending card is acceptable.

---

# 6. Dialogue Bible — Anti-Slop System

Dialogue quality is a first-class production requirement.

## 6.1 Hard bans

Avoid these phrases and their close cousins unless used ironically and intentionally:

- “This changes everything.”
- “You have no idea.”
- “It’s bigger than all of us.”
- “We need to talk.”
- “I did what I had to do.”
- “Sometimes the hardest choices…”
- “The truth deserves to be known.”
- “There’s no going back.”
- “We’re running out of time!” repeated generically.
- “Can you hear me?”
- “Stay with me!”
- “You’re not going to believe this.”
- “What have we done?”
- “This was never supposed to happen.”
- “They lied to us.”
- “The city abandoned us.”
- “I’m getting too old for this.”
- trailer-speak;
- dramatic rhetorical questions every scene;
- philosophical speeches during danger;
- characters explaining facts every participant already knows.

## 6.2 Dialogue principles

Every dialogue scene must have:
- an immediate practical purpose;
- a character objective;
- at least one thing left unsaid;
- interruption by movement/environment when appropriate;
- lines that sound different when spoken by different characters.

Prefer:
- short lines;
- incomplete answers;
- corrections;
- specific nouns;
- practical observations;
- occasional silence;
- characters misunderstanding each other;
- characters changing topics;
- disagreement over facts before disagreement over morals.

Do not make every line witty.

Do not make every line grim.

## 6.3 Exposition rule

If information can be learned through:
- level design;
- signage;
- object state;
- log timestamps;
- player action;
- animation;
- a UI state;
- environmental audio;

do not also explain it in dialogue.

## 6.4 Conversation length

Radio bark:
- 1–2 lines.

Gameplay exchange:
- 2–8 lines.

Major scene:
- 10–24 lines.

No single character gets more than about 90 spoken words without player action or interruption.

## 6.5 Choice design

Most conversation nodes:
- 2–3 choices maximum.

Choices represent attitude/intention:
- practical;
- empathetic;
- skeptical.

Do not write:
- obviously evil option;
- obviously saintly option;
- joke option in every menu.

Choices may alter:
- later line;
- trust flag;
- optional help;
- epilogue detail.

They do not need to branch the entire campaign.

## 6.6 Sample character-specific dialogue

These are tone anchors, not a script to copy everywhere.

### Sera
Mara: “Station Twelve has two priority tables.”
Sera: “Which revision?”
Mara: “Both say current.”
Sera: “Then neither is.”

### Ivo
Ivo: “If you’re near the depot breaker, don’t touch it.”
Mara: “Wasn’t planning to.”
Ivo: “Good. I put a chair against it. Very advanced system.”

### Dax
Dax: “Holt called it a sensor cascade.”
Mara: “It was.”
Dax: “That wasn’t my question.”
Mara: “You didn’t ask one.”

### Mara
Sera: “The diagram should show a service ladder.”
Mara: “It also shows dry concrete.”

## 6.7 Voice count target

Total campaign:
- **300–380 voiced lines**;
- 65–80% story dialogue;
- 20–35% barks, reactions, optional interactions.

Do not inflate the count for marketing.

---

# 7. NPC AI

## 7.1 Human NPC AI

Human NPCs are not combat bots.

They need:
- navigation;
- contextual facing/look-at;
- small schedules;
- interaction positioning;
- idle variation;
- reaction to player distance;
- conversation staging;
- safe locomotion around hazards;
- simple awareness of major world-state changes.

Use:
- navmesh;
- authored waypoints;
- state machine / utility scores;
- contextual animation tags.

States:
- Idle;
- Work;
- WalkTo;
- Observe;
- Converse;
- React;
- Shelter;
- ScriptedTask.

No random wandering through story scenes.

## 7.2 Machine AI

Primary danger comes from malfunctioning municipal machines.

Categories:
1. inspection unit;
2. repair crawler;
3. security/containment unit;
4. heavy gate-maintenance frame.

Combat remains non-graphic.

Player can:
- avoid;
- distract;
- temporarily disable;
- use environment;
- engage directly using fictional maintenance/pulse equipment.

Do not model real-world weapon behavior.

## 7.3 Perception model

Machines should use:
- vision cone;
- range;
- occlusion raycast;
- sound events;
- last-known position;
- alert propagation with limits.

States:
- Dormant;
- Patrol;
- Inspect;
- Suspicious;
- Alert;
- Search;
- Pursue;
- Recover;
- Disabled.

Avoid omniscient AI.

## 7.4 Navigation

Use Recast/Detour navigation:
- baked/generated navmesh per sector;
- off-mesh links for stairs/doors when necessary;
- crowd simulation only if useful;
- path recalculation throttled;
- no per-frame full pathfinding.

## 7.5 Difficulty scaling

Difficulty changes:
- detection forgiveness;
- search persistence;
- machine reaction time;
- recovery windows;
- environmental hint frequency.

Difficulty does **not** merely multiply health.

---

# 8. Core Gameplay Systems

## 8.1 Movement

Required:
- walk;
- sprint;
- crouch;
- jump where appropriate;
- contextual vault;
- step-up;
- slope handling;
- ladder interaction where authored;
- shallow water slowdown;
- deep-water blocked/swim only if specifically implemented and polished.

Use Rapier kinematic character controller or a custom controller built on Rapier shape casts.

Player collider:
- capsule preferred.

Must handle:
- stairs;
- slopes;
- moving platforms;
- narrow spaces;
- grounding;
- snap-to-ground;
- edge cases at variable frame rates.

## 8.2 Interaction

Single consistent interact action.

Interactions:
- door;
- switch;
- valve;
- terminal;
- pickup;
- inspect;
- NPC;
- breaker;
- ladder;
- objective object.

UI should show:
- compact icon;
- verb;
- optional hold indicator.

Avoid glowing every object.

Use authored highlight only at close range.

## 8.3 Traversal puzzles

Puzzle principles:
- understand space;
- trace power/water;
- operate physical infrastructure;
- read environmental state.

Examples:
- route backup power through two safe breakers;
- open a service bypass;
- lower water enough to cross;
- restore a lift;
- align a relay;
- isolate one electrical section before entering water.

Never turn into abstract colored-laser puzzle rooms.

## 8.4 Inventory

Keep small.

Categories:
- mission items;
- repair components;
- optional evidence;
- consumable utility items if needed.

Do not implement 60-item crafting.

No inventory Tetris unless it proves fun.

## 8.5 Progression

Progression should unlock capabilities, not stat grind.

Possible upgrades:
- longer pulse-tool charge;
- better scan range;
- quieter movement over water;
- faster maintenance interactions;
- extra recovery charge.

Maximum:
- 5–7 meaningful upgrades.

## 8.6 Checkpoints

Checkpoint at:
- act transitions;
- major puzzle completion;
- before final sequence;
- after major conversation.

Also allow manual save at safe locations if implementation is reliable.

---

# 9. World Design

## 9.1 Map philosophy

Do not build a giant open world.

Build four dense connected districts.

Suggested structure:

1. Recovery Depot — hub/prologue/epilogue.
2. Residential Edge + Pump 12.
3. Commercial Underpass + Relay Annex.
4. Rail/Archive/Gate Complex.

World should feel bigger through:
- sightlines;
- inaccessible flooded streets;
- distant structures;
- moving lights;
- sound;
- background repair activity.

## 9.2 Sector streaming

World divided into sectors.

Each sector owns:
- render assets;
- colliders;
- navmesh;
- audio zones;
- interactables;
- NPCs;
- triggers;
- light probes/baked data;
- LOD metadata.

Load:
- current;
- adjacent;
- transition sector.

Unload:
- sectors beyond memory/distance threshold unless story requires persistence.

Persist gameplay state separately from loaded scene objects.

## 9.3 Environmental storytelling

Use ordinary evidence:
- damp evacuation notices;
- half-packed apartment;
- elevator inspection sticker;
- delivery cages left open;
- shop shutters;
- handwritten pump maintenance tag;
- transit board frozen at evacuation time;
- clinic extension cables;
- sandbags placed badly and then corrected.

Avoid 50 audio diaries.

Maximum optional archival recordings:
- 6–10.

Maximum text notes:
- 12–18, generally short.

---

# 10. Art Direction

## 10.1 Visual identity

Keywords:
- coastal municipal;
- wet concrete;
- oxidized steel;
- painted safety markings;
- sodium/amber work lights;
- gray-green water;
- cloudy daylight;
- emergency LEDs;
- practical equipment.

Avoid generic “cyberpunk.”

Technology should look:
- maintained;
- labeled;
- bolted down;
- designed by multiple contractors across decades.

## 10.2 Material language

Surfaces:
- concrete;
- painted steel;
- rubber;
- ceramic tile;
- wet asphalt;
- glass;
- plastic municipal housings;
- aluminum;
- warning paint.

PBR maps:
- base color;
- normal;
- roughness;
- metallic only where physically appropriate;
- AO when useful.

Do not make everything reflective.

## 10.3 Lighting

Use a hybrid strategy:
- environment/HDR-based lighting;
- baked/static contribution where possible;
- limited important dynamic lights;
- shadow-casting lights budgeted by preset;
- local practical lights for story readability.

Never light a scene only because it looks “cinematic.”
Players must read:
- traversal edges;
- doors;
- hazards;
- interactables;
- characters.

---

# 11. Six Graphics Levels

The game must expose **six named quality presets**.

Every preset must alter a meaningful bundle of features.

Never present six presets that differ only in resolution.

## Tier 1 — POTATO

Goal:
run the complete game on weak WebGL2 mobile hardware.

Defaults:
- WebGL2 preferred/fallback;
- internal resolution scale 0.50–0.65;
- 30 FPS target;
- very low shadow count or blob/fake contact shadows;
- 512px/low texture variants where available;
- lowest LOD distances;
- aggressive sector unload;
- reduced vegetation;
- minimal particles;
- simplified water;
- no expensive screen-space reflections;
- no AO;
- reduced anisotropy;
- low audio emitter count;
- reduced machine update frequency at distance;
- simplified decals;
- capped dynamic lights.

Visual goal:
still intentionally art-directed, not broken.

## Tier 2 — LOW

- 0.65–0.75 resolution scale;
- 30/45 FPS target option;
- one important dynamic shadow source;
- basic fog;
- low-medium LOD;
- low particle density;
- simple water normals;
- limited decals;
- basic bloom only if inexpensive;
- medium texture variants selectively.

## Tier 3 — MEDIUM

- 0.80–0.90 scale;
- 45/60 FPS target;
- PBR full material set;
- moderate shadow distance;
- better vegetation;
- improved water;
- moderate particles;
- low-cost AO where supported;
- better texture anisotropy;
- better NPC/machine animation distance.

## Tier 4 — HIGH

- 0.90–1.00 scale;
- 60 FPS target;
- WebGPU when available;
- higher shadow resolution;
- longer shadow distance;
- higher LOD distance;
- more decals;
- denser vegetation;
- better water reflections/refraction approximation;
- AO;
- bloom;
- improved fog;
- more GPU particles;
- wetness effects;
- enhanced material detail.

## Tier 5 — ULTRA

- 1.00 native scale;
- optional mild supersample on strong hardware;
- higher shadow cascades/quality;
- longer world detail distance;
- higher particle budget;
- improved reflections;
- higher-quality water;
- volumetric-style atmosphere approximations;
- contact detail;
- higher texture residency;
- denser environmental animation;
- full post-processing stack deemed stable.

## Tier 6 — CINEMATIC

Not default.

Designed for:
- screenshots;
- high-end desktops;
- visual showcases.

Features:
- 1.0–1.25 render scale if GPU budget allows;
- maximum stable shadows;
- maximum LOD;
- long draw distance;
- maximum foliage;
- premium water;
- highest reflection quality available in current renderer;
- denser particles;
- best atmosphere/fog;
- maximum texture variants;
- optional depth of field only where gameplay readability is preserved;
- 30/60 target selectable.

Cinematic must never introduce different gameplay.

## Dynamic scaler

Each preset acts as a ceiling.

Runtime system may dynamically lower:
1. render scale;
2. particles;
3. shadow distance;
4. vegetation density;
5. secondary effects.

Do not constantly oscillate quality.

Use hysteresis and multi-second averages.

---

# 12. Rendering Architecture

## 12.1 Renderer

Primary:
- Three.js `WebGPURenderer`;
- TSL/node materials;
- automatic WebGL2 backend fallback where supported by Three.js.

Add an explicit compatibility mode:
- force WebGL2;
- disable unstable WebGPU-only effects.

Reason:
WebGPU is still not universally available, while Three.js WebGPURenderer can use WebGL2 fallback.

## 12.2 Shader strategy

Prefer TSL for new custom effects that need WebGPU/WebGL2 portability.

Custom visual systems:
- water;
- rain;
- wetness;
- foliage wind;
- atmospheric fog;
- scan/highlight;
- machine status lights;
- damage feedback;
- post effects.

Avoid separate WGSL and GLSL implementations unless unavoidable.

## 12.3 Post-processing

Use Three’s current node-based post-processing path with WebGPURenderer.

Effects must be switchable individually.

Required candidate effects:
- tone mapping;
- color grading;
- subtle bloom;
- AO;
- vignette only if extremely subtle;
- optional reflection effect;
- optional depth effect for Cinematic.

No permanent chromatic aberration.

## 12.4 Render budgets

Track:
- FPS;
- CPU frame ms;
- GPU frame ms when available;
- draw calls;
- triangles;
- active lights;
- shadow casters;
- texture count;
- loaded sector count.

Expose in developer diagnostics.

---

# 13. Physics

Use:
- `@dimforge/rapier3d-compat` initially for maximum bundler portability;
- consider normal `@dimforge/rapier3d` after stable Vite WASM validation if bundle-size savings justify it.

Rapier compatibility builds embed WASM into JS and trade a larger package for broader bundler support.

## Fixed timestep

Physics:
- fixed timestep, e.g. 60 Hz;
- accumulator;
- interpolation for rendering;
- cap catch-up steps to prevent spiral-of-death.

Gameplay logic must not depend on raw render delta.

## Collider strategy

Static world:
- simplified collision meshes;
- avoid render-mesh-as-collider for everything.

Dynamic:
- simple primitives/convex shapes where possible.

Player:
- capsule.

Triggers:
- sensor colliders with layers.

Collision groups:
- player;
- world;
- machine;
- interactable;
- trigger;
- debris.

## Physics quality scaling

Potato:
- fewer active dynamic props;
- faster sleep;
- lower simulation distance;
- reduced debris.

High/Cinematic:
- more dynamic props;
- longer awake range if stable.

Core puzzle physics must remain deterministic enough to complete on all presets.

---

# 14. three-mesh-bvh

Use `three-mesh-bvh` for render/world spatial queries such as:
- fast raycasts;
- interaction targeting;
- camera collision helpers;
- environment queries;
- debugging;
- optional visibility helpers.

Do not duplicate Rapier responsibilities blindly.

Rapier:
physics.

BVH:
fast mesh spatial queries.

---

# 15. Navigation

Use:
- `recast-navigation`;
- `@recast-navigation/three`.

Build navmesh from simplified navigation geometry.

Do not generate full navmesh every frame.

Prefer:
- pre-generated sector navmesh artifacts where possible;
- runtime generation only for development or small dynamic regions.

Agent parameters should include:
- radius;
- height;
- max climb;
- max slope.

Provide navmesh debug view.

---

# 16. ECS / Game Architecture

Use `miniplex` or an equally small TypeScript ECS.

Do not use a giant generic engine framework on top of Three.js.

Entity examples:

```ts
{
  id,
  transform,
  renderable,
  collider,
  velocity,
  health,
  interactable,
  machineAI,
  navAgent,
  dialogueActor,
  audioEmitter,
  persistence,
}
```

Systems:

- InputSystem
- CharacterSystem
- InteractionSystem
- PhysicsSystem
- RenderSyncSystem
- AnimationSystem
- NavigationSystem
- PerceptionSystem
- MachineAISystem
- HumanNPCSystem
- MissionSystem
- DialogueSystem
- AudioSystem
- StreamingSystem
- SaveSystem
- GraphicsQualitySystem
- PerformanceSystem
- UISystem

Rule:
No `GameManagerFinal2.ts`.

Managers/services only for true global resources.

---

# 17. Animation

Three.js:
- `AnimationMixer`;
- clips loaded from glTF/GLB.

Required player states:
- idle;
- walk;
- run;
- crouch;
- jump start/air/land;
- interaction;
- climb/vault if implemented;
- pulse-tool action;
- hit/reaction without graphic injury.

NPC:
- idle variants;
- walk;
- work;
- talk;
- look;
- react;
- sit/lean where authored.

Machines:
- locomotion;
- scan;
- alert;
- disable/recover;
- interaction-specific mechanical motion.

Use:
- crossfades;
- additive upper-body layer only if robust;
- animation event markers for footsteps/interactions.

Foot sliding is a quality failure.

---

# 18. Asset Pipeline

## 18.1 Format

Runtime 3D assets:
- GLB preferred.

Why:
- compact;
- web-friendly;
- materials;
- animation;
- skins;
- one-file transport.

## 18.2 Optimization

Use `@gltf-transform/cli`.

Pipeline:
1. validate;
2. remove unused data;
3. deduplicate;
4. resize textures;
5. compress geometry;
6. generate/attach KTX2 textures where appropriate;
7. inspect result;
8. enforce budgets.

Geometry:
- Meshopt preferred for broad game asset use;
- Draco only where it gives a meaningful size advantage.

Textures:
- KTX2/Basis;
- ETC1S for many color textures;
- UASTC for normals/quality-sensitive maps when justified.

## 18.3 Open-source licensing

Assets committed to the public repo must be redistributable.

Preferred:
- original project-created assets;
- CC0 assets;
- clearly compatible permissive licenses.

Poly Haven:
- CC0;
- suitable for HDRIs, textures, and selected models.

Mixamo:
- royalty-free for games according to Adobe’s FAQ;
- however, treat raw source-asset redistribution separately from “use in a game.”
- Do not blindly commit an external animation library into an open asset repo.
- Keep a documented import pipeline and license manifest.

Every asset record should contain:
- source;
- author if applicable;
- license;
- original filename;
- transformed output;
- notes.

Create:
`ASSET_LICENSES.md`

Never use random scraped models.

## 18.4 Art consistency pass

Every external asset must be normalized for:
- real-world scale;
- texel density;
- color palette;
- roughness range;
- material naming;
- pivot/origin;
- collision representation;
- LOD;
- lighting response.

---

# 19. Texture & Memory Strategy

Use:
- Three `KTX2Loader`;
- Basis Universal transcoding;
- device-capability detection.

Create texture classes:
- hero;
- environment;
- background;
- UI;
- decals.

Suggested maxima are budgets, not promises:

Potato:
- mostly 512–1K.

Low:
- 1K dominant.

Medium:
- 1K with selective 2K.

High:
- selective 2K.

Ultra:
- 2K/limited 4K hero only.

Cinematic:
- 4K only where visually proven useful.

Never use 4K because the source file exists.

---

# 20. Audio System

## 20.1 Runtime

Use:
- Web Audio API;
- Three `AudioListener`;
- Three `Audio`;
- Three `PositionalAudio`.

Buses:
- Master;
- Music;
- Ambience;
- Dialogue;
- Effects;
- UI.

Provide independent sliders.

## 20.2 3D audio

Use positional emitters for:
- machines;
- water;
- pump rooms;
- alarms;
- environmental sources;
- nearby NPC speech where appropriate.

Use audio zones for:
- tunnels;
- enclosed rooms;
- open streets;
- depot;
- server/relay spaces.

Use filters/reverb sparingly.

## 20.3 Music

Music should be restrained.

No constant epic score.

States:
- exploration;
- tension;
- act transition;
- finale;
- epilogue.

Allow silence.

## 20.4 TTS pipeline

Primary requested development pipeline:
- Python `edge-tts`.

Generate voice files at **build/asset-generation time**, not during normal gameplay.

Input:
`content/dialogue/*.json`

Output:
- audio;
- subtitle timing;
- manifest.

Pipeline:
1. validate dialogue;
2. synthesize voice;
3. generate subtitle timing;
4. FFmpeg loudness/format pass;
5. emit normalized runtime file;
6. update dialogue manifest.

Do not call an online TTS service every time the game runs.

## 20.5 Important TTS licensing caution

The open-source `edge-tts` package is an unofficial client for Microsoft Edge’s online speech service.

Its repository documents usage but does not itself grant a commercial voice-output license.

Therefore:
- use it for development/placeholder generation;
- before a commercial release, verify the applicable service/voice terms;
- keep the speech generator behind an adapter so another provider/offline model can replace it;
- never couple game logic to one provider.

Optional self-hostable fallback:
- Kokoro-class/open-weight TTS if chosen licenses are compatible;
- any replacement must be reviewed per model/voice license.

## 20.6 Voice direction

Do not generate every voice with identical:
- pace;
- pitch;
- loudness;
- sentence rhythm.

Per-character voice config:
- voice ID;
- rate;
- volume;
- pronunciation substitutions;
- pause markup strategy;
- post EQ if needed.

Do not use extreme pitch manipulation.

---

# 21. Input — Everywhere

Build a unified action map.

Actions:
- MoveX / MoveY
- LookX / LookY
- Interact
- Sprint
- Crouch
- Jump/Vault
- ToolAction
- ToolAlt
- Scan
- Pause
- Journal
- DialogueSelect
- Cancel

Gameplay code consumes actions, not raw keys/buttons.

## 21.1 Keyboard/mouse

Use:
- Pointer Lock API where available;
- graceful fallback when pointer lock fails.

Settings:
- sensitivity;
- invert Y;
- FOV;
- raw input when supported;
- key rebinding.

## 21.2 Controller

Use native Gamepad API.

Support:
- standard mapping;
- Xbox-style;
- PlayStation-style;
- generic;
- Bluetooth Android controllers.

Features:
- deadzone;
- sensitivity;
- invert;
- remapping;
- prompt glyph switching;
- haptics only when supported.

Never require a specific controller brand.

## 21.3 Mobile — First-Class Platform

Touch controls must be authored as a real mobile game control scheme, not a desktop HUD with buttons overlaid on it. A player must be able to start a new game and reach every ending using touch only.

### Core exploration layout

- left thumb: analog movement joystick;
- right half of screen: drag/swipe camera look;
- context action: talk / interact / pick up / open / use depending on target;
- jump/vault;
- crouch;
- sprint or sprint-lock behavior appropriate to movement;
- scan/tool action;
- pause;
- journal/objective access;
- optional radial tool/item selector.

### Combat/tool context

When a tool/weapon encounter requires it, expose only the controls that matter:
- primary action / fire;
- aim/ADS where the equipped tool supports it;
- reload/recharge;
- alternate tool action;
- quick swap or radial selection;
- contextual dodge/evade only if implemented as a real mechanic.

Do not permanently cover the screen with every possible action. The HUD is context-aware:
- exploration hides combat-only controls;
- talking to an NPC prioritizes interaction/dialogue;
- puzzle interactions prioritize use/cancel;
- cutscenes hide gameplay controls except skip/pause where allowed.

Use `nipplejs` only for joystick mechanics if it remains lightweight and reliable. Do not let the library dictate visual design, layout, state, or the rest of the touch interface.

### Mobile control editor

The player can:
- drag movable controls;
- resize controls;
- adjust opacity;
- choose fixed or floating movement joystick;
- adjust joystick size/deadzone;
- adjust camera sensitivity;
- adjust aim sensitivity independently;
- choose left-handed/right-handed presets;
- reset to defaults;
- optionally enable gyro aim if a stable browser/native path is available;
- toggle supported vibration/haptics.

Persist the customized layout in settings.

### Touch behavior requirements

- robust multi-touch: moving while looking and pressing an action must work;
- camera touch area must not steal joystick touches;
- action buttons must not cause camera jumps;
- safe-area insets respected;
- browser navigation/zoom/selection gestures prevented inside the game surface where appropriate;
- orientation changes handled without corrupting the layout;
- controls remain usable across phone/tablet aspect ratios;
- no critical button under browser chrome/notch/cutout.

### Device-aware prompts

The interaction/tutorial system must immediately switch prompts based on the most recently active input family:
- keyboard/mouse;
- controller;
- touch.

On touch, tutorial prompts highlight or pulse the actual on-screen control instead of displaying desktop text such as “Press E”.

---

# 22. UI / UX Bible

## 22.1 Visual language

UI should resemble:
- municipal service interface;
- maintenance labels;
- transit/equipment typography;
- practical status displays.

Not:
- generic SaaS dashboard;
- holographic glass wall;
- cyberpunk HUD.

## 22.2 HUD

Default HUD minimal:
- objective hint only when needed;
- tool status;
- health/recovery state;
- contextual interaction;
- subtitles;
- optional compact compass.

Hide UI when unnecessary.

## 22.3 Menus

Required:
- Title;
- Continue;
- New Game;
- Load;
- Settings;
- Credits;
- Accessibility.

Settings:
- Graphics;
- Display;
- Audio;
- Controls;
- Accessibility;
- Gameplay.

## 22.4 Graphics menu

Expose:
- preset;
- target FPS;
- resolution scale;
- dynamic scaling;
- shadows;
- texture quality;
- effects;
- reflections;
- AO;
- bloom;
- vegetation;
- particles;
- draw distance;
- renderer/backend diagnostics.

Advanced settings can be collapsible.

## 22.5 Mobile UX

Minimum touch targets:
large enough for real fingers.

UI must respect:
- safe areas;
- notches;
- landscape orientation;
- variable aspect ratios.

Do not shrink desktop UI.

## 22.6 Subtitles

Options:
- on/off;
- size;
- speaker name;
- background;
- high-contrast mode.

Avoid subtitles covering touch controls.

---

# 23. Accessibility

Required:
- subtitle controls;
- color-blind-safe objective indicators;
- camera shake slider/off;
- motion blur off by default unless clearly justified;
- hold/toggle sprint;
- hold/toggle crouch;
- input rebinding;
- controller sensitivity;
- touch sensitivity;
- reduced flashing option;
- difficulty modes;
- aim/interaction assistance for machine encounters if needed;
- scalable text;
- FOV on desktop;
- auto-pause on focus loss.

---

# 24. Saves & Persistence

Use:
- IndexedDB via Dexie;
- Zod for schema validation.

Data:
- campaign checkpoint;
- mission state;
- world flags;
- player upgrades;
- settings;
- controls;
- collected evidence;
- dialogue choices;
- ending flags;
- completed tutorial IDs / tutorial reset version;
- seen/skipped optional cinematic IDs where story logic needs persistence.

Version every save schema.

Implement migrations.

Never crash because an old save is missing a field.

Provide:
- autosave;
- manual slot(s) if stable;
- export save JSON in debug/developer menu;
- clear/reset option.

---

# 25. PWA / Offline

Use:
- `vite-plugin-pwa`;
- Workbox.

Strategy:
- shell always available;
- core game assets cached deliberately;
- large sectors cached based on play progress rather than blindly precaching multi-GB data;
- service worker update behavior must not corrupt an active session.

PWA:
- installable;
- manifest;
- icons;
- landscape orientation preference;
- offline core gameplay after required assets are cached.

Test service-worker updates.

---

# 26. Platform Packaging

Primary:
- web build;
- GitHub Pages;
- PWA.

Mobile optional release packaging:
- Capacitor Android;
- Capacitor iOS when a compatible build environment exists.

Desktop optional:
- Tauri 2 for Windows/macOS/Linux.

Do not block the web game on native packaging.

---

# 27. Dependencies

## Runtime baseline

```bash
pnpm add \
  three \
  @dimforge/rapier3d-compat \
  three-mesh-bvh \
  recast-navigation \
  @recast-navigation/three \
  miniplex \
  nipplejs \
  dexie \
  zod \
  @pmndrs/detect-gpu \
  stats-gl
```

## Development / build

```bash
pnpm add -D \
  typescript \
  vite \
  vite-plugin-pwa \
  @gltf-transform/cli \
  vitest \
  @playwright/test \
  tweakpane
```

## Mobile packaging

```bash
pnpm add @capacitor/core @capacitor/android @capacitor/ios
pnpm add -D @capacitor/cli
```

## Dialogue generation

```bash
python -m pip install edge-tts
```

System tooling:
- FFmpeg;
- Basis Universal encoder / `toktx` or supported KTX2 tooling when required by pipeline;
- optional Blender CLI for asset conversion tasks.

## Dependency rule

Do not add another library if:
- Three.js already provides it;
- browser APIs provide it;
- the current stack already solves it;
- it adds a second conflicting state/audio/physics/rendering framework.

---

# 28. Repository Structure

```text
tidelock/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── pages.yml
│       ├── visual.yml
│       └── asset-audit.yml
│
├── .kiro/
│   └── steering/
│       ├── game-quality.md
│       ├── architecture.md
│       ├── narrative.md
│       └── testing.md
│
├── content/
│   ├── dialogue/
│   ├── missions/
│   ├── evidence/
│   └── localization/
│
├── public/
│   ├── assets/
│   │   ├── audio/
│   │   ├── models/
│   │   ├── textures/
│   │   ├── nav/
│   │   └── sectors/
│   └── pwa/
│
├── scripts/
│   ├── generate-dialogue.py
│   ├── process-audio.py
│   ├── optimize-assets.ts
│   ├── validate-assets.ts
│   ├── build-navmesh.ts
│   ├── benchmark.ts
│   └── screenshot-matrix.ts
│
├── src/
│   ├── app/
│   ├── engine/
│   │   ├── audio/
│   │   ├── input/
│   │   ├── physics/
│   │   ├── render/
│   │   ├── resources/
│   │   ├── streaming/
│   │   └── time/
│   │
│   ├── game/
│   │   ├── ai/
│   │   ├── animation/
│   │   ├── characters/
│   │   ├── dialogue/
│   │   ├── interactions/
│   │   ├── missions/
│   │   ├── player/
│   │   ├── progression/
│   │   └── world/
│   │
│   ├── graphics/
│   │   ├── quality/
│   │   ├── shaders/
│   │   ├── water/
│   │   ├── weather/
│   │   └── post/
│   │
│   ├── ui/
│   ├── accessibility/
│   ├── persistence/
│   ├── diagnostics/
│   └── main.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── browser/
│   ├── visual/
│   ├── performance/
│   └── saves/
│
├── LICENSE
├── ASSET_LICENSES.md
├── README.md
├── CHANGELOG.md
├── pnpm-lock.yaml
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

# 29. GitHub Pages Continuous Playtest

## Goal

Every meaningful pushed build on the active development branch should become playable from Android with minimal delay.

Recommended working branch:
`kiro/game-build`

Recommended Pages workflow:
- trigger on push to `kiro/game-build` and/or `main`;
- install pnpm;
- install locked dependencies;
- typecheck;
- run critical tests;
- production build;
- upload Pages artifact;
- deploy.

Production release:
- main branch/tag.

Development playtest:
- active game-build branch if repository policy permits.

Never deploy a build that:
- fails typecheck;
- fails boot test;
- has missing required assets;
- has fatal console errors.

Set correct Vite base path for repository Pages URLs.

---

# 30. Kiro Cloud / GitHub Development Strategy

## 30.1 Use a Kiro Spec first

Before implementation:
- load this file;
- produce requirements;
- produce architecture;
- produce task list;
- compare generated spec against this file;
- this file wins when there is conflict unless a verified technical limitation requires a change.

## 30.2 Cloud Session

Use Kiro Cloud Session for long tasks.

Kiro cloud sessions can:
- clone connected repositories;
- execute in a sandbox;
- continue after disconnect;
- be resumed from other devices.

The sandbox includes browser automation tooling such as:
- headless Chrome;
- Playwright MCP;
- agent-browser;
- Chrome DevTools MCP.

Therefore “I cannot visually test this” is not an acceptable excuse for normal web UI/game boot validation.

## 30.3 Periodic commit protocol

Do not wait until the entire game is complete before creating history.

After every coherent milestone:

```text
feat(engine): bootstrap renderer and quality system
feat(physics): add fixed-step Rapier character controller
feat(world): stream pump-station sector
feat(story): implement Act I objective chain
feat(dialogue): add Sera/Ivo Act I conversations
feat(audio): generate synchronized dialogue assets
perf(mobile): reduce sector memory and draw calls
test(e2e): add prologue playthrough
...
```

Commit rules:
- coherent scope;
- buildable whenever possible;
- no “massive update” commit covering unrelated systems;
- do not commit broken generated assets without manifest changes;
- update CHANGELOG/devlog summary per milestone.

### HARD SANDBOX-SURVIVAL RULE — PUSH BEFORE THE NEXT MAJOR CHANGE

Kiro sandboxes are disposable. **No completed major work may exist only inside the current sandbox.** GitHub is the durable source of truth.

After every major/coherent working change, Kiro MUST perform this sequence **before beginning the next major change**:

```text
IMPLEMENT ONE MAJOR/COHERENT CHANGE
        ↓
TYPECHECK / RELEVANT TESTS / BUILD
        ↓
RUN OR BROWSER-TEST THE AFFECTED FEATURE
        ↓
FIX CRITICAL FAILURES
        ↓
UPDATE docs/IMPLEMENTATION_STATUS.md + evidence
        ↓
GIT ADD
        ↓
GIT COMMIT WITH A SPECIFIC MESSAGE
        ↓
GIT PUSH TO THE ACTIVE REMOTE BRANCH
        ↓
VERIFY THE REMOTE PUSH SUCCEEDED
        ↓
ONLY THEN START THE NEXT MAJOR CHANGE
```

This is a **hard execution gate**, not a suggestion. Never accumulate several major systems locally and plan to push them later. A sandbox crash, timeout, recycle, quota stop, agent restart, or session loss must cost at most the currently unfinished small unit of work.

Rules:
- target **one pushed commit per major coherent change**;
- multiple small tightly-coupled edits may share one commit when they form one feature;
- do not combine unrelated finished features into a later mega-commit;
- after a successful commit, `git push` immediately;
- verify the pushed SHA/branch exists remotely before proceeding;
- if GitHub/remote push fails, **stop starting new major work** and retry/repair the push first;
- never use force-push on shared/default branches unless explicitly required and safe;
- never rewrite published history merely to make it prettier;
- CI may run after the push; if CI fails, repair it in the next focused commit and push that repair immediately;
- generated dialogue/assets that are required for the feature must be committed or reproducibly generated by scripts/manifests before the feature is considered durable;
- keep commits small enough that another fresh Kiro sandbox can understand, test, revert, or continue them.

For a very long feature that cannot reasonably be completed in one sandbox-safe unit, create **checkpoint commits on the development branch** at stable compile/build points and push them. Prefix an intentionally incomplete checkpoint clearly, for example:

```text
wip(world): checkpoint flooded-district streaming pass
```

A WIP checkpoint must still avoid knowingly corrupting the repository and must record the exact continuation point in `docs/IMPLEMENTATION_STATUS.md`. Once the feature is complete, follow with a normal validated feature commit.

**The remote repository, not the sandbox filesystem, is project memory.**

Push/update GitHub after every validated coherent milestone. Do not defer durable progress to the end of a Cloud Session.

Keep one active long-lived development PR/branch where practical so Pages can update on branch pushes.

## 30.4 Kiro Automation loop

Kiro Web Automations can run on schedules in independent sandboxes and open PRs.

Use automations for:
- regression scans;
- test-gap filling;
- performance audits;
- stale TODO cleanup;
- asset-license audits;
- broken-link/missing-asset checks;
- nightly screenshot matrices.

Do **not** let an automation randomly redesign story or architecture.

Suggested hourly automation prompt during the limited plan window:

> Inspect the current TIDELOCK repository and the master spec. Identify the highest-priority incomplete item that can be completed safely in one run without contradicting existing architecture. Implement it, run typecheck, tests, build, launch the game in the sandbox browser, inspect console/runtime errors, capture relevant screenshots, fix discovered regressions, and open/update a focused PR. Do not rewrite completed systems without evidence. Do not weaken tests. Do not add filler features. Prefer finishing campaign-critical work.

Because automation runs are independent, store project state in:
- repository;
- task checklist;
- `docs/IMPLEMENTATION_STATUS.md`;
- tests;
- issues/PRs.

## 30.5 Implementation status file

Kiro must maintain:

`docs/IMPLEMENTATION_STATUS.md`

Sections:
- Complete;
- In Progress;
- Blocked;
- Next 10 Tasks;
- Known Regressions;
- Performance;
- Story Completion;
- Test Coverage;
- Asset Issues.

Update after each major milestone.

---

# 31. Testing Philosophy

Writing code is not completion.

For every system Kiro changes:

1. build;
2. typecheck;
3. run relevant unit tests;
4. launch game;
5. exercise changed behavior;
6. inspect console;
7. inspect network failures;
8. inspect screenshot/visual result;
9. test mobile viewport where relevant;
10. fix failures;
11. repeat.

Never:
- skip a failing test without documenting why;
- weaken assertion just to pass;
- hide browser exceptions;
- catch and ignore fatal initialization errors;
- mark a task complete from static code review only.

---

# 32. Automated Test Matrix

## 32.1 Unit tests

Test:
- mission state transitions;
- dialogue flags;
- tutorial first-trigger/completion/reset persistence;
- cutscene start/skip/resume/cleanup state;
- save schema;
- save migrations;
- quality preset values;
- dynamic scaler hysteresis;
- input mapping;
- inventory;
- interaction rules;
- machine state transitions;
- utility scoring;
- objective triggers;
- subtitle timing parsing.

## 32.2 Integration tests

Test:
- renderer initialization;
- WebGPU path when available;
- WebGL2 compatibility path;
- Rapier initialization;
- world sector load/unload;
- navmesh load;
- player spawn;
- checkpoint save/load;
- dialogue/audio manifest;
- mission completion unlock.

## 32.3 Browser E2E

Use Playwright.

Required:
- game boots;
- title menu appears;
- New Game works;
- Prologue begins;
- settings open;
- every graphics preset can be selected;
- settings persist reload;
- touch HUD appears in mobile emulation;
- keyboard HUD does not show on desktop;
- save created;
- continue resumes;
- scene transition works;
- no fatal console errors.

## 32.4 Story smoke tests

Provide test hooks/dev commands to jump to checkpoints.

Check:
- Prologue;
- Act I start/end;
- Act II start/end;
- Act III start/end;
- Finale;
- Ending A;
- Ending B;
- Ending C;
- Epilogue.

Each checkpoint must:
- boot;
- have valid objective;
- not spawn inside geometry;
- have required NPC/dialogue assets;
- be completable.

## 32.5 Visual regression

Capture fixed screenshots:
- depot daylight;
- wet residential street;
- pump station interior;
- relay annex;
- flooded tunnel;
- gate complex;
- dialogue close-up;
- mobile HUD;
- each graphics preset.

Compare for:
- missing materials;
- pink/black textures;
- extreme overexposure;
- broken UI;
- camera clipping;
- absent NPCs.

Do not use pixel-perfect thresholds so strict that harmless GPU differences fail CI.

## 32.6 Audio tests

Validate:
- every referenced clip exists;
- subtitle file exists;
- duration nonzero;
- no clipping beyond set threshold;
- dialogue IDs unique;
- voices route through Dialogue bus;
- no autoplay failure crash.

## 32.7 Asset tests

Validate:
- file exists;
- license record exists;
- GLB parses;
- KTX2 parses;
- texture dimensions within budget;
- no accidental 8K textures;
- no enormous uncompressed WAV in runtime folder unless justified;
- no duplicate source assets;
- no missing LOD references.

---

# 33. Performance Benchmark Suite

Create in-game benchmark mode.

Command/query example:
`?benchmark=1`

Benchmark path:
- depot;
- outdoor rain;
- dense street;
- interior pump room;
- water scene;
- multiple machines;
- dialogue scene.

Measure per preset:
- average FPS;
- 1% low approximation;
- CPU ms;
- GPU ms if available;
- draw calls;
- triangles;
- peak loaded sectors;
- long frames;
- memory where browser exposes useful data.

Benchmark result export:
JSON + readable text.

Do not fabricate GPU metrics when unavailable.

---

# 34. Quality Targets

These are goals, not claims until measured.

## Potato

Target:
- stable playable 30 FPS on weak-to-moderate mobile WebGL2 hardware after tuning;
- no campaign blockers;
- no missing visual cues.

## Low

Target:
- 30–45 FPS on modest mobile/integrated hardware.

## Medium

Target:
- 45–60 FPS on stronger mobile / ordinary laptop.

## High

Target:
- 60 FPS on capable modern hardware.

## Ultra

Target:
- 60 FPS on stronger desktop hardware where practical.

## Cinematic

Target:
- visual maximum;
- 30 or 60 depending hardware;
- not used for competitive benchmark claims.

If hardware cannot hit target:
dynamic scaler should degrade gracefully.

---

# 35. Developer Diagnostics

Toggle:
- F1 desktop;
- hidden multi-tap gesture on mobile developer build;
- query flag.

Display:
- renderer backend;
- adapter/GPU string if available;
- preset;
- dynamic scale;
- FPS;
- CPU/GPU ms;
- draw calls;
- triangles;
- visible objects;
- active lights;
- shadow count;
- loaded sectors;
- physics bodies;
- sleeping bodies;
- machine AI count;
- nav agents;
- audio emitters;
- save version;
- current mission;
- current checkpoint.

Buttons:
- Copy Diagnostics;
- Export Benchmark;
- Reload Sector;
- Respawn;
- Jump Checkpoint in dev;
- Toggle Colliders;
- Toggle Navmesh;
- Toggle BVH;
- Toggle AI Perception.

---

# 36. Mobile-Specific Benchmark

Required viewports:
- 1280×720 landscape;
- 1920×1080-like high DPI logical landscape;
- tablet aspect ratios;
- narrow phone landscape.

Check:
- safe areas;
- thumb reach;
- no overlap;
- readable subtitles;
- pause button reachable;
- controls not under browser UI;
- orientation changes handled;
- no accidental page zoom/scroll;
- game resumes after backgrounding when possible;
- audio context restores gracefully;
- simultaneous move + look + action multi-touch;
- control-editor drag/resize persistence;
- context HUD transitions exploration → interaction → combat → cutscene;
- tutorial highlight targets the correct touch control;
- touch-only prologue completion.

---

# 37. GitHub Actions

Minimum workflows.

## CI

Matrix:
- Ubuntu;
- Windows;
- macOS when runtime/tooling supports the commands.

Jobs:
- install;
- typecheck;
- unit;
- build;
- asset validation.

Browser E2E can primarily run on Ubuntu to control cost/time.

## Pages

On selected branches:
- build;
- critical smoke test;
- Pages artifact;
- deploy.

## Visual

Scheduled/manual:
- screenshots;
- artifact upload;
- comparison report.

## Asset Audit

Scheduled:
- license manifest;
- sizes;
- missing references;
- optimization budgets.

---

# 38. Narrative Implementation Data Model

Dialogue must be data-driven.

Example:

```json
{
  "sceneId": "act1_pump12_priority",
  "participants": ["mara", "sera"],
  "nodes": [
    {
      "id": "s1",
      "speaker": "mara",
      "text": "Station Twelve has two priority tables.",
      "audio": "dlg/act1/s1.ogg",
      "next": "s2"
    }
  ]
}
```

Support:
- conditions;
- flags;
- choices;
- interrupts;
- objective events;
- subtitle timings;
- audio asset path;
- replay protection;
- skippable/non-skippable flag.

Do not hardcode 300 lines in TypeScript.

---

# 39. Mission Data Model

Each objective:
- id;
- title;
- description;
- activation condition;
- completion condition;
- world markers;
- optional hints;
- next objective;
- checkpoint behavior;
- test hook.

Mission system must survive save/reload.

---

# 40. Story Completion Checklist

A build is not “story complete” because all acts have folders.

Story complete means:

- [ ] Prologue fully playable.
- [ ] All four main characters introduced naturally.
- [ ] Act I playable start to finish.
- [ ] Act II playable start to finish.
- [ ] Act III playable start to finish.
- [ ] Finale playable.
- [ ] Three final choices functional.
- [ ] Three epilogue variations functional.
- [ ] Dialogue audio exists for required lines.
- [ ] Subtitles synchronized.
- [ ] No placeholder “TODO dialogue”.
- [ ] No “lorem ipsum.”
- [ ] No T-pose story scenes.
- [ ] Every main conversation has blocking/staging.
- [ ] Major story beats have authored cinematic/sequence treatment where appropriate.
- [ ] Cutscenes transition cleanly into and out of gameplay and are skippable according to policy.
- [ ] Critical story clues can be found.
- [ ] Player understands the 37-minute timeline without a final exposition dump.

---

# 41. UI Completion Checklist

- [ ] Title screen visually authored.
- [ ] No generic Bootstrap-like cards.
- [ ] New Game.
- [ ] Continue.
- [ ] Save/load state.
- [ ] Pause.
- [ ] Graphics.
- [ ] Audio.
- [ ] Controls.
- [ ] Accessibility.
- [ ] Touch customization/control editor.
- [ ] Context-aware mobile HUD.
- [ ] First-use contextual tutorial presentation.
- [ ] Tutorial reset/replay option.
- [ ] Controller glyphs.
- [ ] Objective display.
- [ ] Dialogue choices.
- [ ] Subtitles.
- [ ] Credits.
- [ ] License/third-party notices.
- [ ] Mobile safe areas.
- [ ] Keyboard navigation where practical.

---

# 42. Graphics Completion Checklist

- [ ] Six presets.
- [ ] Presets have documented differences.
- [ ] Dynamic quality scaler.
- [ ] WebGPU path.
- [ ] WebGL2 path.
- [ ] Water.
- [ ] Wetness.
- [ ] Fog/atmosphere.
- [ ] Rain/weather state.
- [ ] LOD.
- [ ] Sector streaming.
- [ ] KTX2 texture path.
- [ ] Mesh compression.
- [ ] Shadow scaling.
- [ ] Particle scaling.
- [ ] Debug performance display.
- [ ] No missing/pink textures.
- [ ] No shader compilation errors in supported fallback.

---

# 43. Audio Completion Checklist

- [ ] Master bus.
- [ ] Music bus.
- [ ] Dialogue bus.
- [ ] Effects bus.
- [ ] Ambience bus.
- [ ] UI bus.
- [ ] 3D positional sound.
- [ ] subtitles.
- [ ] voice manifest.
- [ ] build-time TTS.
- [ ] audio normalization.
- [ ] environmental loops.
- [ ] footsteps by surface class if feasible.
- [ ] indoor/outdoor transition.
- [ ] volume settings persist.
- [ ] browser autoplay unlock handled.

---

# 44. Final Benchmark — 1000 Points

Kiro should self-score honestly.

## A. Completion — 250

- 60: complete beginning-to-ending campaign.
- 40: all acts connected without dev console.
- 30: three endings.
- 30: save/continue.
- 30: dialogue audio/subtitles.
- 30: NPC staging.
- 30: no placeholder campaign-critical content.

## B. Gameplay — 160

- 30: movement feels stable.
- 25: interaction consistent.
- 25: machine AI works.
- 20: traversal variety.
- 20: puzzles integrated with world.
- 20: progression meaningful.
- 20: checkpoints robust.

## C. Narrative — 150

- 30: characters distinct.
- 30: dialogue avoids generic exposition.
- 25: story understandable through play.
- 25: moral conflict not binary.
- 20: environmental storytelling.
- 20: finale pays off 37-minute mystery.

## D. Graphics — 150

- 25: cohesive art direction.
- 25: six presets genuinely distinct.
- 20: WebGPU/WebGL2 support.
- 20: lighting/material quality.
- 20: water/weather.
- 20: LOD/streaming.
- 20: post effects controlled/not excessive.

## E. Performance — 120

- 25: Potato mode functional.
- 20: dynamic scaler.
- 20: low draw-call discipline.
- 15: compressed textures/assets.
- 15: sleeping/throttled physics/AI.
- 15: benchmark instrumentation.
- 10: no catastrophic memory leak in campaign smoke run.

## F. Cross-platform input/UX — 90

- 25: touch.
- 20: keyboard/mouse.
- 15: gamepad.
- 10: settings persist.
- 10: accessibility.
- 10: responsive UI.

## G. Engineering / Tests — 80

- 20: architecture coherent.
- 15: critical unit tests.
- 15: browser E2E.
- 10: GitHub Actions.
- 10: asset/license audit.
- 10: diagnostics.

### Release threshold

- **900–1000:** release candidate.
- **820–899:** strong beta; fix deficits.
- **720–819:** incomplete polish; do not call finished.
- **<720:** prototype.

Kiro must not award points for files that merely exist.

A feature earns points only if it works.

---

# 45. Automatic Rejection Conditions

The user should reject the build if any of these remain in the claimed final version:

- giant empty map;
- obvious primitive placeholder level;
- broken touch controls;
- no mobile optimization;
- no story ending;
- generic AI dialogue;
- “mysterious energy” plot replacing the authored story;
- “evil sentient AI” twist;
- neon cyberpunk restyle;
- all NPCs standing still;
- major NPC/story encounters presented only as static text boxes with no staging;
- no real cinematic sequence system for major beats;
- tutorials dumped all at once instead of contextual first-use teaching;
- touch tutorial prompts that say desktop keys instead of highlighting mobile controls;
- 20-minute exposition intro;
- no voice/subtitles;
- no six graphics presets;
- presets that do almost nothing;
- no WebGL2 fallback;
- unlicensed random assets;
- 4K textures everywhere;
- massive initial download without streaming;
- physics tied to frame rate;
- missing save/load;
- console full of errors;
- tests disabled;
- fake tests that only assert `true`;
- mobile UI overlapping;
- audio starting before user gesture and failing;
- service worker serving old incompatible chunks forever;
- Kiro claiming “done” without launching the game.

---

# 46. Exact Kiro Master Prompt

Copy everything below into the Kiro session **after this file exists in the repository**.

---

## MASTER IMPLEMENTATION PROMPT

You are the lead engineer, technical artist, gameplay programmer, narrative implementer, QA engineer, and release engineer for **TIDELOCK**.

The repository contains `ULTIMATE_KIRO_GAME_MASTER_SPEC_AND_BENCHMARK_PROMPT.md`. Treat it as the authoritative product specification.

Your mission is not to create a demo.

Your mission is to deliver the complete, polished 2–3 hour game described in that file.

### Operating mode

Work autonomously for as long as the session permits.

Do not stop because one subsystem is functional.

Continue through the prioritized task list until the game reaches the release threshold in the benchmark or an external limitation genuinely prevents further work.

Maintain `docs/IMPLEMENTATION_STATUS.md` continuously.

### Before coding

1. Read the complete master spec.
2. Inspect the entire existing repository.
3. Inventory current code, assets, tests, workflows, and unfinished systems.
4. Produce/update a dependency graph.
5. Produce/update an implementation plan ordered by campaign-critical path.
6. Identify any conflicts between existing implementation and the master spec.
7. Preserve good working code; do not rewrite systems merely for style.

### Priority order

1. bootable engine;
2. input;
3. stable movement/physics;
4. renderer + six quality tiers;
5. sector loading;
6. first complete playable vertical slice;
7. mission/dialogue systems;
8. first-use contextual tutorial system;
9. cinematic sequence/cutscene framework;
10. entire campaign greybox;
11. full NPC/machine AI;
12. authored environments;
13. audio/dialogue voice pipeline;
14. mobile-first control/HUD polish;
15. art/material polish;
16. all endings;
17. full test suite;
18. performance tuning;
19. release polish.

### Narrative rules

Do not replace the story.

Do not introduce:
- chosen-one mythology;
- supernatural crystals;
- evil sentient AI;
- generic apocalypse;
- evil-corporation monologues;
- surprise mastermind;
- generic “factions fighting over technology.”

Implement the Morrow Quay infrastructure-disaster story.

Maintain the character voice rules for Mara, Sera, Ivo, and Dax.

Dialogue must sound authored.

No runtime generative NPC dialogue.

If new lines are needed:
- write them in the established voice;
- keep them specific;
- avoid exposition;
- read surrounding scene context;
- reject trailer-speak.

### UI rules

No generic AI dashboard design.

No excessive glassmorphism.

No neon gradient theme.

Build a practical coastal-municipal visual system with readable typography, physical signage influence, restrained animation, and excellent mobile usability.

Tutorials must be contextual first-use teaching. Do not front-load a controls manual. Show the correct prompt for the active input family and, on touch devices, highlight the actual control. Persist completed tutorial IDs and provide reset/replay from settings.

### Art rules

Three.js is the renderer, not the art style.

Use high-quality legally compatible assets, normalize them, optimize them, and create coherent materials/lighting.

Do not leave primitive placeholders in final campaign spaces.

Maintain `ASSET_LICENSES.md`.

### Cinematics / NPC interaction

Implement a real authored sequence system for major story encounters: camera beats, actor marks, AnimationMixer clips, gaze/look-at, dialogue/audio/subtitle cues, object interactions, fades/letterbox only when justified, skip/hold-to-skip, clean cancellation, and seamless restoration of player control. Normal conversations should usually remain in-world; full cinematics are reserved for important beats. Never imitate a proprietary game shot-for-shot. Aim for the polish and readability of modern third-person narrative games using original staging.

### Mobile controls

Touch is a required completion path. The complete campaign, including dialogue choices, combat/tool encounters, menus, saves, tutorials, and endings, must be completable without keyboard/controller. Implement a customizable mobile control editor and context-aware HUD as defined in the master spec.

### Physics

Use Rapier fixed timestep.

Use a game-feel-oriented kinematic player controller.

Rendering and physics remain decoupled.

### Graphics

Implement all six presets:
1. Potato
2. Low
3. Medium
4. High
5. Ultra
6. Cinematic

Each preset must materially change workload.

Implement adaptive runtime scaling with hysteresis.

Use WebGPURenderer/TSL where stable and WebGL2 compatibility fallback.

### Testing loop

For every significant change:

1. typecheck;
2. unit test;
3. production build;
4. launch the game in the sandbox;
5. use browser automation to exercise the changed path;
6. inspect console;
7. inspect network errors;
8. capture screenshots when visual;
9. test a mobile viewport when UI/rendering/input changed;
10. fix failures;
11. rerun.

Do not mark the task complete merely because code compiles.

Do not disable tests to get green CI.

Do not reduce assertion quality.

### Browser validation

The sandbox has browser automation.

Use it.

Verify:
- title screen;
- new game;
- prologue;
- settings;
- graphics selection;
- mobile HUD;
- touch-only prologue;
- first-use tutorial triggers and persistence;
- major cutscene start/skip/return-to-gameplay;
- save/continue;
- act checkpoint boot;
- final ending flow.

### Commit behavior

Create coherent commits frequently.

Do not accumulate the whole game into one commit.

Suggested commit scale:
one subsystem or one campaign milestone.

Update status after major commits.

Push/update the active GitHub branch/PR after each validated coherent milestone where the environment permits. Do not hold many completed milestones locally waiting for a giant final push.

The GitHub history should visibly show progressive construction of the game. Each pushed milestone should update `docs/IMPLEMENTATION_STATUS.md`; successful playable milestones should allow the Pages workflow to publish a current Android-testable build.

If a long Cloud Session still has time after a milestone passes, immediately select the next highest-priority campaign-critical incomplete task and continue. Scheduled automation runs should resume from repository state and the implementation-status file. There is no “done for today” state while release-critical work remains and execution capacity is available.

### GitHub Pages

Maintain a working GitHub Pages deployment for the active playtest branch.

Pages deployment must only occur after:
- typecheck;
- critical tests;
- build;
- asset validation.

Ensure Vite base URL is correct.

A user on Android should be able to open the latest successful playtest build without a local computer.

### Audio

Use build-time TTS generation through the project’s speech adapter.

Edge TTS may be used for development generation as requested.

Keep voice generation replaceable.

Generate subtitles and validate timings.

Do not require internet TTS during normal gameplay.

### Performance

Measure, do not guess.

Track:
- FPS;
- frame times;
- draw calls;
- triangles;
- loaded sectors;
- physics bodies;
- AI count;
- renderer backend.

Build a benchmark route.

Tune Potato before declaring Ultra impressive.

### Completion

Before saying “finished”:

1. play/automate the complete critical campaign path;
2. validate all act checkpoints;
3. validate all three endings;
4. verify tutorial progression from fresh save and after reset;
5. verify all major cinematics including skip paths and player-control restoration;
6. verify a touch-only campaign-critical route;
7. run full CI;
8. run asset audit;
9. run screenshot matrix;
10. run performance benchmark;
11. score the game using the 1000-point benchmark in the master spec;
12. list every score with evidence;
13. if below 900, continue working on the largest deficits.

The word “complete” is reserved for a build that crosses the release threshold and has no campaign-blocking bugs.

---

# 47. Suggested Kiro Automation Prompts

## Hourly Progress Automation

> Read `ULTIMATE_KIRO_GAME_MASTER_SPEC_AND_BENCHMARK_PROMPT.md` and `docs/IMPLEMENTATION_STATUS.md`. Inspect the latest repository state and open work. Select the highest-impact incomplete campaign-critical task that fits one autonomous run. Implement it without redesigning stable unrelated systems. Run typecheck, relevant tests, production build, browser validation, console inspection, and mobile viewport validation where relevant. Update tests and `docs/IMPLEMENTATION_STATUS.md`. Open a focused PR with evidence. If the chosen task is blocked, fix the blocker instead. Never generate filler features. Never weaken tests.

## Regression Automation

> Inspect changes merged or added since the previous run. Run campaign smoke checkpoints, browser boot tests, save/load tests, graphics preset tests, asset validation, and console-error checks. Fix concrete regressions and open a focused PR. Do not refactor working code without evidence.

## Performance Automation

> Run the TIDELOCK benchmark suite across available renderer/quality configurations. Compare against previous stored benchmark results. Investigate meaningful regressions in frame time, draw calls, loaded assets, physics load, or AI load. Make conservative optimizations that preserve visuals and gameplay, verify them, update benchmark evidence, and open a focused PR.

## Narrative QA Automation

> Validate every implemented campaign scene against the narrative/dialogue rules in the master spec. Find placeholder dialogue, duplicate character voice, exposition dumps, broken subtitle/audio IDs, unreachable branches, missing objective transitions, and contradictions in the 37-minute timeline. Fix only clear issues and add tests/data validation. Do not rewrite strong dialogue merely to vary wording.

---

# 48. Release Deliverables

A release candidate must include:

- playable GitHub Pages URL;
- repository README;
- installation/build docs;
- controls;
- screenshots;
- performance notes;
- known limitations;
- asset licenses;
- open-source license;
- credits;
- save migration info;
- benchmark results;
- Android playtest instructions;
- desktop browser instructions;
- PWA instructions.

Optional later:
- Android APK/AAB;
- Tauri desktop packages.

---

# 49. README Quality Standard

README top:

1. title/logo;
2. one-sentence description;
3. gameplay screenshot/video;
4. “Play Now”;
5. feature list;
6. controls;
7. graphics tiers;
8. tech stack;
9. build;
10. architecture;
11. contributing;
12. licenses.

Avoid:
- giant wall of badges;
- marketing nonsense;
- claiming “AAA”;
- claiming “photorealistic” without proof.

Better:
> A complete open-source Three.js narrative game built to scale from mobile WebGL2 to desktop WebGPU.

---

# 50. Research-Backed Technical Decisions

These decisions were selected from current official/project documentation as of August 2026.

## Three.js WebGPURenderer / TSL

Three.js documents WebGPURenderer as its next-generation renderer. It prefers WebGPU when supported and can fall back to a WebGL2 backend. TSL can compile shader logic for WGSL or GLSL backends. Three also warns WebGPURenderer remains experimental, so the project must maintain a compatibility path.

Reference:
- Three.js WebGPURenderer manual: https://threejs.org/manual/en/webgpurenderer
- Three.js WebGPURenderer docs: https://threejs.org/docs/pages/WebGPURenderer.html

## WebGPU support

WebGPU is powerful but is not universal across all widely used browsers, and requires a secure context. That is why the game cannot be WebGPU-only.

Reference:
- MDN WebGPU API: https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API

## Rapier

Rapier’s JavaScript bindings are WebAssembly-based. Rapier provides a kinematic character controller supporting obstacle stopping, sliding, slopes, steps, and moving-platform interaction. The `-compat` builds embed WASM into JS for broader bundler compatibility at the cost of larger package size.

References:
- https://rapier.rs/docs/user_guides/javascript/getting_started_js/
- https://rapier.rs/docs/user_guides/javascript/character_controller/
- https://www.npmjs.com/package/@dimforge/rapier3d-compat

## Recast/Detour

`recast-navigation-js` is a WebAssembly port of Recast/Detour and includes Three.js integration helpers.

Reference:
- https://github.com/isaac-mason/recast-navigation-js

## glTF optimization

glTF Transform supports geometry compression with Draco/Meshopt and texture conversion/compression workflows including KTX2/Basis.

Reference:
- https://gltf-transform.dev/

## GPU classification

`@pmndrs/detect-gpu` can provide a useful starting classification, but its upstream benchmark dataset stopped receiving new GFXBench data after December 2025. Therefore it must be combined with our own runtime benchmark.

Reference:
- https://github.com/pmndrs/detect-gpu

## Performance diagnostics

`stats-gl` supports WebGL/WebGPU and can report real-time FPS plus CPU/GPU timing where available.

Reference:
- https://github.com/RenaudRohlinger/stats-gl

## Audio

Three’s audio stack uses the Web Audio API. `PositionalAudio` uses a `PannerNode` for 3D location/direction behavior.

References:
- https://threejs.org/docs/pages/PositionalAudio.html
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
- https://developer.mozilla.org/en-US/docs/Web/API/PannerNode

## Input

The Gamepad API is broadly available, while Pointer Lock is ideal for 3D mouse look but has some browser compatibility caveats and requires user activation.

References:
- https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API
- https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API

## PWA

`vite-plugin-pwa` integrates Workbox and supports generated or custom service-worker strategies.

Reference:
- https://vite-pwa-org.netlify.app/

## Capacitor

Capacitor can wrap an existing web application for Android/iOS and provides access to native APIs when needed.

Reference:
- https://capacitorjs.com/docs

## GitHub Pages

GitHub Pages supports deployment through custom GitHub Actions workflows using configure/upload/deploy Pages actions.

References:
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- https://docs.github.com/en/get-started/start-your-journey/deploying-your-website-automatically

## GitHub Actions runners

GitHub-hosted runners are available on Ubuntu, Windows, and macOS, and matrix strategies can test multiple operating systems.

References:
- https://docs.github.com/en/actions/concepts/runners/github-hosted-runners
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax

## Kiro cloud workflow

Kiro Web integrates with GitHub, runs work in isolated cloud sandboxes, supports autonomous sessions, and provides browser automation in the sandbox. Kiro Cloud Sessions can continue while the user disconnects. Kiro Web Automations can run recurring tasks on a schedule and open pull requests.

References:
- https://kiro.dev/docs/web/
- https://kiro.dev/docs/web/github/
- https://kiro.dev/docs/web/sandbox/
- https://kiro.dev/blog/cloud-sessions/
- https://kiro.dev/blog/introducing-automations/

## Assets

Poly Haven assets are CC0.

Adobe’s Mixamo FAQ states characters and animations can be used royalty-free in video games. Keep asset distribution/licensing records separate from the general code license.

References:
- https://polyhaven.com/license
- https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html

## Edge TTS

The `edge-tts` open-source Python project is an unofficial client that accesses Microsoft Edge’s online TTS service without needing Edge/Windows/API keys. Treat it as a replaceable build-time voice backend and verify service/voice terms before any commercial distribution.

Reference:
- https://github.com/rany2/edge-tts

---

# 51. Final Definition of Done

TIDELOCK is done only when:

- a new player can open the GitHub Pages build;
- start a game;
- learn controls;
- complete Prologue;
- complete Acts I–III;
- complete Finale;
- make one of three choices;
- see an epilogue;
- quit;
- return;
- continue a valid save;
- play on touch or desktop controls;
- change graphics from Potato through Cinematic;
- run through WebGL2 fallback;
- experience coherent audio and subtitles;
- encounter working NPC/machine behavior;
- understand the central 37-minute incident;
- never need a dev console to progress;
- never encounter a campaign-blocking placeholder;
- pass critical automated tests;
- deploy through GitHub Pages;
- score at least **900/1000** on the benchmark with evidence.

Until then, Kiro should say:

> “Playable milestone,” “alpha,” “beta,” or “release-candidate work remains.”

Not:

> “Finished.”

---

# 52. One-Sentence North Star

> **Build a small, authored, technically serious browser game that respects the player’s time, respects weak hardware, and never mistakes more generated content for more quality.**


---

# 53. Recommended `package.json` Script Contract

Kiro may adapt names if the repository already has strong conventions, but the following capabilities must exist.

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview --host 0.0.0.0",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "test:story": "playwright test tests/browser/story",
    "test:mobile": "playwright test tests/browser/mobile",
    "test:visual": "playwright test tests/visual",
    "test:saves": "vitest run tests/saves",
    "lint:assets": "tsx scripts/validate-assets.ts",
    "optimize:assets": "tsx scripts/optimize-assets.ts",
    "generate:dialogue": "python scripts/generate-dialogue.py",
    "benchmark": "tsx scripts/benchmark.ts",
    "verify": "pnpm typecheck && pnpm test && pnpm lint:assets && pnpm build",
    "ci": "pnpm verify && pnpm test:e2e"
  }
}
```

Do not make `build` secretly regenerate hundreds of TTS files on every CI run.

Generated speech should use:
- explicit generation command;
- cache;
- content hash;
- changed-lines-only regeneration.

---

# 54. GitHub Pages Workflow Skeleton

The exact action versions should be checked against current GitHub documentation when implemented.

Conceptual workflow:

```yaml
name: Pages

on:
  push:
    branches:
      - main
      - kiro/game-build
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v6

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm lint:assets
      - run: pnpm build

      - uses: actions/configure-pages@v5

      - uses: actions/upload-pages-artifact@v4
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}

    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Before copying versions blindly:
- verify current major versions;
- ensure repository Pages source is GitHub Actions;
- ensure Vite base path matches repository name.

## Vite Pages base rule

For project page:

```ts
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/REPOSITORY_NAME/' : '/',
})
```

A more robust implementation can derive the repository name from environment variables.

Do not hardcode a user account name.

---

# 55. CI Matrix Skeleton

```yaml
strategy:
  fail-fast: false
  matrix:
    os:
      - ubuntu-latest
      - windows-latest
      - macos-latest

runs-on: ${{ matrix.os }}
```

Cross-OS jobs should focus on:
- dependency install;
- typecheck;
- unit tests;
- production build;
- asset scripts that are expected to be cross-platform.

Heavy Playwright/game rendering tests may remain Ubuntu-centric unless a specific OS regression is being investigated.

Do not create a huge matrix merely to look impressive.

---

# 56. Graphics Preset Data Contract

Graphics quality must be data-driven.

Example conceptual structure:

```ts
export type QualityPresetName =
  | 'potato'
  | 'low'
  | 'medium'
  | 'high'
  | 'ultra'
  | 'cinematic';

export interface QualityPreset {
  renderScale: number;
  targetFps: 30 | 45 | 60 | 90 | 120;
  textureTier: 0 | 1 | 2 | 3 | 4;
  shadowTier: 0 | 1 | 2 | 3 | 4 | 5;
  shadowDistance: number;
  lodMultiplier: number;
  foliageDensity: number;
  particleMultiplier: number;
  decalMultiplier: number;
  maxDynamicLights: number;
  maxShadowLights: number;
  waterTier: number;
  reflectionTier: number;
  ao: boolean;
  bloom: boolean;
  atmosphereTier: number;
  aiFarUpdateHz: number;
  physicsFarDistance: number;
  audioEmitterBudget: number;
}
```

Rule:
Do not scatter quality checks across 80 files.

Centralize:
- preset;
- capability detection;
- runtime adaptive overrides.

Systems subscribe to quality changes.

---

# 57. Dynamic Scaler Contract

Pseudo logic:

```text
Every 2–3 seconds:
    collect stable frame-time window

If frame time exceeds target by meaningful threshold
for multiple windows:
    decrease one adaptive dimension

If frame time remains comfortably below target
for a longer recovery period:
    increase one adaptive dimension

Never change more than one large setting at once.
Never exceed selected preset ceiling.
Never reduce below preset minimum gameplay readability.
```

Priority when reducing:
1. render scale;
2. shadow distance;
3. particle density;
4. foliage distance;
5. secondary reflections/effects.

Priority when restoring:
reverse carefully.

Use hysteresis.

Example:
- downgrade after ~4–6 seconds of sustained deficit;
- upgrade after ~12–20 seconds of sustained headroom.

Tune empirically.

---

# 58. GPU Capability Selection

Startup sequence:

```text
1. identify mobile/desktop class
2. detect WebGPU availability
3. detect WebGL2 fallback
4. query available capabilities
5. run GPU classification helper
6. run a short real game-style benchmark
7. select initial preset
8. allow user override
9. store override
```

Do not rely solely on user-agent strings.

Do not rely solely on `@pmndrs/detect-gpu`.

If benchmark classification and runtime performance disagree:
runtime performance wins.

---

# 59. Loading Strategy

## First launch

Goal:
reach title screen quickly.

Load initially:
- shell;
- UI;
- minimum renderer;
- settings;
- menu background;
- font;
- minimum audio unlock logic.

Do not load the entire campaign before showing menu.

## New game

Load:
- player;
- depot;
- shared character assets;
- prologue dialogue;
- common audio.

## Sector transition

Show loading only if required.

Prefer:
- background preload;
- doorway/bridge traversal masking;
- elevator/service corridor;
- narrative transition.

Avoid fake 30-second loading animations when the game is already ready.

---

# 60. Asset Budget Manifest

Every major asset may optionally be listed in a machine-readable manifest.

Example:

```json
{
  "pump_station_12": {
    "type": "sector",
    "maxCompressedBytes": 28000000,
    "maxResidentTextures": 70,
    "maxHeroTextureSize": 2048,
    "maxTrianglesHigh": 650000,
    "lodRequired": true
  }
}
```

These are examples and should be tuned.

The important point:
asset budgets must be measurable.

---

# 61. Story Scene Beat Sheet

This section gives Kiro a more precise pacing map.

## P0 — Depot calibration
Duration: 4–6 min

Player does:
- movement;
- camera;
- one interaction;
- walk past clinic;
- see Ivo working.

Dialogue:
incidental, practical.

Story question introduced:
Why is Mara being asked to verify “current” maps?

## P1 — Service bridge
Duration: 4–6 min

Player sees:
- district scale;
- flood gate in distance;
- patrol machine route.

Sera gives first task.

Do not play dramatic music.

## A1-1 — Residential approach
Duration: 8–10 min

Player learns:
- water routes;
- scan;
- avoidance.

Environmental story:
evacuation was rushed but organized.

## A1-2 — Optional survivor detour
Duration: 5–7 min

Humanizes stakes.

Reward:
- information;
- later clinic stability;
- small mechanical benefit.

## A1-3 — Pump Station 12
Duration: 12–15 min

First infrastructure puzzle.

End:
two priority tables.

## A1-4 — Audit gap discovery
Duration: 4–6 min

Dax contact.

Do not stop player for cutscene.

## A2-1 — Commercial underpass
Duration: 10–12 min

Player has multiple route options:
- exposed fast;
- maintenance route slower/safer.

## A2-2 — Dax physical meeting
Duration: 6–8 min

Dax should be doing something when encountered.

He is not standing in center of room waiting.

## A2-3 — Relay Annex
Duration: 15–20 min

Power puzzle + patrol escalation.

Player learns the Annex carried emergency dispatch.

This complicates the simplistic corruption theory.

## A2-4 — Partial audit
Duration: 5–7 min

Sera becomes more guarded.

No confession.

## A3-1 — Elevated rail
Duration: 10–12 min

Strong environmental traversal.

Let music breathe.

## A3-2 — Operations Archive
Duration: 12–15 min

Player reconstructs timeline actively.

Do not present 37-minute timeline as one text wall.

Require:
- two or three physical/archive interactions.

## A3-3 — Maintenance tunnel
Duration: 10–12 min

World state changes.

Water level or power state creates new route.

## A3-4 — Sera confrontation
Duration: 7–10 min

Keep lines restrained.

Player must be able to move/look during most of it.

## F1 — Gate approach
Duration: 8–10 min

Mechanical tension.

## F2 — Gate control
Duration: 12–18 min

Final integrated challenge.

## F3 — Choice
Duration: 3–5 min

No giant wheel labelled:
GOOD / BAD / NEUTRAL.

Present decision in-world.

## E — Depot
Duration: 5–10 min

Consequences.

End quietly.

---

# 62. NPC Voice Sheets

## Mara

Sentence shape:
- short;
- direct;
- occasional dry correction.

Avoid:
- inspirational speeches;
- explaining her trauma;
- constant sarcasm.

When emotional:
she gets quieter and more specific.

## Sera

Sentence shape:
- precise;
- clauses;
- system identifiers only when the player can understand context.

Avoid:
- villainous calm;
- “for the greater good.”

When emotional:
she stops using institutional “we” and starts using “I.”

## Ivo

Sentence shape:
- conversational;
- human-scale;
- occasional low-energy humor.

Avoid:
- saintly doctor voice;
- constant jokes.

When emotional:
he focuses on tasks.

## Dax

Sentence shape:
- questions;
- quoted claims;
- names/dates.

Avoid:
- rebel-leader speeches;
- conspiracy slang.

When emotional:
he interrupts and speaks too quickly, then catches himself.

---

# 63. Dialogue Quality Benchmark

Every major conversation is scored 0–2 on each:

1. Could another NPC say the same lines unchanged?
2. Is information repeated from environment/UI?
3. Does someone want something during the scene?
4. Is there subtext?
5. Are line lengths varied?
6. Are there interruptions or natural transitions?
7. Is there at least one specific concrete detail?
8. Does the scene change player understanding?
9. Does it avoid obvious trailer phrases?
10. Does the scene end before it exhausts its point?

Scoring:
- 2 = excellent;
- 1 = acceptable;
- 0 = fail.

Major scenes should average **≥17/20**.

If a scene scores below 15:
rewrite it.

---

# 64. NPC Staging Rules

During conversation:
- face player naturally, not perfectly locked;
- allow gaze shifts;
- hands/idle animation;
- contextual work;
- body orientation;
- distance appropriate to space.

Radio dialogue:
do not freeze gameplay.

In-person major dialogue:
avoid static shot/reverse-shot unless intentionally staged.

Cinematic camera use:
limited and earned.

Prefer gameplay camera.

---

# 65. Machine AI Benchmark Scenarios

Create deterministic dev scenarios.

## Scenario A — Vision

Player crosses vision cone.

Expected:
- Suspicious;
- inspect;
- alert only after threshold.

## Scenario B — Occlusion

Player behind opaque wall.

Expected:
- no direct vision detection.

## Scenario C — Sound

Noise event behind machine.

Expected:
- investigate sound position;
- not know exact player position automatically.

## Scenario D — Lost target

Machine sees player, player breaks line of sight.

Expected:
- last-known position;
- search;
- eventually de-escalate.

## Scenario E — Multiple machines

One becomes alert.

Expected:
- bounded alert propagation;
- no map-wide hive mind.

## Scenario F — Save/reload

Reload during patrol/search.

Expected:
- valid safe state;
- no null nav agent;
- no duplicated entity.

---

# 66. Player Controller Benchmark

Automated/manual checks:

- flat ground;
- 15° slope;
- authored max climb slope;
- stairs;
- descending steps;
- narrow doorway;
- moving platform if present;
- edge;
- jump landing;
- crouch under obstacle;
- stand-up blocked by ceiling;
- shallow water;
- frame rate 30;
- frame rate 60;
- frame spikes;
- save/reload while grounded.

Failure conditions:
- vibrating;
- tunneling;
- random launch;
- stair snagging;
- camera entering head/body;
- different movement speed with FPS.

---

# 67. Camera Quality Rules

Camera:
- collision avoidance;
- smooth but responsive;
- no wall clipping;
- no excessive lag;
- shoulder offset;
- indoor tightening;
- sensitivity separate by device.

Do not:
- add cinematic sway to normal movement;
- shake camera for every interaction;
- force motion blur.

Provide:
- shake amount;
- sensitivity;
- invert;
- FOV where supported.

---

# 68. Water System

Water is visually central.

Requirements:
- readable depth;
- motion;
- reflection approximation appropriate to quality tier;
- normal detail;
- shoreline/wet transition;
- fog/absorption cue;
- optimized fallback.

Potato:
simple surface shader.

Cinematic:
best stable water path.

Gameplay water state must not depend on render shader.

Water height/state belongs to gameplay/world simulation.

---

# 69. Rain & Wetness

Rain:
- world/weather state;
- particle or GPU-friendly system;
- audio;
- surface response.

Wetness:
- material parameter;
- darkened base color carefully;
- reduced roughness where appropriate;
- puddle/decals selectively.

Do not make every surface a mirror.

---

# 70. Lighting Quality Gate

For each major scene capture:
- Potato;
- Medium;
- High;
- Cinematic.

Review:
- player/NPC readable;
- objective route readable;
- materials not flat;
- highlights controlled;
- black levels not crushed;
- no overexposure;
- fog not hiding gameplay;
- emergency lights visually meaningful.

---

# 71. PWA Cache Safety

Large game assets require deliberate caching.

Rules:
- version asset manifests;
- never serve HTML from a stale version that references deleted hashed chunks;
- clean obsolete caches;
- offer refresh when incompatible new version exists;
- do not silently refresh during critical gameplay;
- store saves separately from cache;
- test offline after first successful asset fetch.

If an update is available mid-session:
show a non-blocking notice and apply after returning to title where possible.

---

# 72. Save Corruption Recovery

On load:
1. parse;
2. validate with Zod;
3. migrate;
4. verify checkpoint references;
5. load.

If invalid:
- preserve original backup;
- offer previous autosave;
- never overwrite the only save immediately.

Developer logs should identify migration issue.

---

# 73. Audio Generation Manifest

Example:

```json
{
  "id": "sera_act1_014",
  "speaker": "sera",
  "text": "Which revision?",
  "voice": "configured-voice-id",
  "rate": "+0%",
  "sourceHash": "sha256...",
  "audio": "audio/dialogue/sera_act1_014.ogg",
  "subtitle": "audio/dialogue/sera_act1_014.vtt"
}
```

Regenerate only when:
- text changes;
- voice settings change;
- tool version changes intentionally.

Keep voice files deterministic in naming.

---

# 74. Audio Polish Pass

After synthesis:
- trim excessive start/end silence;
- normalize dialogue consistently;
- prevent clipping;
- convert to efficient web format;
- preserve enough quality for intelligibility;
- test through phone speakers;
- test through headphones.

Do not over-compress voices until metallic.

---

# 75. Localization Readiness

Even if release language is initially English:

Store text outside code.

Support:
- stable message IDs;
- locale bundles;
- subtitle line breaking;
- UI expansion;
- future voice mapping.

Do not bake English text into textures except authored environmental art.

---

# 76. Story State Flags

Examples:

```text
rescued_resident_act1
clinic_power_stabilized
dax_trust_high
sera_optional_context_heard
found_priority_policy
found_manual_valve_log
ending_choice
```

Do not create hundreds of meaningless booleans.

Every flag must:
- affect story;
- affect world;
- affect optional dialogue;
- affect epilogue;
or support progression.

---

# 77. Cutscene Policy

Maximum fully non-interactive cutscene:
~60–90 seconds, preferably less.

Most story:
- in gameplay;
- radio;
- short staged interaction.

Never use a long cutscene to avoid implementing gameplay.

---

# 78. “No Fake Feature” Rule

A feature does not count if:
- menu toggle exists but does nothing;
- class exists but no campaign use;
- test only mocks the entire feature;
- AI state never activates;
- graphics preset sets same values;
- dialogue file never triggers;
- mobile controls appear but cannot finish prologue.

Benchmark evidence must prove runtime use.

---

# 79. Evidence-Based Completion Report

When Kiro claims release candidate, require a final report like:

```text
Campaign:
PASS — automated checkpoint route from New Game through ending B.
Manual review needed — final 2 optional conversations.

WebGL2:
PASS — forced compatibility boot and Act I smoke.

WebGPU:
PASS in available Chrome sandbox environment.
Hardware-specific validation still recommended.

Touch:
PASS — Playwright tablet viewport + Android human test requested.

Save:
PASS — schema v3, reload at all act checkpoints.

Graphics:
6/6 presets functional.

Benchmark:
Potato: ...
Medium: ...
High: ...

Known issues:
1. ...
2. ...
```

No vague:
“Everything should work.”

---

# 80. Final Human Android Playtest Checklist

The user does not need Windows.

From Android:

1. open GitHub Pages build;
2. clear old PWA cache once when requested;
3. start New Game;
4. verify touch controls;
5. play 10 minutes;
6. copy diagnostics;
7. report:
   - FPS feel;
   - heat;
   - stutter;
   - control comfort;
   - unreadable UI;
   - visual bugs;
   - audio balance.

Later:
- complete one full campaign run on Android before v1.0 if possible.

Human feedback should focus on feel Kiro cannot infer perfectly:
- camera;
- touch ergonomics;
- pacing;
- dialogue naturalness;
- visual taste.

---

# 81. Kiro “Do Not Stop Early” Footer

Append this paragraph to major Kiro implementation requests:

> Do not stop after producing code. Build it, run it, use the available browser automation to interact with it, inspect visual output and console/runtime failures, fix what you find, rerun tests, update the implementation-status file, and commit a coherent milestone. If the current milestone passes, continue to the next highest-priority incomplete campaign-critical milestone while the session remains active. Do not spend remaining time creating filler, rewrites, speculative architecture, or documentation for systems that do not work.

---

# 82. Final Anti-Slop Review

Before release, perform a dedicated review asking:

## Story
- Is there any plot twist that exists only to shock?
- Is anyone obviously evil just to simplify the ending?
- Does the game lecture the theme?
- Does the player learn through action?
- Is the 37-minute incident genuinely understandable?

## Dialogue
- Can I identify the speaker without the name label?
- Does anyone sound like a chatbot?
- Are there too many balanced three-part sentences?
- Are characters explaining things they both know?
- Are emotional scenes specific rather than poetic?

## Art
- Does every asset look like it belongs in Morrow Quay?
- Are scale/material inconsistencies visible?
- Is there generic neon?
- Is bloom hiding bad lighting?
- Does Potato still look intentional?

## UI
- Does it look like a game, not an admin dashboard?
- Are there unnecessary cards?
- Are buttons over-rounded by default?
- Is information hierarchy obvious?
- Is mobile readable?

## Gameplay
- Does each act introduce or remix something?
- Is there padding?
- Is machine behavior readable?
- Are puzzles grounded in the environment?
- Does movement feel stable?

Anything failing this review gets fixed or cut.

---

# 83. Final Instruction to the Implementing Agent

The highest-value output is not the largest repository.

The highest-value output is:

- a player presses **New Game**;
- two to three hours later they reach an ending;
- nothing important feels placeholder;
- dialogue sounds like people;
- the world feels designed;
- weak hardware is respected;
- high hardware gets meaningful visual upgrades;
- the GitHub repository is clean enough that another developer can understand how it works.

That is the benchmark.


---

# 84. Cinematic Sequence System — Required, Not Cosmetic

TIDELOCK needs a real sequence layer for important NPC interactions and story beats. It must not be a collection of hard-coded `setTimeout()` calls.

## 84.1 Design goal

The target is the *clarity, staging discipline, and seamless gameplay transition* associated with polished modern third-person story games, while keeping TIDELOCK's cinematography original and appropriately scoped.

Do not copy proprietary scenes, camera paths, dialogue, animation, UI, or exact interaction systems from another game.

Use three conversation presentation tiers:

### Tier A — Ambient / gameplay conversation

Use for:
- radio chatter;
- incidental residents;
- comments while walking;
- short optional exchanges;
- objective updates.

Rules:
- player normally keeps control;
- no letterbox;
- camera remains gameplay camera;
- subtitles/audio continue naturally;
- NPC keeps performing plausible work where appropriate.

### Tier B — Focused in-world interaction

Use for:
- mission briefing;
- meaningful NPC choice;
- personal conversation;
- handing over an object;
- inspection of evidence.

Rules:
- player movement may be limited/soft-locked;
- camera can reframe but should remain spatially believable;
- actors use authored marks/poses;
- look-at and gesture animation supported;
- the scene should usually remain physically inside the world rather than teleporting actors to a dialogue room.

### Tier C — Full cinematic sequence

Use sparingly for:
- opening hook;
- major act transition;
- a pivotal discovery;
- serious character confrontation;
- final control-room decision;
- ending/epilogue.

Rules:
- authored camera sequence;
- actor choreography;
- synchronized animation/dialogue/SFX/music/world events;
- optional letterbox only if it improves composition;
- fully skippable after required initialization safety;
- returns to valid gameplay state.

Target roughly **10–15 meaningful cinematic/focused sequences** across the full campaign, not dozens of interruptions.

## 84.2 Sequence architecture

Create a data-driven `SequenceSystem` with a timeline/track model.

Supported track/event types should include where useful:

- camera cut;
- camera blend;
- camera spline/rail;
- camera look target;
- actor move-to mark;
- actor turn-to target;
- actor animation clip;
- actor upper-body gesture;
- actor look-at/gaze target;
- dialogue line;
- subtitle cue;
- facial/head-look approximation supported by the rig;
- prop attach/detach;
- object interaction;
- door/gate/world-state event;
- SFX cue;
- music cue/ducking;
- ambience cue;
- light/weather cue;
- objective/flag event;
- fade;
- letterbox transition;
- player-control lock/unlock;
- choice prompt;
- checkpoint/autosave cue.

Do not make every sequence require every track.

Example conceptual data:

```ts
interface SequenceDefinition {
  id: string;
  mode: 'ambient' | 'focused' | 'cinematic';
  skippable: boolean;
  resumePolicy: 'exact' | 'checkpoint' | 'safe-end';
  tracks: SequenceTrack[];
  onStart?: SequenceEvent[];
  onComplete?: SequenceEvent[];
  onSkip?: SequenceEvent[];
}
```

Keep story facts/mission state authoritative outside of camera code.

## 84.3 Camera rules

Cinematic camera system needs:
- authored transforms/targets;
- damped blends;
- spline/rail movement when actually helpful;
- obstruction checks for important frames;
- safe fallback camera if target actor is missing;
- aspect-ratio-aware composition;
- mobile-safe subtitle framing;
- configurable shake intensity respecting accessibility settings.

Avoid:
- constant Dutch angles;
- random camera orbit;
- excessive depth-of-field that hides interaction;
- hard cuts every two seconds;
- fake handheld shake everywhere;
- cinematic black bars on every normal conversation.

## 84.4 Actor performance

NPCs in major scenes must not stand perfectly still.

Use:
- locomotion to staging marks;
- weight-shift/idle clips;
- contextual gestures;
- head/gaze targets;
- object interaction;
- interruption timing;
- animation cross-fades;
- short reaction beats.

Do not promise advanced lip-sync if the rigs/assets cannot support it convincingly. Better believable body/head staging plus clean audio/subtitles than broken mouth animation.

If viable, implement lightweight phoneme/viseme support as optional polish, never as a blocker for campaign completion.

## 84.5 Skip behavior

A skipped cutscene must not break the game.

On skip:
- apply all required authoritative story/world flags;
- place actors/props at valid end states;
- cancel pending audio cleanly;
- restore camera;
- restore input;
- restore HUD context;
- set objective state;
- perform checkpoint/autosave where expected.

Hold-to-skip is preferred for major cinematics to prevent accidental skipping on touch.

Previously watched major cinematics may optionally expose faster skip behavior.

## 84.6 Failure recovery

If a sequence actor or animation is missing:
- log a clear developer error;
- use safe fallback staging if possible;
- never leave player input permanently disabled;
- never leave camera stuck on an invalid target.

Add a developer command/menu to jump to each major sequence.

---

# 85. Authored Campaign Cinematic Plan

Exact writing/staging may evolve, but the campaign must have deliberate presentation beats similar in production role to the following.

1. **Cold Open / Arrival** — establish the flooded district through action and environmental detail, not narration.
2. **First Mara Contact** — focused in-world briefing with practical tension, teaching conversation presentation without a lore dump.
3. **Station Twelve Discovery** — short cinematic reveal tied to evidence the player physically uncovered.
4. **First Sera In-Person Scene** — character-specific working-space interaction; Sera does something while speaking.
5. **Dax Rescue/Encounter** — gameplay transitions directly into focused staging; outcome changes later optional lines.
6. **Ivo Infrastructure Argument** — conflict built around a concrete operational decision, not “good vs evil.”
7. **Midpoint Reconstruction** — player sees how pieces of the 37-minute incident connect; visual evidence carries most exposition.
8. **Act II Consequence Scene** — one earlier player decision visibly changes staging/world state/dialogue.
9. **Mara/Sera Confrontation** — short, specific, interrupted by immediate operational pressure.
10. **Final Approach** — sparse radio/in-world dialogue while control stays with player.
11. **Control-Room Decision** — fully staged sequence with player agency and no villain monologue.
12. **Ending/Epilogue** — concise consequence sequence reflecting the actual ending flags.

These are **not twelve mandatory long movies**. Some should be 20–45 seconds; some may be interactive focused scenes. Preserve campaign pacing.

---

# 86. First-Use Contextual Tutorial System

The game must teach itself naturally.

Do not place a wall of controls on screen at New Game.
Do not assume the player read README controls.
Do not show tutorials for mechanics the player has not encountered.

## 86.1 Tutorial registry

Build a data-driven tutorial system.

Example:

```ts
interface TutorialDefinition {
  id: string;
  trigger: TutorialTrigger;
  completion: TutorialCompletion;
  inputAction?: GameAction;
  messageKey: string;
  priority: number;
  cooldown?: number;
  blocksOthers?: boolean;
  repeatPolicy: 'once' | 'until-success' | 'contextual';
}
```

Tutorial state is save-persistent.

## 86.2 Required tutorial coverage

Teach on first meaningful use:

- move;
- camera/look;
- interact/talk;
- sprint;
- crouch;
- jump/vault;
- contextual traversal;
- scan/tool;
- pick up/inspect evidence;
- inventory/tool selection if the campaign requires it;
- primary tool/combat action;
- aim/ADS if implemented;
- reload/recharge if implemented;
- damage/recovery/healing mechanic if applicable;
- machine detection/stealth cue;
- objective/journal access;
- dialogue choice;
- checkpoint/autosave meaning if player-facing explanation is needed;
- extraction/ending-specific interaction only when first encountered.

Do not tutorialize obvious menu buttons unless usability testing shows a need.

## 86.3 Trigger design

Good example:
- player reaches first waist-high obstacle;
- tutorial highlights Vault;
- tutorial completes when the player successfully vaults.

Bad example:
- five tutorial panels at spawn explaining vault, stealth, scanning, inventory, and combat before the player sees any of them.

Tutorials should prefer **successful action** as completion, not simply elapsed time.

## 86.4 Input-family rendering

Tutorial copy uses action names, not hard-coded key strings.

Renderer resolves them dynamically:

Desktop:
`Interact — E`

Controller:
render the correct active controller glyph/mapping.

Touch:
- pulse/highlight the actual `Interact` touch button;
- use a short label if useful;
- do not say “Press E”.

Switch prompt family when the user changes active input method.

## 86.5 Presentation

Tutorial UI:
- small;
- readable;
- visually integrated with TIDELOCK UI language;
- does not cover subtitles;
- does not cover critical touch controls;
- dismisses after successful learning;
- queues conflicts rather than stacking five messages.

For touch tutorials, use spotlight/highlight animation around the actual control.

For look/swipe, a short animated gesture hint may be used once.

## 86.6 Difficulty / assistance

If the player fails an interaction repeatedly, contextual assistance may escalate gently:

1. normal prompt;
2. stronger prompt/highlight;
3. optional hint.

Do not immediately solve puzzles for the player.

## 86.7 Settings

Settings → Gameplay / Tutorials:
- Tutorials On/Off;
- Reset Tutorials;
- optionally Reduced Tutorials for experienced players.

Resetting tutorials must not reset campaign progress.

## 86.8 Automated tutorial tests

Tests must prove:
- fresh save triggers expected first tutorial;
- tutorial does not trigger before context;
- successful action marks complete;
- completed tutorial does not spam again;
- reset causes it to appear again;
- save/reload preserves completion;
- active input family changes prompt presentation;
- touch highlight references a visible control;
- multiple simultaneous tutorial candidates obey priority/queue rules.

---

# 87. Contextual NPC Interaction Model

NPC interaction should feel authored and spatial rather than like clicking a chatbot.

## 87.1 Interaction states

NPCs may expose:
- Talk;
- Ask/Continue;
- Give/Receive item;
- Inspect together;
- mission-specific contextual action;
- short optional follow-up after a major event.

Do not implement infinite generated conversation.

## 87.2 Approach behavior

For important NPCs:
- detect player approach;
- glance/turn if appropriate;
- continue current work until interaction begins;
- use a concise contextual prompt;
- move into focused staging only when the interaction deserves it.

Do not have every NPC snap 180° and stare directly at the player.

## 87.3 Post-event reactions

Major characters should receive bounded new lines after relevant events.

Examples:
- an earlier resident rescue;
- station power outcome;
- evidence found;
- disagreement choice;
- approaching final operation.

This creates reactivity without enormous branching trees.

## 87.4 Ambient speech

Ambient lines:
- low frequency;
- contextual;
- interruptible;
- not repeated constantly;
- never carry critical progression information exclusively.

Critical story information needs a reliable replay/log or objective-safe path.

---

# 88. Mobile Completion Contract

Mobile is not merely “supported.” It is one of the main release targets.

Before TIDELOCK can pass release benchmark:

- New Game works from touch;
- every required movement mechanic works with touch;
- all NPC conversations/choices work with touch;
- all puzzles can be completed with touch;
- all required machine encounters can be completed with touch;
- pause/settings/save flows work with touch;
- all major cinematics can be skipped/paused according to policy with touch;
- tutorial system uses touch-native instructions;
- mobile controls can be customized/reset;
- ending selection and credits can be completed with touch.

## 88.1 Touch ergonomics evidence

Automated tests cannot prove comfort.

The developer build must expose:
- touch hitbox debug overlay;
- safe-area bounds;
- active touch pointer visualization;
- current action-map values;
- current HUD context.

Human Android feedback should be treated as a release-blocking source when it identifies:
- unreachable buttons;
- camera/movement conflicts;
- excessive thumb travel;
- accidental presses;
- unreadable subtitles;
- poor sensitivity defaults.

## 88.2 Optional gyro

Gyro aiming/look assistance is optional, not core.

Only enable if:
- permission UX is correct;
- it behaves consistently;
- it is disabled by default unless user chooses it;
- calibration/recentering exists if necessary.

Do not spend campaign-critical time chasing unstable gyro behavior.

---

# 89. Continuous Kiro → GitHub → Pages Execution Loop

The project must be structured so work survives individual agent sessions.

The loop is:

```text
READ MASTER SPEC
      ↓
READ IMPLEMENTATION_STATUS
      ↓
SELECT HIGHEST-PRIORITY INCOMPLETE RELEASE TASK
      ↓
IMPLEMENT SMALL COHERENT MILESTONE
      ↓
TYPECHECK + TEST + BUILD
      ↓
BROWSER PLAY/INSPECT + MOBILE VIEWPORT
      ↓
FIX FAILURES
      ↓
UPDATE STATUS + TEST EVIDENCE
      ↓
COMMIT + PUSH/PR
      ↓
GITHUB ACTIONS
      ↓
PAGES PLAYTEST BUILD
      ↓
NEXT MILESTONE
```

## 89.1 Periodic progress rule — sandbox-safe persistence

Do not make “periodic” mean arbitrary tiny commits every few minutes, but **do not leave completed major work unpushed**. The maximum normal unpushed scope is one currently active coherent milestone.

**Before Kiro selects or begins the next major milestone, the previous completed milestone must already be committed, pushed, and remotely verified.** If the push has not succeeded, the loop is blocked at the persistence gate.

Push after **validated coherent milestones** such as:
- engine boot;
- player controller;
- prologue tutorial path;
- one story scene;
- one complete mission chain;
- one sector art pass;
- one performance optimization batch;
- one test-suite expansion.

The repository should always make it obvious what actually works.

## 89.2 Long Cloud Session behavior

While a Cloud Session remains able to execute:

1. finish the current milestone;
2. validate it with the relevant typecheck/tests/build/runtime or browser checks;
3. update implementation status and evidence;
4. commit the milestone;
5. **push it immediately to the remote branch**;
6. **verify the remote push succeeded**;
7. only then select and begin the next campaign-critical milestone.

Never depend on the current sandbox surviving long enough for a later batch push.

Do not stop simply to produce a progress essay.

## 89.3 Scheduled automation behavior

Independent scheduled runs begin by reading repository truth.

They must not assume memory from a previous agent run.

Required source of truth:
- master spec;
- implementation status;
- open issues/PRs;
- tests;
- benchmark history;
- campaign checklist.

Scheduled runs should keep improving the project while configured execution capacity/credits remain, but must respect actual Kiro/GitHub platform scheduling and quota limits. Never claim an infinite process independent of those services.

## 89.4 Pages behavior

A successful validated push on the configured playtest branch should trigger the Pages pipeline.

Do not publish red builds.

Each published build should expose in a developer/about screen:
- commit SHA;
- build timestamp;
- app version;
- renderer backend;
- save schema version.

This allows Android bug reports to identify the exact build.

## 89.5 Git discipline

Never:
- force-push away useful history without reason;
- commit secrets/tokens;
- commit huge raw restricted assets;
- generate thousands of meaningless formatting changes;
- use “fix stuff” for every commit message;
- merge a broken campaign branch only to make progress look active.

Prefer conventional, descriptive commits.

---

# 90. New Release Gates Added by Sections 84–89

The build automatically fails the final quality claim if any of these are true:

## Cinematics

- no reusable sequence system;
- important scene is only a static dialogue box when staging was required;
- skipping a cutscene breaks progression;
- player control remains locked after a sequence;
- audio continues from a skipped scene incorrectly;
- major actors T-pose or teleport visibly during authored sequences;
- mobile aspect ratio makes key scene framing/subtitles unusable.

## Tutorials

- all controls shown at startup;
- first-use tutorials fire outside relevant context;
- tutorial completion does not persist;
- tutorials cannot be reset;
- touch players receive keyboard-only instructions;
- tutorial overlay blocks required touch controls/subtitles;
- tutorial spam repeats every encounter.

## Mobile

- prologue cannot be completed touch-only;
- move + look cannot work simultaneously;
- contextual action becomes inaccessible in a common layout;
- controls are not safe-area aware;
- user control customization does not persist;
- dialogue/ending choices require mouse hover/keyboard.

## Continuous delivery

- large amounts of validated work remain unpushed without reason;
- implementation status is stale enough to mislead the next autonomous run;
- Pages regularly deploys builds that fail critical smoke tests;
- release claim cannot be tied to a commit SHA and benchmark evidence.

These gates are part of the **1000-point benchmark intent** even if the numeric weighting remains unchanged. A failure in a campaign-critical gate can block release regardless of raw score.
