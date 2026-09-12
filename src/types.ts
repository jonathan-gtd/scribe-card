/** The little of Home Assistant's frontend API this card actually uses.
 *
 * Typed here rather than pulled from a helper package: three shapes, against a
 * dependency that would have to keep up with the frontend on its own.
 */

export interface HomeAssistant {
  /** `theme` is the active theme's name: a custom theme repaints the card
   * without `darkMode` ever changing. */
  themes: { darkMode: boolean; theme?: string };
  language: string;
  /** The last argument asks for the service's response, which `scribe.query` returns. */
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>,
    notifyOnError?: boolean,
    returnResponse?: boolean,
  ): Promise<{ response?: unknown }>;
}

export interface ScribeCardConfig {
  type: string;

  // --- What everybody needs ------------------------------------------------

  /** The query to run. Its rows are the chart. */
  sql: string;
  title?: string;
  /** `line` (default), `area`, `bar` or `scatter`. */
  chart?: "line" | "area" | "bar" | "scatter";
  unit?: string;
  height?: number;
  /** Seconds between refreshes. 0, the default, only queries when the card loads. */
  refresh_interval?: number;
  /** Column holding the x value. Defaults to the first column named `time`, or the first column. */
  x?: string;
  /** Columns to draw. Defaults to every numeric column that is not the x one. */
  y?: string | string[];
  /** Colours, in series order. Defaults to a palette that reads in both themes. */
  colors?: string[];
  legend?: boolean;
  stacked?: boolean;
  /** Fill under the line. `chart: area` is the same thing. */
  fill?: boolean;

  /** Drag to zoom and a scrollbar under the chart. */
  zoom?: boolean;
  /** Curve the line instead of joining the points straight. */
  smooth?: boolean;
  /** Draw as steps: `start`, `middle` or `end` — what a thermostat looks like. */
  step?: "start" | "middle" | "end";

  // --- ECharts, for whoever wants it ---------------------------------------

  /** ECharts options, merged over what the card builds. */
  options?: Record<string, unknown>;
  /** ECharts series options, by column name. */
  series?: Record<string, Record<string, unknown>>;
}

/** One row as `scribe.query` returns it. */
export type Row = Record<string, string | number | boolean | null>;
