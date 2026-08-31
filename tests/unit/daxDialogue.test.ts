/**
 * Guards the one shipped scene that introduces Dax Ren.
 *
 * `tests/unit/contentSchemas.test.ts` proves the schema and the authoring
 * linter work, but it does so against inline fixtures — no test in the repo
 * reads `content/dialogue/**` at all, so a shipped scene can currently rot
 * (dangling pointer, unreachable branch, banned phrase, a speaker dropped from
 * `participants`) without anything failing. This file closes that gap for
 * `act1_perimeter_contact`, and asserts the authoring intent that a schema
 * cannot express: that the interrupts and the branch are load-bearing rather
 * than decorative, and that the minor cast actually speaks.
 *
 * It deliberately does not assert exact line counts per speaker — that would
 * make every polish edit a test edit. It asserts the properties that would
 * make the scene wrong if they stopped holding.
 */

import { describe, expect, it } from 'vitest';

import sceneRaw from '../../content/dialogue/act1_perimeter_contact.json';
import {
  MAX_SPOKEN_WORDS_PER_NODE,
  countSpokenWords,
  findBannedPhrases,
  findPlaceholderMarkers,
  parseDialogueScene,
  validateDialogueScene,
  type DialogueNode,
} from '../../src/game/dialogue/dialogueSchema';

const scene = parseDialogueScene(sceneRaw);
const byId = new Map<string, DialogueNode>(scene.nodes.map((node) => [node.id, node]));

describe('act1_perimeter_contact — structure', () => {
  it('parses and lints with zero errors and zero warnings', () => {
    const result = validateDialogueScene(scene);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is filed under Act I, where Dax makes contact', () => {
    // narrative.md puts first contact at the end of Act I, not the prologue.
    expect(scene.act).toBe('act1');
    expect(scene.tier).toBe('focused');
    expect(scene.once).toBe(true);
    expect(scene.skippable).toBe(true);
  });

  it('gates on the prologue actually having happened', () => {
    // Mara cannot meet Dax inside the seal before she crosses into it, and the
    // scene's closing beat needs the pulse tool she is issued at the depot.
    expect(scene.availableWhen).toEqual({
      kind: 'and',
      all: [
        { kind: 'flagSet', flag: 'crossed_service_bridge' },
        { kind: 'flagSet', flag: 'pulse_tool_issued' },
      ],
    });
  });

  it('runs 22-30 nodes with a length every node can be timed against', () => {
    expect(scene.nodes.length).toBeGreaterThanOrEqual(22);
    expect(scene.nodes.length).toBeLessThanOrEqual(30);
    for (const node of scene.nodes) {
      expect(node.duration, node.id).toBeDefined();
    }
  });
});

describe('act1_perimeter_contact — cast', () => {
  it('gives every listed participant lines', () => {
    const speakers = new Set(scene.nodes.map((node) => node.speaker));
    for (const participant of scene.participants) {
      expect(speakers.has(participant), `${participant} is listed but silent`).toBe(true);
    }
  });

  it('lets both minor NPCs speak more than once', () => {
    // Spec 4.5: minor NPCs get 2-8 lines each, not one anonymous exposition drop.
    for (const minor of ['noor', 'renna'] as const) {
      const lines = scene.nodes.filter((node) => node.speaker === minor);
      expect(lines.length, minor).toBeGreaterThanOrEqual(2);
      expect(lines.length, minor).toBeLessThanOrEqual(8);
    }
  });

  it('keeps Mara terse — no line of hers is the longest in the scene', () => {
    const longest = Math.max(...scene.nodes.map((node) => countSpokenWords(node.text)));
    const maraLongest = Math.max(
      ...scene.nodes
        .filter((node) => node.speaker === 'mara')
        .map((node) => countSpokenWords(node.text)),
    );
    expect(maraLongest).toBeLessThan(longest);
    expect(maraLongest).toBeLessThanOrEqual(12);
  });

  it('gives Dax the floor without letting any line become a monologue', () => {
    const dax = scene.nodes.filter((node) => node.speaker === 'dax');
    expect(dax.length).toBeGreaterThan(scene.nodes.length / 3);
    for (const node of scene.nodes) {
      expect(countSpokenWords(node.text), node.id).toBeLessThanOrEqual(
        MAX_SPOKEN_WORDS_PER_NODE,
      );
    }
  });
});

describe('act1_perimeter_contact — interrupts are load-bearing', () => {
  const interrupted = scene.nodes.filter(
    (node) => node.interrupts !== undefined && node.interrupts.length > 0,
  );

  it('declares at least three interruptible lines on distinct world events', () => {
    expect(interrupted.length).toBeGreaterThanOrEqual(3);
    const events = interrupted.flatMap((node) => node.interrupts!.map((i) => i.event));
    expect(new Set(events).size).toBe(events.length);
  });

  it('never lets an interrupt land on a line the player has heard none of', () => {
    for (const node of interrupted) {
      for (const interrupt of node.interrupts!) {
        expect(interrupt.earliest, node.id).toBeGreaterThan(0);
        // The cut has to leave room for the rest of the line to be lost.
        expect(interrupt.earliest!, node.id).toBeLessThan(node.duration! - 1);
      }
    }
  });

  it('only interrupts lines long enough to be worth cutting', () => {
    for (const node of interrupted) {
      expect(countSpokenWords(node.text), node.id).toBeGreaterThanOrEqual(20);
    }
  });

  it('routes each interrupt somewhere different from the uninterrupted line', () => {
    // A world event that leads to exactly the same next node is decoration.
    for (const node of interrupted) {
      for (const interrupt of node.interrupts!) {
        expect(interrupt.target, node.id).not.toBe(node.next);
        if (interrupt.target !== null) {
          expect(byId.has(interrupt.target), interrupt.target).toBe(true);
        }
      }
    }
  });
});

describe('act1_perimeter_contact — the branch has consequences', () => {
  const choiceNodes = scene.nodes.filter(
    (node) => node.choices !== undefined && node.choices.length > 0,
  );

  it('offers exactly one branch, with three options', () => {
    expect(choiceNodes).toHaveLength(1);
    expect(choiceNodes[0]!.choices).toHaveLength(3);
  });

  it('gives every option its own effects and its own reply', () => {
    const choices = choiceNodes[0]!.choices!;
    const targets = new Set(choices.map((choice) => choice.target));
    expect(targets.size).toBe(choices.length);
    for (const choice of choices) {
      expect(choice.effects, choice.id).toBeDefined();
      expect(choice.effects!.length, choice.id).toBeGreaterThan(0);
    }
  });

  it('writes a different flag set down each option', () => {
    const flagsPerChoice = choiceNodes[0]!.choices!.map((choice) =>
      (choice.effects ?? [])
        .filter((effect) => effect.kind === 'setFlag')
        .map((effect) => (effect as { flag: string }).flag)
        .sort()
        .join(','),
    );
    expect(new Set(flagsPerChoice).size).toBe(flagsPerChoice.length);
  });

  it('moves trust in more than one direction across the branch', () => {
    const deltas = choiceNodes[0]!
      .choices!.flatMap((choice) => choice.effects ?? [])
      .filter((effect) => effect.kind === 'adjustTrust')
      .map((effect) => (effect as { character: string; delta: number }));
    expect(deltas.some((d) => d.delta > 0)).toBe(true);
    expect(deltas.some((d) => d.delta < 0)).toBe(true);
    // Shielding Renna has to register with Renna, not only with Dax.
    expect(deltas.some((d) => d.character === 'renna')).toBe(true);
  });

  it('records first contact when the scene ends, however it ended', () => {
    expect(scene.onEnd).toContainEqual({
      kind: 'setFlag',
      flag: 'dax_first_contact_made',
      value: true,
    });
  });
});

describe('act1_perimeter_contact — anti-slop', () => {
  it('contains no banned trailer phrasing and no placeholder text', () => {
    for (const node of scene.nodes) {
      expect(findBannedPhrases(node.text), node.id).toEqual([]);
      expect(findPlaceholderMarkers(node.text), node.id).toEqual([]);
      for (const choice of node.choices ?? []) {
        expect(findBannedPhrases(choice.text), choice.id).toEqual([]);
        expect(findPlaceholderMarkers(choice.text), choice.id).toEqual([]);
      }
    }
  });

  it('survives the raw substring placeholder scan that lint:assets applies', () => {
    // validate-assets.ts uses `includes`, not word boundaries, so a legitimate
    // word containing "todo" would fail the asset gate even though
    // findPlaceholderMarkers passes it.
    for (const node of scene.nodes) {
      expect(/lorem ipsum|todo|placeholder/i.test(node.text), node.id).toBe(false);
    }
  });

  it('varies line length instead of settling into one rhythm', () => {
    const words = scene.nodes.map((node) => countSpokenWords(node.text));
    expect(Math.min(...words)).toBeLessThanOrEqual(8);
    expect(Math.max(...words)).toBeGreaterThanOrEqual(28);
    const distinct = new Set(words);
    expect(distinct.size).toBeGreaterThan(scene.nodes.length / 2);
  });

  it('keeps every duration inside a speakable words-per-second band', () => {
    for (const node of scene.nodes) {
      const words = countSpokenWords(node.text);
      expect(node.duration!, node.id).toBeGreaterThanOrEqual(0.8);
      const wps = words / node.duration!;
      // Lower bound is loose: short clipped lines carry deliberate pauses.
      expect(wps, node.id).toBeGreaterThan(1.8);
      expect(wps, node.id).toBeLessThan(3.3);
    }
  });

  it('carries the concrete specifics the scene is built on', () => {
    const all = scene.nodes.map((node) => node.text).join(' ');
    // Dax's signature: names, dates, exact claims, quoted wording.
    for (const specific of ['02:31', '02:14', '03:06', '02:47', 'Kell Street', 'Aldis Row']) {
      expect(all, specific).toContain(specific);
    }
    // Continuity with the two prologue scenes.
    for (const established of ['Cluster B', 'north mouth', 'survey pulse']) {
      expect(all, established).toContain(established);
    }
  });

  it('lets Dax quote someone else back at them at least once', () => {
    const quoting = scene.nodes.filter(
      (node) => node.speaker === 'dax' && /["']/.test(node.text),
    );
    expect(quoting.length).toBeGreaterThan(0);
  });
});
