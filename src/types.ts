/** The little of Home Assistant's frontend API this card actually uses.
 *
 * Typed here rather than pulled from a helper package: three shapes, against a
 * dependency that would have to keep up with the frontend on its own.
 */

/** How the dashboard's owner writes dates and numbers. */
export interface HassLocale {
  language?: string;
  /** `language`, `system`, `comma_decimal`, `decimal_comma`, `space_comma`,
   * `quote_decimal` or `none`. */
  number_format?: string;
  /** `language`, `system`, `am_pm` or `twenty_four`. */
  time_format?: string;
}

export interface HomeAssistant {
  /** `theme` is the active theme's name: a custom theme repaints the card
   * without `darkMode` ever changing. */
  themes: { darkMode: boolean; theme?: string };
  language: string;
  /** Present on any recent frontend; `language` is the fallback. */
  locale?: HassLocale;
  /** The services Home Assistant knows about, by domain. Without
   * `scribe.query` in it, the integration is missing or too old. */
  services?: Record<string, Record<string, unknown>>;
  /** The websocket, which the card uses only to remember a chosen range. */
  connection?: {
    sendMessagePromise<T = unknown>(message: Record<string, unknown>): Promise<T>;
  };
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

  /** Time ranges to offer, as `24h`, `7d`, `1y`. Needs `$__from`, `$__to` or
   * `$__interval` in the query; the choice is remembered per user. */
  ranges?: string[];
  /** Pins what the remembered range is filed under. Defaults to the query. */
  storage_key?: string;
  /** Offer the rows as a CSV file. On by default wherever the toolbar shows. */
  export?: boolean;

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
