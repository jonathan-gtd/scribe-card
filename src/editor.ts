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

import { cleanConfig, editorSchema, formData, HELPERS, LABELS, type Schema } from "./editor-schema";
import { runQuery } from "./query";
import type { HomeAssistant, ScribeCardConfig } from "./types";

/** Long enough that the columns are not looked up on every keystroke. */
const SETTLE_MS = 900;

@customElement("scribe-card-editor")
export class ScribeCardEditor extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;

  @state() private _config: Partial<ScribeCardConfig> = {};
  @state() private _columns: string[] = [];
  @state() private _queryError?: string;

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
      // The same call the preview beside this form makes, a moment earlier or
      // later: `runQuery` hands both of them one answer.
      const rows = await runQuery(this.hass, sql);
      this._columns = rows.length ? Object.keys(rows[0]) : [];
      this._queryError = undefined;
    } catch (error: unknown) {
      // Said once, here: the preview beside this form says it again in its own
      // way, and a half-typed query failing is normal.
      this._queryError = error instanceof Error ? error.message : String(error);
      this._columns = [];
    }
  }

  private _valueChanged(event: CustomEvent): void {
    event.stopPropagation();
    const config = cleanConfig({ ...(event.detail.value as Record<string, unknown>) });
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

  private _label = (schema: Schema): string => LABELS[schema.name] ?? schema.name;
  private _helper = (schema: Schema): string | undefined => HELPERS[schema.name];

  protected override render(): TemplateResult {
    if (!this.hass) return html``;

    return html`
      <ha-form
        .hass=${this.hass}
        .data=${formData(this._config)}
        .schema=${editorSchema(this._columns)}
        .computeLabel=${this._label}
        .computeHelper=${this._helper}
        @value-changed=${this._valueChanged}
      ></ha-form>

      ${
        this._columns.length
          ? html`<p class="hint">Columns found: ${this._columns.join(", ")}</p>`
          : nothing
      }
      ${
        this._queryError
          ? html`<p class="hint error">The query does not run yet: ${this._queryError}</p>`
          : nothing
      }
      <p class="hint">
        Anything else — a second axis, a log scale, a dashed line — goes in
        <code>options:</code> and <code>series:</code>, in ECharts' own words. Switch to
        <b>Show code editor</b> for those.
      </p>
    `;
  }

  public static override styles = css`
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
