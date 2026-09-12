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

import { buildOption, resolveFormatters, type Theme } from "./option";
import { pickXColumn, pickYColumns, toChart, type Chart } from "./series";
import type { HomeAssistant, Row, ScribeCardConfig } from "./types";

const VERSION = "0.2.0";

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
    this._scheduleRefresh();
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stopRefresh();
    this._resize?.disconnect();
    this._resize = undefined;
    this._chart?.dispose();
    this._chart = undefined;
  }

  protected override updated(changed: PropertyValues): void {
    // The first hass arrives after setConfig; query once it is there.
    if (!this._queried && this.hass && this._config) {
      this._queried = true;
      void this._query();
      this._scheduleRefresh();
    }
    if (changed.has("_rows") || changed.has("_config")) this._draw();
  }

  private _scheduleRefresh(): void {
    this._stopRefresh();
    const seconds = this._config?.refresh_interval ?? 0;
    if (!seconds) return;
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
      this._error = error instanceof Error ? error.message : String(error);
      this._rows = undefined;
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
    const container = this.renderRoot?.querySelector<HTMLDivElement>(".chart");
    const data = this._chartData();
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
    const data = this._chartData();
    const message = this._error ?? data?.problem;

    return html`
      <ha-card .header=${this._config.title}>
        <div class="content">
          ${
            this._error
              ? html`<div class="error">
                  <ha-icon icon="mdi:database-alert"></ha-icon>
                  <div><b>The query failed.</b><br />${this._error}</div>
                </div>`
              : nothing
          }
          ${!this._error && data?.problem ? html`<div class="empty">${data.problem}</div>` : nothing}
          ${
            !this._error && !this._rows && !this._loading
              ? html`<div class="empty">Waiting for Scribe…</div>`
              : nothing
          }
          <div
            class="chart ${message ? "hidden" : ""}"
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
    .empty {
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
  `%c SCRIBE-CARD %c ${VERSION} `,
  "background:#0072b2;color:#fff",
  "background:#333;color:#fff",
);
