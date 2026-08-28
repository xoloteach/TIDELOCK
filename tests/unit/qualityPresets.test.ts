/**
 * Quality preset tests.
 *
 * The spec treats "six presets that differ only in resolution" as an
 * automatic rejection condition, so these tests assert the tiers really do
 * change distinct workload dimensions and stay monotonically ordered.
 */

import { describe, it, expect } from 'vitest';
import {
  QUALITY_PRESETS,
  QUALITY_PRESET_NAMES,
  QUALITY_PRESET_ORDER,
  getPreset,
  isQualityPresetName,
  applyOverrides,
  type QualityPreset,
  type QualityPresetName,
} from '../../src/graphics/quality/presets';

const ORDERED: QualityPresetName[] = [...QUALITY_PRESET_ORDER];

describe('quality presets', () => {
  it('defines exactly the six named tiers', () => {
    expect(QUALITY_PRESET_NAMES).toEqual([
      'potato',
      'low',
      'medium',
      'high',
      'ultra',
      'cinematic',
    ]);
    expect(Object.keys(QUALITY_PRESETS)).toHaveLength(6);
  });

  it('gives every preset a self-consistent name field', () => {
    for (const name of QUALITY_PRESET_NAMES) {
      expect(getPreset(name).name).toBe(name);
    }
  });

  it('gives every preset a distinct player-facing label and summary', () => {
    const labels = new Set(ORDERED.map((n) => getPreset(n).label));
    const summaries = new Set(ORDERED.map((n) => getPreset(n).summary));
    expect(labels.size).toBe(6);
    expect(summaries.size).toBe(6);
  });

  describe('tiers change more than resolution', () => {
    /**
     * Each adjacent pair must differ in several independent dimensions.
     * Resolution alone is explicitly not sufficient.
     */
    const DIMENSIONS: (keyof QualityPreset)[] = [
      'textureTier',
      'shadowTier',
      'shadowDistance',
      'maxDynamicLights',
      'lodMultiplier',
      'drawDistance',
      'foliageDensity',
      'particleMultiplier',
      'waterTier',
      'reflectionTier',
      'audioEmitterBudget',
      'drawCallBudget',
      'triangleBudget',
    ];

    for (let i = 0; i < ORDERED.length - 1; i += 1) {
      const lower = getPreset(ORDERED[i]);
      const upper = getPreset(ORDERED[i + 1]);

      it(`${lower.name} → ${upper.name} differs in at least 4 non-resolution dimensions`, () => {
        const changed = DIMENSIONS.filter((key) => lower[key] !== upper[key]);
        expect(
          changed.length,
          `only changed: ${changed.join(', ') || 'nothing'}`,
        ).toBeGreaterThanOrEqual(4);
      });
    }
  });

  describe('monotonic ordering', () => {
    // Values that must never decrease as tiers get more expensive.
    const NON_DECREASING: (keyof QualityPreset)[] = [
      'textureTier',
      'shadowTier',
      'maxDynamicLights',
      'maxShadowCastingLights',
      'lodMultiplier',
      'drawDistance',
      'foliageDensity',
      'particleMultiplier',
      'decalMultiplier',
      'audioEmitterBudget',
      'drawCallBudget',
      'triangleBudget',
      'anisotropy',
      'physicsFarDistance',
      'shadowDistance',
    ];

    for (const key of NON_DECREASING) {
      it(`${key} never decreases from potato to cinematic`, () => {
        for (let i = 0; i < ORDERED.length - 1; i += 1) {
          const a = getPreset(ORDERED[i])[key] as number;
          const b = getPreset(ORDERED[i + 1])[key] as number;
          expect(b, `${ORDERED[i]} (${a}) → ${ORDERED[i + 1]} (${b})`).toBeGreaterThanOrEqual(a);
        }
      });
    }
  });

  describe('effect toggles only ever turn on as tiers rise', () => {
    const FLAGS: (keyof QualityPreset)[] = ['ao', 'bloom', 'wetness'];

    for (const flag of FLAGS) {
      it(`${flag} is never enabled at a cheaper tier than a more expensive one`, () => {
        let seenEnabled = false;
        for (const name of ORDERED) {
          const enabled = getPreset(name)[flag] as boolean;
          if (enabled) seenEnabled = true;
          // Once enabled it must stay enabled for all higher tiers.
          else expect(seenEnabled, `${flag} turned back off at ${name}`).toBe(false);
        }
        expect(seenEnabled).toBe(true);
      });
    }
  });

  describe('potato is genuinely cheap', () => {
    const potato = getPreset('potato');

    it('renders below native resolution and caps pixel ratio at 1', () => {
      expect(potato.renderScale).toBeLessThan(0.7);
      expect(potato.maxPixelRatio).toBe(1);
    });

    it('uses no real shadow maps but keeps a readability fallback', () => {
      expect(potato.shadowTier).toBe(0);
      expect(potato.maxShadowCastingLights).toBe(0);
      // Blob shadows preserve the ground-contact cue the player needs.
      expect(potato.blobShadows).toBe(true);
    });

    it('disables the expensive post stack', () => {
      expect(potato.ao).toBe(false);
      expect(potato.bloom).toBe(false);
      expect(potato.depthOfField).toBe(false);
      expect(potato.reflectionTier).toBe(0);
    });

    it('still renders atmosphere so the scene stays art-directed', () => {
      expect(potato.atmosphereTier).toBeGreaterThan(0);
    });

    it('targets 30 FPS with small texture and draw budgets', () => {
      expect(potato.targetFps).toBe(30);
      expect(potato.maxTextureSize).toBeLessThanOrEqual(512);
      expect(potato.drawCallBudget).toBeLessThanOrEqual(200);
    });
  });

  describe('cinematic is the only supersampling tier', () => {
    it('renders above native only at cinematic', () => {
      for (const name of ORDERED) {
        const scale = getPreset(name).renderScale;
        if (name === 'cinematic') expect(scale).toBeGreaterThan(1);
        else expect(scale).toBeLessThanOrEqual(1);
      }
    });

    it('is the only tier enabling depth of field', () => {
      const withDof = ORDERED.filter((n) => getPreset(n).depthOfField);
      expect(withDof).toEqual(['cinematic']);
    });
  });

  describe('invariants that keep the dynamic scaler safe', () => {
    it('minRenderScale is never above renderScale', () => {
      for (const name of ORDERED) {
        const p = getPreset(name);
        expect(p.minRenderScale, name).toBeLessThanOrEqual(p.renderScale);
      }
    });

    it('shadow map size is zero exactly when shadowTier is zero', () => {
      for (const name of ORDERED) {
        const p = getPreset(name);
        expect(p.shadowMapSize === 0, name).toBe(p.shadowTier === 0);
      }
    });

    it('never allows more shadow-casting lights than dynamic lights', () => {
      for (const name of ORDERED) {
        const p = getPreset(name);
        expect(p.maxShadowCastingLights, name).toBeLessThanOrEqual(p.maxDynamicLights);
      }
    });

    it('keeps hero textures at least as large as ordinary textures', () => {
      for (const name of ORDERED) {
        const p = getPreset(name);
        expect(p.maxHeroTextureSize, name).toBeGreaterThanOrEqual(p.maxTextureSize);
      }
    });

    it('uses power-of-two texture sizes', () => {
      for (const name of ORDERED) {
        const p = getPreset(name);
        for (const size of [p.maxTextureSize, p.maxHeroTextureSize]) {
          expect(Number.isInteger(Math.log2(size)), `${name}: ${size}`).toBe(true);
        }
      }
    });
  });

  describe('isQualityPresetName', () => {
    it('accepts every real preset name', () => {
      for (const name of QUALITY_PRESET_NAMES) {
        expect(isQualityPresetName(name)).toBe(true);
      }
    });

    it('rejects unknown values without throwing', () => {
      for (const bad of ['POTATO', 'extreme', '', null, undefined, 3, {}]) {
        expect(isQualityPresetName(bad)).toBe(false);
      }
    });
  });

  describe('applyOverrides', () => {
    it('returns the preset unchanged when there are no overrides', () => {
      const base = getPreset('high');
      expect(applyOverrides(base, undefined)).toBe(base);
    });

    it('applies a numeric override', () => {
      const result = applyOverrides(getPreset('high'), { renderScale: 0.8 });
      expect(result.renderScale).toBe(0.8);
    });

    it('treats null as "follow the preset" rather than as a value', () => {
      const base = getPreset('high');
      const result = applyOverrides(base, { renderScale: null, bloom: null });
      expect(result.renderScale).toBe(base.renderScale);
      expect(result.bloom).toBe(base.bloom);
    });

    it('applies a false boolean override rather than skipping it', () => {
      // Guards against a truthiness check swallowing an intentional `false`.
      const base = getPreset('high');
      expect(base.bloom).toBe(true);
      expect(applyOverrides(base, { bloom: false }).bloom).toBe(false);
    });

    it('does not mutate the source preset', () => {
      const base = getPreset('high');
      const before = base.renderScale;
      applyOverrides(base, { renderScale: 0.5 });
      expect(getPreset('high').renderScale).toBe(before);
    });
  });

  it('freezes the preset table so runtime code cannot corrupt it', () => {
    expect(Object.isFrozen(QUALITY_PRESETS)).toBe(true);
  });
});
