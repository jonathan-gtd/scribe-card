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
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import "./editor";
import { echartsLocale } from "./locale";
import { buildOption, resolveFormatters, type Theme } from "./option";
import { runQuery } from "./query";
import { pickXColumn, pickYColumns, toChart, type Chart } from "./series";
import type { HomeAssistant, Row, ScribeCardConfig } from "./types";

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
  CanvasRenderer,
]);

const CHART_TYPES = ["line", "area", "bar", "scatter"];
const STEPS = ["start", "middle", "end"];

/** A refresh faster than this is a mistake, and the database pays for it. */
const MIN_REFRESH_SECONDS = 5;

/** A sections row, and the gap between two of them. */
const GRID_ROW = 56;
const GRID_GAP = 8;

/** More rows than this in a hidden table is a lot of DOM for a screen reader
 * to walk; the label above it still says what the chart shows. */
const TABLE_LIMIT = 200;

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
    for (const key of ["height", "refresh_interval"] as const) {
      const value = config[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error(`scribe-card: \`${key}\` must be a number`);
      }
    }
    if (config.y !== undefined && typeof config.y !== "string" && !Array.isArray(config.y)) {
      throw new Error("scribe-card: `y` must be a column name or a list of them");
    }
    if (config.colors !== undefined && !Array.isArray(config.colors)) {
      throw new Error("scribe-card: `colors` must be a list");
    }

    this._config = config;
    this._queried = false;
    this._rows = undefined;
    this._error = undefined;
  }

  public getCardSize(): number {
    return Math.ceil((this._config?.height ?? 250) / 50);
  }

  /** How much of a sections view the card asks for.
   *
   * `getCardSize` is the masonry layout's question; sections ask this one, and
   * a card that does not answer is given a default that has nothing to do with
   * the chart inside it. A row is 56 pixels with 8 between them, and the chart
   * sits under the header with the content's padding around it. */
  public getGridOptions(): Record<string, unknown> {
    const chrome = (this._config?.title ? 44 : 0) + 20;
    const pixels = (this._config?.height ?? 250) + chrome;
    const rows = Math.max(1, Math.ceil((pixels + GRID_GAP) / (GRID_ROW + GRID_GAP)));
    return { columns: "full", rows, min_columns: 6, min_rows: 2 };
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._onVisibility);
    this._scheduleRefresh();
    // Moving a card around a dashboard disconnects and reconnects the element.
    // The chart was disposed on the way out, and no property changed to ask for
    // a new one, so the card would come back as an empty frame.
    if (this._rows) void this.updateComplete.then(() => this._draw());
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._onVisibility);
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

  /** `fresh` is a refresh: it has to reach the database, which is the point. */
  private async _query(fresh = false): Promise<void> {
    if (!this.hass || !this._config) return;
    this._loading = true;
    try {
      this._rows = await runQuery(this.hass, this._config.sql, fresh);
      this._error = undefined;
    } catch (error: unknown) {
      // Scribe reports what the database said; showing it is the whole point.
      // The rows that did load stay: a database that hiccuped once must not
      // replace a month of history with a sentence.
      this._error = error instanceof Error ? error.message : String(error);
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
    return { chart: toChart(this._rows, x, y) };
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

  protected override render(): TemplateResult {
    if (!this._config) return html``;
    const data = this._data;
    // An error with rows behind it is stale data, not a dead card.
    const stale = Boolean(this._error && this._rows);
    const blocked = Boolean(this._error && !this._rows);
    const hide = blocked || Boolean(data?.problem);

    return html`
      <ha-card .header=${this._config.title}>
        <div class="content">
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
          ${this._table()} ${this._loading ? html`<div class="loading"></div>` : nothing}
        </div>
      </ha-card>
    `;
  }

  public static override styles = css`
    ha-card {
      overflow: hidden;
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
