/** scribe-card: a Lovelace card that charts the result of a SQL query.
 *
 * The query goes through Scribe's `scribe.query` service rather than to the
 * database: the connection, its credentials and its read-only transaction stay
 * in the integration, and Home Assistant's own authentication applies.
 *
 * The chart is Apache ECharts — what Home Assistant's own history charts use —
 * and the card's `options:` and `series:` are merged over the option it builds.
 * So anything from the ECharts documentation works here, and nothing had to be
 * invented for what ECharts already names.
 */

import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import "./editor";
import { echartsLocale } from "./locale";
import { buildOption, rightHand, resolveFormatters, stacking, type Theme } from "./option";
import { fingerprint, read, readLocal, storageKey, write } from "./persist";
import { runQuery } from "./query";
import {
  DEFAULT_RANGES,
  hasMarkers,
  isRange,
  labelFor,
  parseDuration,
  substitute,
  type Range,
} from "./range";
import {
  asPercentages,
  pickXColumn,
  pickYColumns,
  sortCategories,
  toChart,
  type Chart,
} from "./series";
import type { HassLocale, HomeAssistant, Row, ScribeCardConfig } from "./types";

/** Replaced at build time with the version in package.json, so it cannot drift. */
declare const __VERSION__: string;

// Only what the card draws: the whole of ECharts is several times this.
echarts.use([
  LineChart,
  BarChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

const CHART_TYPES = ["line", "area", "bar", "scatter"];
const STEPS = ["start", "middle", "end"];
const X_TYPES = ["auto", "time", "number", "category"];

/** A refresh faster than this is a mistake, and the database pays for it. */
const MIN_REFRESH_SECONDS = 5;

/** A sections row, and the gap between two of them. */
const GRID_ROW = 56;
const GRID_GAP = 8;

/** More rows than this in a hidden table is a lot of DOM for a screen reader
 * to walk; the label above it still says what the chart shows. */
const TABLE_LIMIT = 200;

/** The row above the chart, when there is anything to put in it. */
const TOOLBAR = 36;

/** ECharts keeps its locales by name; this card only ever needs the one Home
 * Assistant is in, rebuilt whenever that changes. */
const LOCALE_CODE = "HA";
let registered: string | undefined;

function useLocale(language: string): string {
  if (registered !== language) {
    // A partial locale is the supported path: ECharts merges anything missing
    // over its English defaults, none of which this card draws.
    echarts.registerLocale(
      LOCALE_CODE,
      echartsLocale(language) as Parameters<typeof echarts.registerLocale>[1],
    );
    registered = language;
  }
  return LOCALE_CODE;
}

@customElement("scribe-card")
export class ScribeCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;

  @state() private _config?: ScribeCardConfig;
  @state() private _rows?: Row[];
  @state() private _error?: string;
  @state() private _loading = false;
  /** The window of time the card is looking at, when its query leaves one. */
  @state() private _range?: Range;
  @state() private _menu = false;
  @state() private _custom = false;

  private _chart?: echarts.ECharts;
  private _resize?: ResizeObserver;
  private _timer?: number;
  private _queried = false;
  /** The rows, turned into a chart. Rebuilt only when the rows or the config do. */
  private _data?: { chart?: Chart; problem?: string };
  /** The theme the chart was last painted for, so a theme change repaints it. */
  private _drawnTheme?: string;
  /** The language the chart was built in: ECharts takes it once, at init. */
  private _chartLanguage?: string;
  /** What the last query asked for and what it cost, for `debug`. */
  @state() private _stats?: { rows: number; ms: number; sql: string };
  /** The ranges the picker offers, and where the chosen one is filed. */
  private _ranges: string[] = [];
  private _key?: string;

  /** The visual editor Lovelace opens for this card. */
  public static getConfigElement(): HTMLElement {
    return document.createElement("scribe-card-editor");
  }

  public static getStubConfig(): ScribeCardConfig {
    return {
      type: "custom:scribe-card",
      title: "States recorded per hour",
      sql: "SELECT time_bucket('1 hour', time) AS time, count(*) AS states\nFROM states_raw\nWHERE time > now() - interval '24 hours'\nGROUP BY 1 ORDER BY 1",
    };
  }

  public setConfig(config: ScribeCardConfig): void {
    if (!config?.sql || typeof config.sql !== "string") {
      throw new Error("scribe-card: `sql` is required");
    }
    // Everything below is caught here rather than drawn wrong: Home Assistant
    // turns a throw into a card that says what its configuration got wrong,
    // which beats a chart that silently ignored the line you just typed.
    if (config.chart !== undefined && !CHART_TYPES.includes(config.chart)) {
      throw new Error(`scribe-card: \`chart\` must be one of ${CHART_TYPES.join(", ")}`);
    }
    if (config.step !== undefined && !STEPS.includes(config.step)) {
      throw new Error(`scribe-card: \`step\` must be one of ${STEPS.join(", ")}`);
    }
    if (config.x_type !== undefined && !X_TYPES.includes(config.x_type)) {
      throw new Error(`scribe-card: \`x_type\` must be one of ${X_TYPES.join(", ")}`);
    }
    for (const [key, allowed] of [
      ["stack_mode", ["total", "percent"]],
      ["sort", ["none", "asc", "desc"]],
      ["tooltip_trigger", ["axis", "item", "none"]],
      ["legend_position", ["top", "bottom", "left", "right"]],
    ] as const) {
      const value = config[key];
      if (value !== undefined && !(allowed as readonly string[]).includes(value)) {
        throw new Error(`scribe-card: \`${key}\` must be one of ${allowed.join(", ")}`);
      }
    }
    if (config.y2 !== undefined && typeof config.y2 !== "string" && !Array.isArray(config.y2)) {
      throw new Error("scribe-card: `y2` must be a column name or a list of them");
    }
    for (const key of [
      "height",
      "refresh_interval",
      "decimals",
      "x_rotate",
      "y_min",
      "y_max",
      "y2_min",
      "y2_max",
      "margin_left",
      "margin_right",
      "margin_top",
      "margin_bottom",
      "line_width",
      "opacity",
      "symbol_size",
      "threshold",
      "warn_above",
      "warn_below",
      "scale_from",
      "scale_to",
    ] as const) {
      const value = config[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error(`scribe-card: \`${key}\` must be a number`);
      }
    }
    if (config.y !== undefined && typeof config.y !== "string" && !Array.isArray(config.y)) {
      throw new Error("scribe-card: `y` must be a column name or a list of them");
    }
    for (const key of ["colors", "scale_colors"] as const) {
      if (config[key] !== undefined && !Array.isArray(config[key])) {
        throw new Error(`scribe-card: \`${key}\` must be a list`);
      }
    }
    if (config.ranges !== undefined) {
      if (!Array.isArray(config.ranges)) throw new Error("scribe-card: `ranges` must be a list");
      for (const range of config.ranges) {
        if (parseDuration(range) === null) {
          throw new Error(`scribe-card: \`${String(range)}\` is not a range, such as 24h or 7d`);
        }
      }
    }

    this._config = config;
    this._queried = false;
    this._rows = undefined;
    this._error = undefined;

    // A query with holes in it gets a picker; the rest of the card is unchanged
    // by any of this.
    this._ranges = hasMarkers(config.sql) ? (config.ranges ?? DEFAULT_RANGES) : [];
    this._key = storageKey(
      config.storage_key || fingerprint(`${config.title ?? ""}|${config.sql}`),
    );
    this._range = this._ranges.length ? { last: this._ranges[0] } : undefined;
    if (this._ranges.length) {
      // What this browser remembers is there now; what Home Assistant remembers
      // takes a round trip, and arrives in `_restore`.
      const remembered = readLocal(this._key);
      if (isRange(remembered)) this._range = remembered;
    }
  }

  public getCardSize(): number {
    return Math.ceil(((this._config?.height ?? 250) + (this._hasToolbar() ? TOOLBAR : 0)) / 50);
  }

  /** How much of a sections view the card asks for.
   *
   * `getCardSize` is the masonry layout's question; sections ask this one, and
   * a card that does not answer is given a default that has nothing to do with
   * the chart inside it. A row is 56 pixels with 8 between them, and the chart
   * sits under the header with the content's padding around it. */
  public getGridOptions(): Record<string, unknown> {
    const chrome = (this._config?.title ? 44 : 0) + 20 + (this._hasToolbar() ? TOOLBAR : 0);
    const pixels = (this._config?.height ?? 250) + chrome;
    const rows = Math.max(1, Math.ceil((pixels + GRID_GAP) / (GRID_ROW + GRID_GAP)));
    return { columns: "full", rows, min_columns: 6, min_rows: 2 };
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._onVisibility);
    document.addEventListener("click", this._onDocumentClick);
    document.addEventListener("keydown", this._onKeydown);
    this._scheduleRefresh();
    // Moving a card around a dashboard disconnects and reconnects the element.
    // The chart was disposed on the way out, and no property changed to ask for
    // a new one, so the card would come back as an empty frame.
    if (this._rows) void this.updateComplete.then(() => this._draw());
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._onVisibility);
    document.removeEventListener("click", this._onDocumentClick);
    document.removeEventListener("keydown", this._onKeydown);
    this._stopRefresh();
    this._resize?.disconnect();
    this._resize = undefined;
    this._chart?.dispose();
    this._chart = undefined;
  }

  /**
   * Home Assistant hands every card a new `hass` on every state change in the
   * house. Nothing here depends on it — the rows come from a query — so those
   * renders are skipped, and with them the whole row-to-series transform.
   */
  protected override shouldUpdate(changed: PropertyValues): boolean {
    if (changed.size > 1 || !changed.has("hass")) return true;
    const previous = changed.get("hass") as HomeAssistant | undefined;
    // The first hass starts the query, and a theme change repaints the chart.
    return !previous || !this._queried || this._themeSignature() !== this._drawnTheme;
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("_rows") || changed.has("_config")) this._data = this._chartData();
  }

  protected override updated(changed: PropertyValues): void {
    // The first hass arrives after setConfig; query once it is there.
    if (!this._queried && this.hass && this._config) {
      this._queried = true;
      void this._query();
      void this._restore();
      this._scheduleRefresh();
    }
    const themed = this._themeSignature() !== this._drawnTheme;
    if (changed.has("_rows") || changed.has("_config") || themed) this._draw();
  }

  /** Hidden tabs do not need charts, and a wall tablet left on another tab
   * should not run a query every thirty seconds for nobody. */
  private _onVisibility = (): void => {
    if (document.hidden) {
      this._stopRefresh();
      return;
    }
    if (!this._refreshSeconds()) return;
    void this._query(true);
    this._scheduleRefresh();
  };

  /** What Home Assistant remembers for this user, wherever they last chose it.
   * It arrives after the first query, and only changes anything when it
   * disagrees with what this browser had. */
  private async _restore(): Promise<void> {
    if (!this.hass || !this._key || !this._ranges.length) return;
    const remembered = await read(this.hass, this._key);
    if (!isRange(remembered)) return;
    if (JSON.stringify(remembered) === JSON.stringify(this._range)) return;
    this._range = remembered;
    void this._query(true);
  }

  private _pick(range: Range): void {
    this._menu = false;
    this._custom = false;
    if (JSON.stringify(range) === JSON.stringify(this._range)) return;
    this._range = range;
    void this._query(true);
    if (this.hass && this._key) void write(this.hass, this._key, range);
  }

  private _toggleMenu(): void {
    this._menu = !this._menu;
    if (!this._menu) this._custom = false;
  }

  /** A click anywhere that is not the picker closes it. */
  private _onDocumentClick = (event: Event): void => {
    if (!this._menu) return;
    const picker = this.renderRoot?.querySelector(".picker");
    if (picker && event.composedPath().includes(picker)) return;
    this._menu = false;
    this._custom = false;
  };

  private _onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this._menu) {
      this._menu = false;
      this._custom = false;
    }
  };

  /** The two instants the custom panel is holding. */
  private _applyCustom(): void {
    const at = (name: string) =>
      this.renderRoot?.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;
    const from = Date.parse(at("from") ?? "");
    const to = Date.parse(at("to") ?? "");
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    this._pick({ from, to });
  }

  /** A picker only makes sense when the query left something for it to fill. */
  private _hasToolbar(): boolean {
    return Boolean(this._ranges.length || this._config?.export === true);
  }

  private _hasExport(): boolean {
    return this._hasToolbar() && (this._config?.export ?? true);
  }

  private _locale(): HassLocale {
    return this.hass?.locale ?? { language: this._language() };
  }

  private _refreshSeconds(): number {
    const seconds = this._config?.refresh_interval ?? 0;
    return seconds > 0 ? Math.max(seconds, MIN_REFRESH_SECONDS) : 0;
  }

  private _scheduleRefresh(): void {
    this._stopRefresh();
    const seconds = this._refreshSeconds();
    if (!seconds || document.hidden) return;
    this._timer = window.setInterval(() => void this._query(true), seconds * 1000);
  }

  private _stopRefresh(): void {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = undefined;
  }

  /** The query, with whatever the picker is showing written into it. */
  private _sql(): string {
    const sql = this._config?.sql ?? "";
    return this._range ? substitute(sql, this._range, Date.now()) : sql;
  }

  /** `fresh` is a refresh: it has to reach the database, which is the point. */
  private async _query(fresh = false): Promise<void> {
    if (!this.hass || !this._config) return;
    this._loading = true;
    const sql = this._sql();
    const started = performance.now();
    try {
      this._rows = await runQuery(this.hass, sql, fresh);
      this._error = undefined;
      if (this._config.debug) {
        this._stats = {
          rows: this._rows.length,
          ms: Math.round(performance.now() - started),
          sql,
        };
        // The query as the database saw it, every marker filled in.
        // eslint-disable-next-line no-console
        console.info("[scribe-card]", this._config.title ?? "", "\n" + sql);
      }
    } catch (error: unknown) {
      // Scribe reports what the database said; showing it is the whole point.
      // The rows that did load stay: a database that hiccuped once must not
      // replace a month of history with a sentence.
      this._error = error instanceof Error ? error.message : String(error);
      if (this._config.debug) {
        this._stats = { rows: 0, ms: Math.round(performance.now() - started), sql };
        // eslint-disable-next-line no-console
        console.warn("[scribe-card]", this._error, "\n" + sql);
      }
    } finally {
      this._loading = false;
    }
  }

  private _chartData(): { chart?: Chart; problem?: string } | undefined {
    if (!this._rows || !this._config) return undefined;
    if (this._rows.length === 0) return { problem: "The query returned no rows." };

    const columns = Object.keys(this._rows[0]);
    const x = pickXColumn(columns, this._config.x);
    const y = pickYColumns(this._rows, x, this._config.y);
    if (y.length === 0) {
      return { problem: `No numeric column to draw. The query returned: ${columns.join(", ")}.` };
    }
    const forced = this._config.x_type;
    let chart = toChart(this._rows, x, y, forced && forced !== "auto" ? forced : undefined);
    // Both are about the numbers rather than how they are drawn, so they
    // happen here and ECharts is handed the result.
    if (stacking(this._config) === "percent") {
      // Only what shares the left-hand axis takes part in the share.
      const right = rightHand(chart, this._config);
      chart = asPercentages(
        chart,
        chart.series.map((one) => one.name).filter((name) => !right.includes(name)),
      );
    }
    if (this._config.sort && this._config.sort !== "none") {
      chart = sortCategories(chart, this._config.sort);
    }
    return { chart };
  }

  /** What the card was painted against: a custom theme changes the colours
   * without touching `darkMode`, so both are part of the answer, and so is the
   * language, which decides what the axis says. */
  private _themeSignature(): string {
    const themes = this.hass?.themes;
    const locale = this.hass?.locale;
    return [
      themes?.theme ?? "",
      themes?.darkMode ?? false,
      this._language(),
      locale?.number_format ?? "",
      locale?.time_format ?? "",
    ].join("/");
  }

  private _language(): string {
    return this.hass?.locale?.language || this.hass?.language || "en";
  }

  /** The colours of the dashboard the card sits on. */
  private _theme(): Theme {
    const style = getComputedStyle(this);
    const read = (name: string, fallback: string) =>
      style.getPropertyValue(name).trim() || fallback;
    return {
      text: read("--primary-text-color", "#212121"),
      secondaryText: read("--secondary-text-color", "#727272"),
      grid: read("--divider-color", "rgba(127,127,127,.25)"),
      background: read("--ha-card-background", "transparent"),
      // Home Assistant's own named colours, which a theme is free to redefine.
      colour: (name) => read(`--${name}-color`, ""),
    };
  }

  private _draw(): void {
    // Recorded even when nothing is drawn, so an error state does not ask to be
    // repainted on every state change in the house.
    this._drawnTheme = this._themeSignature();

    const container = this.renderRoot?.querySelector<HTMLDivElement>(".chart");
    const data = this._data;
    if (!container || !data?.chart || !this._config) {
      this._chart?.dispose();
      this._chart = undefined;
      return;
    }

    // ECharts takes its locale when the instance is made, so a dashboard that
    // changed language needs a new one.
    const language = this._language();
    if (this._chart && this._chartLanguage !== language) {
      this._chart.dispose();
      this._chart = undefined;
    }

    if (!this._chart) {
      this._chartLanguage = language;
      this._chart = echarts.init(container, undefined, {
        renderer: "canvas",
        locale: useLocale(language),
      });
      // Lovelace resizes cards as columns reflow, and a canvas does not follow
      // on its own.
      this._resize = new ResizeObserver(() => this._chart?.resize());
      this._resize.observe(container);
    }
    // `true`: a configuration that dropped a series must not leave it behind.
    this._chart.setOption(
      resolveFormatters(
        buildOption(data.chart, this._config, this._theme()),
        this.hass?.locale ?? { language: this._language() },
      ),
      true,
    );
  }

  /** What the chart shows, for a reader who cannot see it. */
  private _description(): string {
    const kind = this._config?.chart ?? "line";
    const series = this._data?.chart?.series.map((one) => one.name) ?? [];
    const points = this._data?.chart?.x.length ?? 0;
    const title = this._config?.title ? `${this._config.title}. ` : "";
    if (!series.length) return `${title}An empty ${kind} chart.`;
    const plural = points === 1 ? "" : "s";
    return `${title}A ${kind} chart of ${series.join(", ")}, over ${points} point${plural}.`;
  }

  /** The rows behind the chart, for the same reader. A canvas says nothing to
   * a screen reader, and the numbers are the whole point of the card.
   *
   * Wrapped rather than hidden itself: a CSS width on a table is a minimum,
   * not a maximum, so a table told to be one pixel wide is not. */
  private _table(): TemplateResult | typeof nothing {
    const rows = this._rows;
    if (!rows?.length || rows.length > TABLE_LIMIT || !this._data?.chart) return nothing;
    const columns = Object.keys(rows[0]);
    return html`
      <div class="sr-only">
        <table>
          <caption>
            ${this._config?.title ?? "The query's rows"}
          </caption>
          <thead>
            <tr>
              ${columns.map((column) => html`<th>${column}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) =>
                html`<tr>
                  ${columns.map((column) => html`<td>${row[column]}</td>`)}
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  /** The rows as a CSV file, which is what someone looking at a chart and
   * wanting the numbers behind it is after. */
  private _csv(): string {
    const rows = this._rows ?? [];
    if (!rows.length) return "";
    const columns = Object.keys(rows[0]);
    const cell = (value: unknown) => {
      const text = value === null || value === undefined ? "" : String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    return [
      columns.join(","),
      ...rows.map((row) => columns.map((column) => cell(row[column])).join(",")),
    ].join("\n");
  }

  private _download(): void {
    const blob = new Blob([this._csv()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(this._config?.title || "scribe").replace(/[^\w.-]+/g, "-").toLowerCase()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /** `datetime-local` reads and writes wall-clock time, which is not what an
   * epoch is. */
  private static _forInput(ms: number): string {
    const local = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }

  private _picker(): TemplateResult {
    const locale = this._locale();
    const current = this._range;
    const now = Date.now();
    const from = current && "from" in current ? current.from : now - 86_400_000;
    const to = current && "from" in current ? current.to : now;

    return html`
      <div class="picker">
        <button
          class="trigger"
          aria-haspopup="listbox"
          aria-expanded=${this._menu ? "true" : "false"}
          @click=${this._toggleMenu}
        >
          <ha-icon icon="mdi:clock-outline"></ha-icon>
          <span>${current ? labelFor(current, locale) : "Any time"}</span>
          <span class="caret" aria-hidden="true">▾</span>
        </button>
        ${
          this._menu
            ? html`<div class="menu" role="listbox">
                ${this._ranges.map((text) => {
                  const range: Range = { last: text };
                  const chosen = JSON.stringify(range) === JSON.stringify(current);
                  return html`<button
                    class="choice ${chosen ? "chosen" : ""}"
                    role="option"
                    aria-selected=${chosen ? "true" : "false"}
                    @click=${() => this._pick(range)}
                  >
                    ${labelFor(range, locale)}
                  </button>`;
                })}
                <button
                  class="choice ${this._custom ? "chosen" : ""}"
                  @click=${() => {
                    this._custom = !this._custom;
                  }}
                >
                  Custom…
                </button>
                ${
                  this._custom
                    ? html`<div class="custom">
                        <label>
                          From
                          <input
                            type="datetime-local"
                            name="from"
                            .value=${ScribeCard._forInput(from)}
                          />
                        </label>
                        <label>
                          To
                          <input
                            type="datetime-local"
                            name="to"
                            .value=${ScribeCard._forInput(to)}
                          />
                        </label>
                        <button class="apply" @click=${this._applyCustom}>Apply</button>
                      </div>`
                    : nothing
                }
              </div>`
            : nothing
        }
      </div>
    `;
  }

  protected override render(): TemplateResult {
    if (!this._config) return html``;
    const data = this._data;
    // An error with rows behind it is stale data, not a dead card.
    const stale = Boolean(this._error && this._rows);
    const blocked = Boolean(this._error && !this._rows);
    const hide = blocked || Boolean(data?.problem);

    return html`
      <ha-card class=${this._menu ? "open" : ""} .header=${this._config.title}>
        <div class="content">
          ${
            this._hasToolbar()
              ? html`<div class="toolbar">
                  ${this._ranges.length ? this._picker() : nothing}
                  ${
                    this._hasExport()
                      ? html`<button
                          class="icon"
                          title="Download these rows as CSV"
                          aria-label="Download these rows as CSV"
                          ?disabled=${!this._rows?.length}
                          @click=${this._download}
                        >
                          <ha-icon icon="mdi:table-arrow-down"></ha-icon>
                        </button>`
                      : nothing
                  }
                </div>`
              : nothing
          }
          ${
            blocked
              ? html`<div class="error">
                  <ha-icon icon="mdi:database-alert"></ha-icon>
                  <div><b>The query failed.</b><br />${this._error}</div>
                </div>`
              : nothing
          }
          ${
            stale
              ? html`<div class="stale">
                  <ha-icon icon="mdi:database-alert"></ha-icon>
                  <div>The last refresh failed; these rows are older. ${this._error}</div>
                </div>`
              : nothing
          }
          ${!blocked && data?.problem ? html`<div class="empty">${data.problem}</div>` : nothing}
          ${
            !this._error && !this._rows && !this._loading
              ? html`<div class="empty">Waiting for Scribe…</div>`
              : nothing
          }
          <div
            class="chart ${hide ? "hidden" : ""}"
            style=${`height:${this._config.height ?? 250}px`}
            role="img"
            aria-label=${this._description()}
          ></div>
          ${this._table()}
          ${
            this._config.debug && this._stats
              ? html`<div class="debug">
                  ${this._stats.rows} rows · ${this._stats.ms} ms
                  ${this._range ? html`· ${labelFor(this._range, this._locale())}` : nothing} · the
                  query is in the console
                </div>`
              : nothing
          }
          ${this._loading ? html`<div class="loading"></div>` : nothing}
        </div>
      </ha-card>
    `;
  }

  public static override styles = css`
    ha-card {
      overflow: hidden;
    }
    /* The picker's menu is taller than a short card, and a dropdown that is
       clipped by the thing it drops out of is no dropdown. */
    ha-card.open {
      overflow: visible;
    }
    .content {
      padding: 8px 12px 12px;
      position: relative;
    }
    .chart {
      width: 100%;
    }
    .chart.hidden {
      display: none;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 4px;
      min-height: 28px;
      margin-bottom: 4px;
    }
    .picker {
      position: relative;
    }
    .toolbar button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: none;
      border-radius: 16px;
      padding: 5px 10px;
      background: none;
      color: var(--secondary-text-color);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .toolbar button:hover {
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.15));
    }
    .toolbar button[disabled] {
      opacity: 0.4;
      cursor: default;
    }
    .toolbar ha-icon {
      --mdc-icon-size: 18px;
    }
    .caret {
      font-size: 10px;
    }
    .menu {
      position: absolute;
      right: 0;
      top: calc(100% + 4px);
      z-index: 2;
      min-width: 190px;
      padding: 4px;
      border-radius: 10px;
      background: var(--card-background-color, #fff);
      box-shadow:
        0 4px 6px rgba(0, 0, 0, 0.15),
        0 1px 10px rgba(0, 0, 0, 0.12);
    }
    .menu .choice {
      display: block;
      width: 100%;
      border-radius: 6px;
      text-align: left;
      color: var(--primary-text-color);
    }
    .menu .choice.chosen {
      color: var(--primary-color);
      font-weight: 500;
    }
    .custom {
      display: grid;
      gap: 6px;
      padding: 8px 10px 4px;
      border-top: 1px solid var(--divider-color, rgba(127, 127, 127, 0.25));
      font-size: 12px;
      color: var(--secondary-text-color);
    }
    .custom label {
      display: grid;
      gap: 2px;
    }
    .custom input {
      border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.25));
      border-radius: 6px;
      padding: 4px 6px;
      background: none;
      color: var(--primary-text-color);
      font: inherit;
    }
    .custom .apply {
      justify-content: center;
      color: var(--primary-color);
    }
    .debug {
      padding: 4px 8px 0;
      color: var(--secondary-text-color);
      font-family: monospace;
      font-size: 11px;
      opacity: 0.8;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }
    .error,
    .empty,
    .stale {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 16px;
      color: var(--secondary-text-color);
      font-size: 14px;
    }
    .error {
      color: var(--error-color, #db4437);
    }
    .stale {
      gap: 8px;
      padding: 4px 8px 8px;
      font-size: 12px;
      color: var(--warning-color, #ffa600);
    }
    .stale ha-icon {
      --mdc-icon-size: 16px;
    }
    .loading {
      position: absolute;
      inset: 0 0 auto 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--primary-color), transparent);
      animation: sweep 1.2s infinite;
    }
    @keyframes sweep {
      from {
        transform: translateX(-100%);
      }
      to {
        transform: translateX(100%);
      }
    }
  `;
}

declare global {
  interface Window {
    customCards?: unknown[];
  }
}

window.customCards = window.customCards ?? [];
window.customCards.push({
  type: "scribe-card",
  name: "Scribe Card",
  description: "Chart the result of a SQL query, through the Scribe integration.",
  preview: false,
  documentationURL: "https://github.com/jonathan-gtd/scribe-card",
});

// eslint-disable-next-line no-console
console.info(
  `%c SCRIBE-CARD %c ${__VERSION__} `,
  "background:#0072b2;color:#fff",
  "background:#333;color:#fff",
);
