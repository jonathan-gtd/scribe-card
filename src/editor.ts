/** The card's visual editor.
 *
 * Home Assistant renders its own selectors from a schema, through `ha-form`, so
 * this is mostly the schema plus one idea of its own: once the query runs, the
 * columns it returned become the choices for the axes. Nobody should have to
 * retype a column name they just wrote in the SQL.
 *
 * The preview beside the editor is the card itself, so what is configured here
 * is drawn there as it is typed.
 */

import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { cleanConfig, editorTabs, formData, HELPERS, LABELS, type Schema } from "./editor-schema";
import { runQuery } from "./query";
import { defaultRange, substitute } from "./range";
import { pickXColumn, pickYColumns } from "./series";
import type { HomeAssistant, Row, ScribeCardConfig } from "./types";

/** Long enough that the columns are not looked up on every keystroke. */
const SETTLE_MS = 900;

@customElement("scribe-card-editor")
export class ScribeCardEditor extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;

  @state() private _config: Partial<ScribeCardConfig> = {};
  @state() private _columns: string[] = [];
  /** The rows the column list came from, kept so the editor can tell which
   * columns are actually drawn — which is the order `colors` runs in. */
  @state() private _rows: Row[] = [];
  @state() private _queryError?: string;
  @state() private _tab = "query";

  private _timer?: number;
  private _lastSql?: string;

  public setConfig(config: ScribeCardConfig): void {
    this._config = config;
    this._scheduleColumns();
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._timer) window.clearTimeout(this._timer);
  }

  /** Run the query in the background, only to learn its columns. */
  private _scheduleColumns(): void {
    const sql = this._config.sql;
    if (!sql || sql === this._lastSql) return;
    if (this._timer) window.clearTimeout(this._timer);
    this._timer = window.setTimeout(() => void this._loadColumns(sql), SETTLE_MS);
  }

  private async _loadColumns(sql: string): Promise<void> {
    if (!this.hass) return;
    this._lastSql = sql;
    try {
      // Through the same filling-in the card does, or a query written with
      // `$__from` in it never runs here and the columns never arrive — while
      // the preview beside this form draws perfectly well.
      const asked = substitute(
        sql,
        defaultRange(this._config.ranges),
        Date.now(),
        this.hass.config?.time_zone,
      );
      const rows = await runQuery(this.hass, asked);
      this._rows = rows;
      this._columns = rows.length ? Object.keys(rows[0]) : [];
      this._queryError = undefined;
    } catch (error: unknown) {
      // Said once, here: the preview beside this form says it again in its own
      // way, and a half-typed query failing is normal.
      this._queryError = error instanceof Error ? error.message : String(error);
      this._columns = [];
      this._rows = [];
    }
  }

  /** The columns the card will actually draw, in the order it draws them —
   * the same two rules the card itself uses, so the two cannot disagree. */
  private _drawn(): string[] {
    if (!this._rows.length) return [];
    const x = pickXColumn(this._columns, this._config.x);
    return pickYColumns(this._rows, x, this._config.y);
  }

  private _valueChanged(event: CustomEvent): void {
    event.stopPropagation();
    const config = cleanConfig(
      { ...(event.detail.value as Record<string, unknown>) },
      this._drawn(),
    );
    this._config = config;
    this._scheduleColumns();
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // A field the schema built rather than named in advance — one colour picker
  // per column — carries its own label.
  private _label = (schema: Schema): string => schema.label ?? LABELS[schema.name] ?? schema.name;
  private _helper = (schema: Schema): string | undefined => HELPERS[schema.name];

  protected override render(): TemplateResult {
    if (!this.hass) return html``;

    const tabs = editorTabs(this._columns, this._drawn());
    const current = tabs.find((tab) => tab.id === this._tab) ?? tabs[0];

    return html`
      <div class="tabs" role="tablist">
        ${tabs.map(
          (tab) => html`
            <button
              class="tab ${tab.id === current.id ? "current" : ""}"
              role="tab"
              aria-selected=${tab.id === current.id ? "true" : "false"}
              @click=${() => {
                this._tab = tab.id;
              }}
            >
              <ha-icon icon=${tab.icon}></ha-icon>
              <span>${tab.label}</span>
            </button>
          `,
        )}
      </div>

      <ha-form
        .hass=${this.hass}
        .data=${formData(this._config, this._drawn())}
        .schema=${current.schema}
        .computeLabel=${this._label}
        .computeHelper=${this._helper}
        @value-changed=${this._valueChanged}
      ></ha-form>

      ${
        // What the query returned belongs beside the fields that use it, and
        // a problem with the query belongs wherever the query is written.
        current.id === "query" && this._columns.length
          ? html`<p class="hint">Columns found: ${this._columns.join(", ")}</p>`
          : nothing
      }
      ${
        current.id === "query" && this._queryError
          ? html`<p class="hint error">The query does not run yet: ${this._queryError}</p>`
          : nothing
      }
      ${
        current.id === tabs[tabs.length - 1].id
          ? html`<p class="hint">
              Anything else — a second axis, a log scale, a dashed line — goes in
              <code>options:</code> and <code>series:</code>, in ECharts' own words. Switch to
              <b>Show code editor</b> for those.
            </p>`
          : nothing
      }
    `;
  }

  public static override styles = css`
    .tabs {
      display: flex;
      gap: 2px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--divider-color, rgba(127, 127, 127, 0.25));
      overflow-x: auto;
    }
    .tab {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      border: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      padding: 10px 14px;
      background: none;
      color: var(--secondary-text-color);
      font: inherit;
      font-size: 14px;
      cursor: pointer;
    }
    .tab:hover {
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.1));
    }
    .tab.current {
      color: var(--primary-color);
      border-bottom-color: var(--primary-color);
    }
    .tab ha-icon {
      --mdc-icon-size: 18px;
    }
    .hint {
      margin: 12px 4px 0;
      color: var(--secondary-text-color);
      font-size: 12px;
      line-height: 1.5;
    }
    .error {
      color: var(--error-color, #db4437);
    }
    code {
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.15));
      padding: 1px 4px;
      border-radius: 4px;
    }
  `;
}
