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
  /** Show what the card asked for and what came back, and log the query. For
   * working out why a card behaves oddly on somebody else's dashboard. */
  debug?: boolean;

  // --- How the series are drawn --------------------------------------------

  /** Thickness of the line, in pixels. */
  line_width?: number;
  /** How solid the fill under a line is, from 0 to 1. */
  opacity?: number;
  /** Fade the fill towards the bottom instead of a flat wash. */
  gradient?: boolean;
  /** A mark on every point: `none`, `circle`, `emptyCircle`, `rect`, `triangle`, `diamond`. */
  symbol?: string;
  symbol_size?: number;
  /** Join across gaps instead of leaving the line broken. */
  connect_nulls?: boolean;
  /** Bar thickness, in pixels or as a percentage such as `60%`. */
  bar_width?: number | string;
  /** `total` stacks the values; `percent` stacks their share of each moment. */
  stack_mode?: "total" | "percent";
  /** Sort a chart of labels by its first drawn column. */
  sort?: "none" | "asc" | "desc";

  /** Write the value beside each point. */
  labels?: boolean;
  label_position?: string;

  // --- Colour by value ------------------------------------------------------

  /** Draw the first column in `warn_color` above this value — a limit passed. */
  warn_above?: number;
  /** And below this one — freezing, or a battery running out. */
  warn_below?: number;
  /** What "past the limit" looks like. Defaults to red. */
  warn_color?: string;
  /** A gradient across a range of values instead of a threshold. */
  scale_from?: number;
  scale_to?: number;
  /** The colours it runs through, coldest first. */
  scale_colors?: string[];

  // --- Marker lines ---------------------------------------------------------

  /** A dashed line across the chart at the first column's average, highest or
   * lowest value. */
  mark_average?: boolean;
  mark_max?: boolean;
  mark_min?: boolean;
  /** A line at a value of your own — a limit, a target. */
  threshold?: number;
  threshold_name?: string;

  // --- The rest of the chart ------------------------------------------------

  /** `axis` shows everything at that instant, `item` only what is under the
   * pointer, `none` shows nothing. */
  tooltip_trigger?: "axis" | "item" | "none";
  legend_position?: "top" | "bottom" | "left" | "right";
  /** Off by default: a chart that redraws every thirty seconds should not
   * dance each time. */
  animation?: boolean;

  // --- Axes ----------------------------------------------------------------

  /** Columns to draw against a second axis, on the right. */
  y2?: string | string[];
  /** What the left axis is called. Defaults to `unit`. */
  y_name?: string;
  y_min?: number;
  y_max?: number;
  /** A logarithmic axis, for values that span orders of magnitude. */
  y_log?: boolean;
  /** The same, for the right-hand axis. */
  y2_name?: string;
  y2_unit?: string;
  y2_min?: number;
  y2_max?: number;
  y2_log?: boolean;

  /** Decimals on the axis labels and in the tooltip. */
  decimals?: number;
  /** What the x axis holds, when guessing from the rows gets it wrong. */
  x_type?: "auto" | "time" | "number" | "category";
  x_name?: string;
  /** Degrees to turn the x labels by, for long names that overlap. */
  x_rotate?: number;
  /** Horizontal lines across the chart. On by default. */
  split_lines?: boolean;
  /** Room around the chart, in pixels. */
  margin_left?: number;
  margin_right?: number;
  margin_top?: number;
  margin_bottom?: number;

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
