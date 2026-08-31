import { el, remove, requireElement } from '../ui/dom';
import { BUILD_INFO, formatBuildIdentity } from '../app/buildInfo';
import { describeCapabilities, type GraphicsCapabilities } from '../engine/render/Capabilities';
import type { FrameSnapshot } from '../engine/render/FrameStats';
import type { BackendReport, RenderStats } from '../engine/render/RenderContext';
import type { SystemTiming } from '../engine/ecs/GameWorld';
import type { ScalerState } from '../graphics/quality/DynamicScaler';
import type { LoopStats } from '../engine/time/FixedStepLoop';

/**
 * Developer diagnostics overlay (spec §35).
 *
 * Reads everything through injected provider callbacks rather than holding
 * references to the renderer, loop, world or quality system. Two reasons:
 * the overlay can be constructed before those systems exist (or with only
 * some of them, as in a unit test), and `diagnostics` never becomes a second
 * place that knows how the engine is assembled.
 *
 * A section is only built when its provider is present, so a partially wired
 * overlay shows less rather than showing zeros that look like real readings.
 */

/** Quality values the panel needs, flattened so it does not import the preset type. */
export interface DiagnosticsQualityView {
  readonly preset: string;
  readonly targetFps: number;
  readonly renderScale: number;
  readonly shadowTier: number;
  readonly textureTier: number;
  readonly drawCallBudget: number;
  readonly triangleBudget: number;
}

export interface DiagnosticsSources {
  /** The only required provider: frame timing drives the top section. */
  frameStats: () => FrameSnapshot;
  loop?: () => Readonly<LoopStats>;
  render?: () => RenderStats;
  backend?: () => BackendReport;
  adapterInfo?: () => string | null;
  bufferSize?: () => { width: number; height: number };
  cssSize?: () => { width: number; height: number };
  renderScale?: () => number;
  quality?: () => DiagnosticsQualityView;
  /**
   * Active adaptive reductions.
   *
   * Typed as `object` rather than `Record<string, unknown>` so an
   * interface-typed override bag (which has no implicit index signature) can
   * be passed straight through without a cast at the call site.
   */
  adaptiveOverrides?: () => object | null;
  scaler?: () => ScalerState;
  ecsCounts?: () => Record<string, number>;
  systemTimings?: () => SystemTiming[];
  capabilities?: () => GraphicsCapabilities | null;
  /**
   * Enables per-system profiling while the panel is open.
   *
   * Timing every system costs two `performance.now()` calls per system per
   * frame, which is measurable on a weak phone, so it is switched on in
   * `show()` and off again in `hide()`.
   */
  onProfilingChange?: (enabled: boolean) => void;
}

/**
 * Refresh period. The panel is updated at ~5 Hz rather than every frame:
 * reading these values, formatting them and touching the DOM 60 times a
 * second is itself a cost on the device we most want to measure, and no
 * human reads a number that changes 60 times a second anyway.
 */
const REFRESH_INTERVAL_MS = 200;

/** How long the copy/status line stays on screen. */
const STATUS_CLEAR_MS = 2600;

const MISSING = '—';

type RowState = 'neutral' | 'nominal' | 'fault';

/**
 * One label/value pair.
 *
 * `text` and `state` cache what was last written so `update()` can skip the
 * DOM write when nothing changed — the whole panel is built once and only
 * changed strings are assigned.
 */
interface Row {
  readonly valueEl: HTMLElement;
  text: string | null;
  state: RowState | null;
}

interface Meter {
  readonly fill: HTMLElement;
  width: string | null;
  state: RowState | null;
}

export class DiagnosticsOverlay {
  private readonly root: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly fallbackEl: HTMLTextAreaElement;

  /**
   * Rows keyed by id. Writes to an id that was never defined are ignored,
   * which is how optional providers are handled: no provider, no row, and
   * `refresh()` does not need a null check per line.
   */
  private readonly rows = new Map<string, Row>();
  private readonly meters = new Map<string, Meter>();

  /** Containers for the sections whose row set is discovered at runtime. */
  private adaptiveSection: HTMLElement | null = null;
  private worldSection: HTMLElement | null = null;
  private systemsSection: HTMLElement | null = null;

  private visible = false;
  /**
   * Set by `dispose()`.
   *
   * The head buttons keep their listeners after the panel is detached — `el()`
   * returns no unsubscribe handle and `remove()` only unlinks the node — so
   * dispose has to be terminal by flag. Without it a late click, or a stale
   * hotkey handler calling `show()`, could re-arm the status timeout or switch
   * per-system profiling back on with no panel on screen and no owner left to
   * switch it off.
   */
  private disposed = false;
  /** Primed so the first `update()` after `show()` paints immediately. */
  private accumulatorMs = REFRESH_INTERVAL_MS;
  private lastTickMs = 0;
  private statusTimer: number | null = null;

  constructor(
    private readonly sources: DiagnosticsSources,
    host: HTMLElement = requireElement('#ui-root'),
  ) {
    this.statusEl = el('div', { class: 'diag__status' });
    this.fallbackEl = el('textarea', {
      class: 'diag__fallback',
      attrs: { readonly: 'readonly', spellcheck: 'false', 'aria-label': 'Diagnostics report' },
    });
    this.fallbackEl.hidden = true;

    this.root = el('div', {
      class: ['diag', 'diag--hidden'],
      attrs: { role: 'region', 'aria-label': 'Developer diagnostics' },
      children: [this.buildHead()],
    });

    this.buildFrameSection();
    this.buildRendererSection();
    this.buildQualitySection();
    this.buildBudgetSection();
    this.buildLoopSection();
    this.buildWorldSection();
    this.buildSystemsSection();
    this.buildBuildSection();

    this.root.append(this.statusEl, this.fallbackEl);
    host.appendChild(this.root);
  }

  // ---- Construction -----------------------------------------------------

  private buildHead(): HTMLElement {
    return el('div', {
      class: 'diag__head',
      children: [
        el('div', { class: 'diag__title', text: 'Diagnostics' }),
        el('div', { class: 'diag__identity', text: formatBuildIdentity() }),
        el('div', {
          class: 'diag__actions',
          children: [
            el('button', {
              class: 'btn btn--ghost',
              text: 'Copy Diagnostics',
              attrs: { type: 'button' },
              on: { click: () => void this.copyReport() },
            }),
            el('button', {
              class: 'btn btn--ghost',
              text: 'Close',
              attrs: { type: 'button' },
              on: { click: () => this.hide() },
            }),
          ],
        }),
      ],
    });
  }

  /** Creates a labelled section and appends it to the panel. */
  private section(title: string): HTMLElement {
    const body = el('div', { class: 'diag__rows' });
    this.root.appendChild(
      el('section', {
        class: 'diag__section',
        children: [el('h2', { class: 'diag__section-title', text: title }), body],
      }),
    );
    return body;
  }

  private defineRow(parent: HTMLElement, key: string, label: string): Row {
    const valueEl = el('span', { class: 'diag__value diag__value--neutral', text: MISSING });
    parent.appendChild(
      el('div', {
        class: 'diag__row',
        children: [el('span', { class: 'diag__label', text: label }), valueEl],
      }),
    );
    const row: Row = { valueEl, text: null, state: null };
    this.rows.set(key, row);
    return row;
  }

  private buildFrameSection(): void {
    const body = this.section('Frame');
    this.defineRow(body, 'fps', 'fps');
    this.defineRow(body, 'avgFps', 'average fps');
    this.defineRow(body, 'lowFps', '1% low fps');
    this.defineRow(body, 'frameMs', 'frame');
    this.defineRow(body, 'avgFrameMs', 'average frame');
    this.defineRow(body, 'worstMs', 'worst frame');
    this.defineRow(body, 'longFrames', 'long frames');
  }

  private buildRendererSection(): void {
    const s = this.sources;
    // `quality` counts as a renderer source because it carries the preset's
    // render scale: without it here, a quality-only overlay skipped the whole
    // section and silently dropped a value `refreshRenderer` had already read
    // and formatted (and that the text report still printed).
    const anyRenderer =
      s.backend ||
      s.adapterInfo ||
      s.bufferSize ||
      s.cssSize ||
      s.renderScale ||
      s.quality ||
      s.render;
    if (!anyRenderer && !s.capabilities) return;

    const body = this.section('Renderer');
    if (s.backend) this.defineRow(body, 'backend', 'backend');
    if (s.adapterInfo) this.defineRow(body, 'adapter', 'adapter');
    if (s.capabilities) this.defineRow(body, 'device', 'device');
    if (s.bufferSize) this.defineRow(body, 'buffer', 'buffer');
    if (s.cssSize) this.defineRow(body, 'css', 'css size');
    if (s.renderScale || s.quality) this.defineRow(body, 'renderScale', 'render scale');
    if (s.render) {
      this.defineRow(body, 'geometries', 'geometries');
      this.defineRow(body, 'textures', 'textures');
    }
  }

  private buildQualitySection(): void {
    const s = this.sources;
    if (!s.quality && !s.adaptiveOverrides && !s.scaler) return;

    const body = this.section('Quality');
    if (s.quality) {
      this.defineRow(body, 'preset', 'preset');
      this.defineRow(body, 'targetFps', 'target fps');
      this.defineRow(body, 'shadowTier', 'shadow tier');
      this.defineRow(body, 'textureTier', 'texture tier');
    }
    if (s.scaler) {
      this.defineRow(body, 'scalerLevel', 'scaler level');
      this.defineRow(body, 'scalerDeficit', 'deficit');
      this.defineRow(body, 'scalerHeadroom', 'headroom');
      this.defineRow(body, 'scalerDecisions', 'decisions');
    }
    if (s.adaptiveOverrides) {
      body.appendChild(el('div', { class: 'diag__subhead', text: 'adaptive overrides' }));
      // Override keys come and go, so this sub-list grows lazily and rows are
      // blanked rather than removed once seen. The DOM shape stays stable.
      this.adaptiveSection = el('div', { class: 'diag__rows' });
      body.appendChild(this.adaptiveSection);
      this.defineRow(this.adaptiveSection, 'adaptiveNone', 'active');
    }
  }

  /**
   * Draw calls and triangles against the preset budget.
   *
   * The most useful reading in the panel: it answers "is this scene within
   * what the preset promised" rather than just reporting a number, so it gets
   * its own emphasised section with a meter.
   */
  private buildBudgetSection(): void {
    if (!this.sources.render) return;

    const body = this.section('Budgets');
    body.parentElement?.classList.add('diag__section--budgets');
    this.defineBudget(body, 'drawCalls', 'draw calls');
    this.defineBudget(body, 'triangles', 'triangles');
  }

  private defineBudget(parent: HTMLElement, key: string, label: string): void {
    this.defineRow(parent, key, label);
    const fill = el('div', { class: 'diag__meter-fill diag__meter-fill--neutral' });
    parent.appendChild(el('div', { class: 'diag__meter', children: [fill] }));
    this.meters.set(key, { fill, width: null, state: null });
  }

  private buildLoopSection(): void {
    if (!this.sources.loop) return;
    const body = this.section('Loop');
    this.defineRow(body, 'stepsLastFrame', 'steps last frame');
    this.defineRow(body, 'totalSteps', 'total steps');
    this.defineRow(body, 'droppedTime', 'dropped time');
    this.defineRow(body, 'overloadFrames', 'overload frames');
  }

  private buildWorldSection(): void {
    if (!this.sources.ecsCounts) return;
    this.worldSection = this.section('World');
  }

  private buildSystemsSection(): void {
    if (!this.sources.systemTimings) return;
    const body = this.section('Systems');
    this.defineRow(body, 'systemsTotal', 'total');
    this.systemsSection = el('div', { class: 'diag__rows' });
    body.appendChild(this.systemsSection);

    if (typeof this.sources.onProfilingChange !== 'function') {
      // Be honest about zeroes: GameWorld clears timings when profiling is
      // off, and without the hook this overlay cannot turn it on.
      body.appendChild(
        el('div', {
          class: 'diag__note',
          text: 'no profiling hook wired — per-system timings read zero',
        }),
      );
    }
  }

  private buildBuildSection(): void {
    const body = this.section('Build');
    this.defineRow(body, 'commit', 'commit');
    this.defineRow(body, 'version', 'version');
    this.defineRow(body, 'mode', 'mode');
    this.defineRow(body, 'built', 'built');
    // Static for the lifetime of the page, so written once instead of at 5 Hz.
    this.write('commit', BUILD_INFO.commit);
    this.write('version', BUILD_INFO.version);
    this.write('mode', BUILD_INFO.mode);
    this.write('built', BUILD_INFO.buildTime);
  }

  // ---- Visibility -------------------------------------------------------

  get isVisible(): boolean {
    return this.visible;
  }

  show(): void {
    if (this.disposed || this.visible) return;
    this.visible = true;
    this.root.classList.remove('diag--hidden');
    this.sources.onProfilingChange?.(true);
    // Repaint on the very next update rather than up to 200 ms later.
    this.accumulatorMs = REFRESH_INTERVAL_MS;
    this.lastTickMs = 0;
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.add('diag--hidden');
    this.sources.onProfilingChange?.(false);
    this.clearStatus();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  // ---- Per-frame update -------------------------------------------------

  /**
   * Call once per rendered frame. Cheap by design:
   *   - nothing happens at all while hidden;
   *   - providers are only read at ~5 Hz (see REFRESH_INTERVAL_MS);
   *   - the DOM is built once in the constructor and a `textContent` write
   *     only happens for values whose formatted string actually changed.
   *
   * @param frameDelta Real seconds since the previous frame. Optional: the
   *   clock is read instead when the caller does not have one to hand.
   */
  update(frameDelta?: number): void {
    if (!this.visible) return;

    let deltaMs: number;
    if (frameDelta !== undefined && Number.isFinite(frameDelta)) {
      deltaMs = frameDelta * 1000;
    } else {
      const now = performance.now();
      deltaMs = this.lastTickMs > 0 ? now - this.lastTickMs : REFRESH_INTERVAL_MS;
      this.lastTickMs = now;
    }

    this.accumulatorMs += deltaMs;
    if (this.accumulatorMs < REFRESH_INTERVAL_MS) return;
    // Reset rather than subtract: after a long stall we want one refresh, not
    // a burst of catch-up refreshes.
    this.accumulatorMs = 0;

    this.refresh();
  }

  private refresh(): void {
    const s = this.sources;
    const quality = s.quality?.();

    this.refreshFrame(s.frameStats(), quality?.targetFps ?? 0);
    this.refreshRenderer(quality);
    this.refreshQuality(quality);
    this.refreshBudgets(quality);
    this.refreshLoop();
    this.refreshWorld();
    this.refreshSystems();
  }

  private refreshFrame(frame: FrameSnapshot, targetFps: number): void {
    this.write('fps', formatFixed(frame.fps, 1), fpsState(frame.fps, targetFps));
    this.write('avgFps', formatFixed(frame.averageFps, 1));
    this.write('lowFps', formatFixed(frame.onePercentLowFps, 1));
    this.write('frameMs', formatMs(frame.frameMs));
    this.write('avgFrameMs', formatMs(frame.averageFrameMs));
    this.write('worstMs', formatMs(frame.worstFrameMs));
    this.write('longFrames', formatCount(frame.longFrames));
  }

  private refreshRenderer(quality: DiagnosticsQualityView | undefined): void {
    const s = this.sources;

    const backend = s.backend?.();
    if (backend) this.write('backend', describeBackend(backend));

    const adapter = s.adapterInfo?.();
    this.write('adapter', adapter && adapter.length > 0 ? adapter : 'unknown');

    const caps = s.capabilities?.();
    if (caps) this.write('device', describeDevice(caps));

    const buffer = s.bufferSize?.();
    if (buffer) this.write('buffer', formatSize(buffer));

    const css = s.cssSize?.();
    if (css) this.write('css', formatSize(css));

    const scale = s.renderScale?.() ?? quality?.renderScale;
    if (scale !== undefined) this.write('renderScale', formatFixed(scale, 3));

    const render = s.render?.();
    if (render) {
      this.write('geometries', formatCount(render.geometries));
      this.write('textures', formatCount(render.textures));
    }
  }

  private refreshQuality(quality: DiagnosticsQualityView | undefined): void {
    if (quality) {
      this.write('preset', quality.preset);
      this.write('targetFps', formatCount(quality.targetFps));
      this.write('shadowTier', formatCount(quality.shadowTier));
      this.write('textureTier', formatCount(quality.textureTier));
    }

    const scaler = this.sources.scaler?.();
    if (scaler) {
      this.write(
        'scalerLevel',
        scaler.enabled
          ? `${scaler.level}/${scaler.maxLevel} ${scaler.currentLabel ?? 'at preset'}`
          : 'disabled',
        scaler.level > 0 ? 'fault' : 'nominal',
      );
      this.write('scalerDeficit', formatSeconds(scaler.deficitSeconds));
      this.write('scalerHeadroom', formatSeconds(scaler.headroomSeconds));
      this.write('scalerDecisions', formatCount(scaler.decisions));
    }

    this.refreshAdaptive();
  }

  private refreshAdaptive(): void {
    const section = this.adaptiveSection;
    if (!section) return;

    const entries = readOverrides(this.sources.adaptiveOverrides?.());
    this.write('adaptiveNone', entries.length === 0 ? 'none' : `${entries.length} applied`);

    const seen = new Set<string>();
    for (const [key, value] of entries) {
      seen.add(key);
      const rowKey = `adaptive:${key}`;
      if (!this.rows.has(rowKey)) this.defineRow(section, rowKey, key);
      this.write(rowKey, formatUnknown(value), 'fault');
    }

    // A dropped override keeps its row and reads MISSING. Removing nodes
    // would make the panel jump around as the scaler moves up and down.
    for (const rowKey of this.rows.keys()) {
      if (!rowKey.startsWith('adaptive:')) continue;
      if (seen.has(rowKey.slice('adaptive:'.length))) continue;
      this.write(rowKey, MISSING, 'neutral');
    }
  }

  private refreshBudgets(quality: DiagnosticsQualityView | undefined): void {
    const render = this.sources.render?.();
    if (!render) return;
    this.writeBudget('drawCalls', render.drawCalls, quality?.drawCallBudget);
    this.writeBudget('triangles', render.triangles, quality?.triangleBudget);
  }

  private writeBudget(key: string, value: number, budget: number | undefined): void {
    const hasBudget = typeof budget === 'number' && budget > 0;
    const state: RowState = hasBudget ? (value <= budget ? 'nominal' : 'fault') : 'neutral';
    this.write(
      key,
      hasBudget ? `${formatCount(value)} / ${formatCount(budget)}` : formatCount(value),
      state,
    );

    const meter = this.meters.get(key);
    if (!meter) return;
    const ratio = hasBudget ? Math.min(1, Math.max(0, value / budget)) : 0;
    const width = `${(ratio * 100).toFixed(1)}%`;
    if (meter.width !== width) {
      meter.fill.style.width = width;
      meter.width = width;
    }
    if (meter.state !== state) {
      meter.fill.className = `diag__meter-fill diag__meter-fill--${state}`;
      meter.state = state;
    }
  }

  private refreshLoop(): void {
    const loop = this.sources.loop?.();
    if (!loop) return;
    this.write('stepsLastFrame', formatCount(loop.stepsLastFrame));
    this.write('totalSteps', formatCount(loop.totalSteps));
    this.write('droppedTime', formatSeconds(loop.droppedTime));
    this.write('overloadFrames', formatCount(loop.overloadFrames));
  }

  private refreshWorld(): void {
    const section = this.worldSection;
    const counts = this.sources.ecsCounts?.();
    if (!section || !counts) return;

    for (const [name, count] of Object.entries(counts)) {
      const rowKey = `ecs:${name}`;
      if (!this.rows.has(rowKey)) this.defineRow(section, rowKey, name);
      this.write(rowKey, formatCount(count));
    }
  }

  private refreshSystems(): void {
    const section = this.systemsSection;
    const timings = this.sources.systemTimings?.();
    if (!section || !timings) return;

    let total = 0;
    for (const timing of timings) {
      total += timing.fixedMs + timing.renderMs;
      const rowKey = `sys:${timing.name}`;
      if (!this.rows.has(rowKey)) this.defineRow(section, rowKey, timing.name);
      this.write(
        rowKey,
        `${formatFixed(timing.fixedMs, 2)} / ${formatFixed(timing.renderMs, 2)} ms`,
      );
    }
    this.write('systemsTotal', formatMs(total));
  }

  /** Writes a row only when the formatted value or its state changed. */
  private write(key: string, text: string, state: RowState = 'neutral'): void {
    const row = this.rows.get(key);
    if (!row) return;

    if (row.text !== text) {
      row.valueEl.textContent = text;
      row.text = text;
    }
    if (row.state !== state) {
      row.valueEl.className = `diag__value diag__value--${state}`;
      row.state = state;
    }
  }

  // ---- Report -----------------------------------------------------------

  /**
   * Plain-text snapshot for bug reports.
   *
   * Reads the providers directly rather than scraping the DOM, so it is
   * correct even when the panel has never been shown.
   */
  buildTextReport(): string {
    const s = this.sources;
    const lines: string[] = [formatBuildIdentity(), ''];

    lines.push(field('mode', BUILD_INFO.mode));
    lines.push(field('commit', BUILD_INFO.commit));
    lines.push(field('captured', new Date().toISOString()));
    if (typeof navigator !== 'undefined') lines.push(field('user agent', navigator.userAgent));
    if (typeof location !== 'undefined') lines.push(field('url', location.href));

    const quality = s.quality?.();
    const frame = s.frameStats();

    lines.push('', '[frame]');
    lines.push(field('fps', formatFixed(frame.fps, 1)));
    lines.push(field('average fps', formatFixed(frame.averageFps, 1)));
    lines.push(field('1% low fps', formatFixed(frame.onePercentLowFps, 1)));
    lines.push(field('frame', formatMs(frame.frameMs)));
    lines.push(field('average frame', formatMs(frame.averageFrameMs)));
    lines.push(field('worst frame', formatMs(frame.worstFrameMs)));
    lines.push(field('long frames', formatCount(frame.longFrames)));
    lines.push(field('total frames', formatCount(frame.totalFrames)));
    lines.push(field('stable sample', frame.hasStableSample ? 'yes' : 'no'));

    const backend = s.backend?.();
    const adapter = s.adapterInfo?.();
    const buffer = s.bufferSize?.();
    const css = s.cssSize?.();
    const scale = s.renderScale?.() ?? quality?.renderScale;
    const render = s.render?.();
    if (backend || adapter || buffer || css || scale !== undefined || render) {
      lines.push('', '[renderer]');
      if (backend) lines.push(field('backend', describeBackend(backend)));
      if (adapter !== undefined) lines.push(field('adapter', adapter ?? 'unknown'));
      if (buffer) lines.push(field('buffer', formatSize(buffer)));
      if (css) lines.push(field('css size', formatSize(css)));
      if (scale !== undefined) lines.push(field('render scale', formatFixed(scale, 3)));
      if (render) {
        lines.push(field('geometries', formatCount(render.geometries)));
        lines.push(field('textures', formatCount(render.textures)));
        lines.push(field('render calls', formatCount(render.renderCalls)));
      }
    }

    if (quality) {
      lines.push('', '[quality]');
      lines.push(field('preset', quality.preset));
      lines.push(field('target fps', formatCount(quality.targetFps)));
      lines.push(field('shadow tier', formatCount(quality.shadowTier)));
      lines.push(field('texture tier', formatCount(quality.textureTier)));
    }

    const overrides = readOverrides(s.adaptiveOverrides?.());
    if (s.adaptiveOverrides) {
      lines.push('', '[adaptive]');
      if (overrides.length === 0) lines.push(field('active', 'none'));
      else for (const [key, value] of overrides) lines.push(field(key, formatUnknown(value)));
    }

    const scaler = s.scaler?.();
    if (scaler) {
      lines.push('', '[scaler]');
      lines.push(field('enabled', scaler.enabled ? 'yes' : 'no'));
      lines.push(field('level', `${scaler.level}/${scaler.maxLevel}`));
      lines.push(field('applied', scaler.currentLabel ?? 'none'));
      lines.push(field('deficit', formatSeconds(scaler.deficitSeconds)));
      lines.push(field('headroom', formatSeconds(scaler.headroomSeconds)));
      lines.push(field('decisions', formatCount(scaler.decisions)));
    }

    if (render) {
      lines.push('', '[budgets]');
      lines.push(field('draw calls', budgetField(render.drawCalls, quality?.drawCallBudget)));
      lines.push(field('triangles', budgetField(render.triangles, quality?.triangleBudget)));
    }

    const loop = s.loop?.();
    if (loop) {
      lines.push('', '[loop]');
      lines.push(field('steps last frame', formatCount(loop.stepsLastFrame)));
      lines.push(field('total steps', formatCount(loop.totalSteps)));
      lines.push(field('total frames', formatCount(loop.totalFrames)));
      lines.push(field('dropped time', formatSeconds(loop.droppedTime)));
      lines.push(field('overload frames', formatCount(loop.overloadFrames)));
      lines.push(field('elapsed', formatSeconds(loop.elapsed)));
    }

    const counts = s.ecsCounts?.();
    if (counts) {
      lines.push('', '[world]');
      for (const [name, count] of Object.entries(counts)) {
        lines.push(field(name, formatCount(count)));
      }
    }

    const timings = s.systemTimings?.();
    if (timings && timings.length > 0) {
      lines.push('', '[systems] fixed / render ms');
      for (const timing of timings) {
        lines.push(
          field(timing.name, `${formatFixed(timing.fixedMs, 2)} / ${formatFixed(timing.renderMs, 2)}`),
        );
      }
    }

    const caps = s.capabilities?.();
    if (caps) lines.push('', '[capabilities]', describeCapabilities(caps));

    return lines.join('\n');
  }

  /**
   * Copies the report to the clipboard.
   *
   * The async clipboard API needs a secure context and permission, neither of
   * which is guaranteed on a phone on a LAN address, so failure falls back to
   * a selectable textarea inside the panel instead of silently doing nothing.
   */
  private async copyReport(): Promise<void> {
    if (this.disposed) return;
    const report = this.buildTextReport();

    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(report);
        this.setStatus('copied to clipboard', 'nominal');
        return;
      } catch (error) {
        console.warn('[diagnostics] clipboard write rejected', error);
      }
    }

    this.showFallbackText(report);
  }

  private showFallbackText(report: string): void {
    this.fallbackEl.value = report;
    this.fallbackEl.hidden = false;
    this.fallbackEl.focus();
    this.fallbackEl.select();

    // execCommand is deprecated but still the only synchronous copy path in
    // insecure contexts. If it fails, the text stays selected for a manual copy.
    let copied = false;
    try {
      copied = typeof document.execCommand === 'function' && document.execCommand('copy');
    } catch (error) {
      console.warn('[diagnostics] fallback copy failed', error);
    }

    this.setStatus(
      copied ? 'copied (fallback)' : 'clipboard unavailable — text selected, copy manually',
      copied ? 'nominal' : 'fault',
    );
  }

  private setStatus(text: string, state: RowState): void {
    this.statusEl.textContent = text;
    this.statusEl.className = `diag__status diag__status--${state}`;
    if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => this.clearStatus(), STATUS_CLEAR_MS);
  }

  private clearStatus(): void {
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.statusEl.textContent = '';
    this.statusEl.className = 'diag__status';
    this.fallbackEl.hidden = true;
  }

  /** Removes the panel and makes sure profiling is not left switched on. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.visible) this.hide();
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    remove(this.root);
    this.rows.clear();
    this.meters.clear();
  }
}

// ---- Formatting ---------------------------------------------------------
// Fixed decimal counts everywhere: combined with tabular-nums in the CSS this
// keeps every column a constant width, so the panel does not twitch sideways
// as digits change.

function formatFixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : MISSING;
}

function formatMs(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(2)} ms` : MISSING;
}

function formatSeconds(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(2)} s` : MISSING;
}

/**
 * Integer with thousands separators.
 *
 * Grouped by hand rather than via `toLocaleString` so the separator is the
 * same on every device — these numbers get pasted into bug reports and
 * compared across phones.
 */
function formatCount(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  const rounded = Math.round(value);
  const digits = String(Math.abs(rounded));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return rounded < 0 ? `-${out}` : out;
}

function formatSize(size: { width: number; height: number }): string {
  return `${formatCount(size.width)} × ${formatCount(size.height)}`;
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? formatCount(value) : formatFixed(value, 3);
  }
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === null || value === undefined) return MISSING;
  return String(value);
}

function budgetField(value: number, budget: number | undefined): string {
  if (typeof budget !== 'number' || budget <= 0) return formatCount(value);
  const pct = ((value / budget) * 100).toFixed(0);
  return `${formatCount(value)} / ${formatCount(budget)} (${pct}%) ${
    value <= budget ? 'under' : 'OVER'
  }`;
}

function field(label: string, value: string): string {
  return `${label.padEnd(17)}${value}`;
}

/** Reports the backend that actually came up, and why, never the request. */
function describeBackend(report: BackendReport): string {
  if (report.forcedByUser) return `${report.actual} · forced`;
  if (report.requested !== report.actual) {
    return `${report.actual} · fallback from ${report.requested}`;
  }
  return report.actual;
}

function describeDevice(caps: GraphicsCapabilities): string {
  const parts: string[] = [caps.deviceClass];
  if (caps.touchCapable) parts.push('touch');
  parts.push(`dpr ${caps.devicePixelRatio.toFixed(2)}`);
  if (caps.cpuThreads !== null) parts.push(`${caps.cpuThreads}t`);
  return parts.join(' · ');
}

/** Green while holding target, red once clearly below it, plain when unknown. */
function fpsState(fps: number, targetFps: number): RowState {
  if (targetFps <= 0 || fps <= 0) return 'neutral';
  if (fps >= targetFps * 0.95) return 'nominal';
  if (fps < targetFps * 0.8) return 'fault';
  return 'neutral';
}

/**
 * Normalises an override bag into entries, dropping the nulls that mean
 * "follow the preset". Allocates a small array per refresh, which at 5 Hz is
 * not worth avoiding.
 */
function readOverrides(raw: object | null | undefined): [string, unknown][] {
  if (!raw) return [];
  return Object.entries(raw as Record<string, unknown>).filter(
    ([, value]) => value !== null && value !== undefined,
  );
}
