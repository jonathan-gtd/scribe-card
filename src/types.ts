/** The little of Home Assistant's frontend API this card actually uses.
 *
 * Typed here rather than pulled from a helper package: three shapes, against a
 * dependency that would have to keep up with the frontend on its own.
 */

export interface HomeAssistant {
  themes: { darkMode: boolean };
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
  /** The query to run. Its rows are the chart. */
  sql: string;
  title?: string;
  /** Column holding the x value. Defaults to the first column named `time`, or the first column. */
  x?: string;
  /** Columns to draw. Defaults to every numeric column that is not the x one. */
  y?: string | string[];
  /** `line` (default), `area` or `bar`. */
  chart?: "line" | "area" | "bar";
  unit?: string;
  height?: number;
  /** Seconds between refreshes. 0, the default, only queries when the card loads. */
  refresh_interval?: number;
  /** Colours, in series order. Defaults to a palette that reads in both themes. */
  colors?: string[];
}

/** One row as `scribe.query` returns it. */
export type Row = Record<string, string | number | boolean | null>;
