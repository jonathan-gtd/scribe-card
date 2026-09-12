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
import { buildOption, resolveFormatters, type Theme } from "./option";
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
    void this._query();
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
    this._timer = window.setInterval(() => void this._query(), seconds * 1000);
  }

  private _stopRefresh(): void {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = undefined;
  }

  private async _query(): Promise<void> {
    if (!this.hass || !this._config) return;
    this._loading = true;
    try {
      const result = await this.hass.callService(
        "scribe",
        "query",
        { sql: this._config.sql },
        undefined,
        false,
        true,
      );
      const rows = (result?.response as { result?: Row[] } | undefined)?.result;
      if (!Array.isArray(rows)) throw new Error("the query returned no rows array");
      this._rows = rows;
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
   * without touching `darkMode`, so both are part of the answer. */
  private _themeSignature(): string {
    const themes = this.hass?.themes;
    return `${themes?.theme ?? ""}/${themes?.darkMode ?? false}`;
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

    if (!this._chart) {
      this._chart = echarts.init(container, undefined, { renderer: "canvas" });
      // Lovelace resizes cards as columns reflow, and a canvas does not follow
      // on its own.
      this._resize = new ResizeObserver(() => this._chart?.resize());
      this._resize.observe(container);
    }
    // `true`: a configuration that dropped a series must not leave it behind.
    this._chart.setOption(
      resolveFormatters(buildOption(data.chart, this._config, this._theme())),
      true,
    );
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
          ></div>
          ${this._loading ? html`<div class="loading"></div>` : nothing}
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
