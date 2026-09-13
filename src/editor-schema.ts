/** The form the visual editor shows, and what it does with what comes back.
 *
 * `ha-form` takes a schema and renders Home Assistant's own selectors from it,
 * so the editor looks like every other card editor and needs no styling of its
 * own. Both functions here are pure, which is what makes the editor testable
 * without a browser.
 */

import { PALETTE } from "./option";
import { DEFAULT_RANGES } from "./range";
import type { ScribeCardConfig } from "./types";

/** A list the form offers but does not close: anything valid can be typed. */
function open(values: string[], multiple = true): Schema["selector"] {
  return {
    select: {
      mode: "dropdown",
      multiple,
      custom_value: true,
      options: values.map((value) => ({ value, label: value })),
    },
  };
}

export interface Schema {
  name: string;
  /** For a field the schema builds rather than names in advance, such as one
   * colour picker per column the query returned. */
  label?: string;
  type?: string;
  /** `expandable` and `grid` nest their values under `name` unless told not
   * to; the card's configuration is flat and stays that way. */
  flatten?: boolean;
  title?: string;
  icon?: string;
  selector?: Record<string, unknown>;
  schema?: Schema[];
}

/** One tab of the editor: a name, and the fields under it. */
export interface Tab {
  id: string;
  label: string;
  icon: string;
  schema: Schema[];
}

/** The prefix of the per-column colour fields, which exist only in the form. */
const COLOUR = "color_";

/**
 * One colour picker per column the query returned.
 *
 * A list of hexadecimal codes asks someone to read `#0072b2` and to know which
 * series is third. Home Assistant's own colour picker asks for a colour, and
 * the column it belongs to is written on it. Before the query has run there
 * are no columns to offer, so the list is all there is.
 *
 * `drawn` and not every column the query returned: `colors` runs in the order
 * the series are drawn, and the column on the x axis is not one of them.
 */
function colourFields(drawn: string[]): Schema[] {
  if (!drawn.length) return [{ name: "colors", selector: open(PALETTE) }];
  return drawn.map((column, index) => ({
    name: `${COLOUR}${index}`,
    label: `Colour of ${column}`,
    selector: { ui_color: { include_none: true } },
  }));
}

/** A number nobody has to type units into. */
function number(name: string, unit?: string): Schema {
  return {
    name,
    selector: {
      number: { mode: "box", step: "any", ...(unit ? { unit_of_measurement: unit } : {}) },
    },
  };
}

/** Options for a column picker: what the query returned, or free text. */
function column(name: string, columns: string[], multiple = false): Schema {
  return columns.length
    ? {
        name,
        selector: {
          select: {
            mode: "dropdown",
            multiple,
            custom_value: true,
            options: columns.map((value) => ({ value, label: value })),
          },
        },
      }
    : { name, selector: { text: {} } };
}

/**
 * The form, in tabs.
 *
 * One list of twenty fields is a wall, and a grid of switches is worse than a
 * wall: `ha-form` puts a label at the left of its column and the switch at the
 * right, so two of them side by side read as "Zoom ——— [switch] Stacked ———
 * [switch]" and nobody can tell which belongs to which. Switches therefore get
 * a row to themselves, and everything else is grouped.
 *
 * Tabs are rendered by the editor; the sections inside them are
 * `ha-expansion-panel`, which `ha-form` provides. `flatten: true` keeps the
 * configuration flat, so none of this changes a line of anybody's YAML.
 *
 * `columns` are the columns the query came back with, once it has been run —
 * the editor offers them for the axes rather than asking someone to retype a
 * name they already wrote in the SQL.
 */
export function editorTabs(columns: string[] = [], drawn: string[] = []): Tab[] {
  return [
    {
      id: "query",
      label: "Query",
      icon: "mdi:database-search",
      schema: [
        { name: "title", selector: { text: {} } },
        { name: "sql", selector: { text: { multiline: true } } },
        {
          name: "columns",
          type: "expandable",
          flatten: true,
          title: "Columns",
          icon: "mdi:table-column",
          schema: [column("x", columns), column("y", columns, true)],
        },
      ],
    },
    {
      id: "chart",
      label: "Chart",
      icon: "mdi:chart-line",
      schema: [
        {
          name: "",
          type: "grid",
          schema: [
            {
              name: "chart",
              selector: {
                select: {
                  mode: "dropdown",
                  options: [
                    { value: "line", label: "Line" },
                    { value: "area", label: "Area" },
                    { value: "bar", label: "Bar" },
                    { value: "scatter", label: "Scatter" },
                  ],
                },
              },
            },
            { name: "unit", selector: { text: {} } },
            {
              name: "height",
              selector: {
                number: { min: 100, max: 1000, step: 10, mode: "box", unit_of_measurement: "px" },
              },
            },
            {
              name: "legend",
              selector: {
                select: {
                  mode: "dropdown",
                  options: [
                    { value: "auto", label: "When there are several" },
                    { value: "always", label: "Always" },
                    { value: "never", label: "Never" },
                  ],
                },
              },
            },
          ],
        },
        {
          name: "line",
          type: "expandable",
          flatten: true,
          title: "How the series are drawn",
          icon: "mdi:chart-bell-curve",
          schema: [
            {
              name: "step",
              selector: {
                select: {
                  mode: "dropdown",
                  options: [
                    { value: "", label: "Off" },
                    { value: "start", label: "Start" },
                    { value: "middle", label: "Middle" },
                    { value: "end", label: "End" },
                  ],
                },
              },
            },
            // A switch to a row: see the note above this function.
            { name: "fill", selector: { boolean: {} } },
            { name: "smooth", selector: { boolean: {} } },
            {
              // One control, not two that can disagree: stacking shares
              // without stacking makes no sense.
              name: "stack_mode",
              selector: {
                select: {
                  mode: "dropdown",
                  options: [
                    { value: "off", label: "Not stacked" },
                    { value: "total", label: "Stacked, by value" },
                    { value: "percent", label: "Stacked, by share of each moment" },
                  ],
                },
              },
            },
            {
              name: "",
              type: "grid",
              schema: [number("line_width", "px"), number("opacity")],
            },
            { name: "gradient", selector: { boolean: {} } },
            {
              name: "",
              type: "grid",
              schema: [
                {
                  name: "symbol",
                  selector: {
                    select: {
                      mode: "dropdown",
                      options: [
                        { value: "none", label: "None" },
                        { value: "circle", label: "Circle" },
                        { value: "emptyCircle", label: "Hollow circle" },
                        { value: "rect", label: "Square" },
                        { value: "triangle", label: "Triangle" },
                        { value: "diamond", label: "Diamond" },
                      ],
                    },
                  },
                },
                number("symbol_size", "px"),
              ],
            },
            { name: "connect_nulls", selector: { boolean: {} } },
            { name: "bar_width", selector: { text: {} } },
          ],
        },
        {
          name: "palette",
          type: "expandable",
          flatten: true,
          title: "Colours",
          icon: "mdi:palette",
          schema: colourFields(drawn),
        },
        {
          name: "byvalue",
          type: "expandable",
          flatten: true,
          title: "Colour by value",
          icon: "mdi:thermometer",
          schema: [
            { name: "", type: "grid", schema: [number("warn_above"), number("warn_below")] },
            { name: "warn_color", selector: { ui_color: {} } },
            { name: "", type: "grid", schema: [number("scale_from"), number("scale_to")] },
            { name: "scale_colors", selector: open(["blue", "green", "yellow", "orange", "red"]) },
          ],
        },
        {
          name: "marks",
          type: "expandable",
          flatten: true,
          title: "Lines across the chart",
          icon: "mdi:format-align-middle",
          schema: [
            { name: "mark_average", selector: { boolean: {} } },
            { name: "mark_max", selector: { boolean: {} } },
            { name: "mark_min", selector: { boolean: {} } },
            {
              name: "",
              type: "grid",
              schema: [number("threshold"), { name: "threshold_name", selector: { text: {} } }],
            },
          ],
        },
        {
          name: "reading",
          type: "expandable",
          flatten: true,
          title: "Reading the chart",
          icon: "mdi:magnify",
          schema: [
            { name: "labels", selector: { boolean: {} } },
            {
              name: "label_position",
              selector: {
                select: {
                  mode: "dropdown",
                  options: [
                    { value: "top", label: "Above" },
                    { value: "bottom", label: "Below" },
                    { value: "inside", label: "Inside" },
                    { value: "left", label: "Left" },
                    { value: "right", label: "Right" },
                  ],
                },
              },
            },
            {
              name: "",
              type: "grid",
              schema: [
                {
                  name: "legend_position",
                  selector: {
                    select: {
                      mode: "dropdown",
                      options: [
                        { value: "top", label: "Above" },
                        { value: "bottom", label: "Below" },
                        { value: "left", label: "Left" },
                        { value: "right", label: "Right" },
                      ],
                    },
                  },
                },
                {
                  name: "tooltip_trigger",
                  selector: {
                    select: {
                      mode: "dropdown",
                      options: [
                        { value: "axis", label: "Everything at that moment" },
                        { value: "item", label: "Only what is under the pointer" },
                        { value: "none", label: "Nothing" },
                      ],
                    },
                  },
                },
              ],
            },
            { name: "animation", selector: { boolean: {} } },
          ],
        },
      ],
    },
    {
      id: "axes",
      label: "Axes",
      icon: "mdi:axis-arrow",
      schema: [
        {
          name: "left",
          type: "expandable",
          flatten: true,
          title: "Left axis",
          icon: "mdi:format-vertical-align-center",
          schema: [
            { name: "y_name", selector: { text: {} } },
            { name: "", type: "grid", schema: [number("y_min"), number("y_max")] },
            number("decimals"),
            { name: "y_log", selector: { boolean: {} } },
          ],
        },
        {
          name: "right",
          type: "expandable",
          flatten: true,
          title: "Right axis",
          icon: "mdi:arrow-split-vertical",
          schema: [
            column("y2", columns, true),
            {
              name: "",
              type: "grid",
              schema: [
                { name: "y2_name", selector: { text: {} } },
                { name: "y2_unit", selector: { text: {} } },
              ],
            },
            { name: "", type: "grid", schema: [number("y2_min"), number("y2_max")] },
            { name: "y2_log", selector: { boolean: {} } },
          ],
        },
        {
          name: "bottom",
          type: "expandable",
          flatten: true,
          title: "X axis",
          icon: "mdi:format-horizontal-align-center",
          schema: [
            {
              name: "x_type",
              selector: {
                select: {
                  mode: "dropdown",
                  options: [
                    { value: "auto", label: "From the rows" },
                    { value: "time", label: "Times" },
                    { value: "number", label: "Numbers" },
                    { value: "category", label: "Labels" },
                  ],
                },
              },
            },
            { name: "x_name", selector: { text: {} } },
            number("x_rotate", "°"),
          ],
        },
        {
          name: "around",
          type: "expandable",
          flatten: true,
          title: "Around the chart",
          icon: "mdi:border-all-variant",
          schema: [
            { name: "split_lines", selector: { boolean: {} } },
            {
              name: "",
              type: "grid",
              schema: [
                number("margin_left", "px"),
                number("margin_right", "px"),
                number("margin_top", "px"),
                number("margin_bottom", "px"),
              ],
            },
          ],
        },
      ],
    },
    {
      id: "time",
      label: "Time & data",
      icon: "mdi:clock-outline",
      schema: [
        { name: "ranges", selector: open(DEFAULT_RANGES) },
        {
          name: "refresh_interval",
          selector: {
            number: { min: 0, max: 86400, step: 30, mode: "box", unit_of_measurement: "s" },
          },
        },
        { name: "zoom", selector: { boolean: {} } },
        {
          name: "sort",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "none", label: "As the query returned them" },
                { value: "asc", label: "Smallest first" },
                { value: "desc", label: "Largest first" },
              ],
            },
          },
        },
        {
          name: "remembering",
          type: "expandable",
          flatten: true,
          title: "Remembering the chosen range",
          icon: "mdi:content-save-outline",
          schema: [
            { name: "storage_key", selector: { text: {} } },
            { name: "sync_group", selector: { text: {} } },
          ],
        },
        { name: "export", selector: { boolean: {} } },
        { name: "debug", selector: { boolean: {} } },
      ],
    },
  ];
}

/** Every field of every tab, which is what the card is configured by. */
export function editorSchema(columns: string[] = [], drawn: string[] = []): Schema[] {
  return editorTabs(columns, drawn).flatMap((tab) => tab.schema);
}

/** What each field is called in the form. */
export const LABELS: Record<string, string> = {
  title: "Title",
  sql: "SQL query",
  chart: "Chart type",
  unit: "Unit",
  x: "X axis column",
  y: "Columns to draw",
  height: "Height",
  refresh_interval: "Refresh every",
  zoom: "Zoom",
  fill: "Filled",
  smooth: "Smooth line",
  step: "Steps",
  legend: "Legend",
  ranges: "Time ranges",
  colors: "Colours",
  export: "Offer a CSV",
  debug: "Show what it asked for",
  storage_key: "Remember under",
  sync_group: "Share a pointer with",
  y_name: "Name",
  y_min: "Minimum",
  y_max: "Maximum",
  y_log: "Logarithmic",
  decimals: "Decimals",
  y2: "Columns on the right",
  y2_name: "Name",
  y2_unit: "Unit",
  y2_min: "Minimum",
  y2_max: "Maximum",
  y2_log: "Logarithmic",
  x_type: "What it holds",
  x_name: "Name",
  x_rotate: "Turn the labels",
  split_lines: "Lines across the chart",
  margin_left: "Left",
  margin_right: "Right",
  margin_top: "Top",
  margin_bottom: "Bottom",
  line_width: "Line thickness",
  opacity: "Fill strength",
  gradient: "Fade the fill",
  symbol: "Mark each point",
  symbol_size: "Mark size",
  connect_nulls: "Join across gaps",
  bar_width: "Bar thickness",
  stack_mode: "Stack",
  sort: "Order",
  labels: "Write the values",
  label_position: "Written",
  mark_average: "The average",
  mark_max: "The highest",
  mark_min: "The lowest",
  threshold: "A line at",
  threshold_name: "Called",
  warn_above: "Warn above",
  warn_below: "Warn below",
  warn_color: "Warning colour",
  scale_from: "Scale from",
  scale_to: "Scale to",
  scale_colors: "Through",
  tooltip_trigger: "Tooltip shows",
  legend_position: "Legend",
  animation: "Animate",
};

/** A line of help under the fields that need one. */
export const HELPERS: Record<string, string> = {
  sql: "Any SELECT against your Scribe database. Group long ranges with time_bucket().",
  x: "Left empty, the first time-looking column is used.",
  y: "Left empty, every numeric column is drawn.",
  refresh_interval: "0 runs the query once, when the card loads.",
  step: "What a thermostat really does between two readings.",
  ranges: "Needs $__from, $__to or $__interval in the query. The choice is remembered.",
  colors: "In series order. Left empty, a palette that reads in both themes.",
  storage_key: "Left empty, the chosen range is filed under the query itself.",
  debug: "Rows, how long they took, and the query itself in the browser console.",
  sync_group: "Cards given the same name here mark the same moment as each other.",
  y2: "Drawn against their own axis, on the right. For a second unit in the same chart.",
  y_min: "Left empty, the axis fits the values.",
  decimals: "On the axis and in the tooltip. Left empty, as many as the value has.",
  y_log: "For values that span orders of magnitude.",
  x_type: "Left as it is, the rows decide. Change it when they decide wrong.",
  x_rotate: "For long labels that would otherwise overlap.",
  margin_left: "Room for the axis labels, in pixels.",
  opacity: "From 0 to 1. Only where something is filled.",
  connect_nulls: "A sensor that reported nothing did not report zero — join it anyway.",
  bar_width: "In pixels, or a percentage such as 60%.",
  stack_mode: "Shares are worked out across the columns on the left-hand axis only.",
  label_position: "Only where the values are written.",
  sort: "Only a chart of labels; a chart of times is already in order.",
  mark_average: "Drawn from the first column. Several averages is several lines.",
  threshold: "A limit, or a target. Left empty, no line.",
  animation: "Off by default: a chart that refreshes should not dance each time.",
  warn_above: "The first drawn column turns the warning colour past this value.",
  scale_from: "Or a gradient across a range of values instead. A warning wins over a scale.",
  scale_colors: "Coldest first. Left empty, blue to red.",
};

/**
 * The configuration to save, from what the form holds.
 *
 * A form hands back every field it showed, empty ones included; writing those
 * into the YAML would bury the two lines that matter under a dozen defaults.
 * So anything empty, and anything that is already the default, is dropped.
 */
export function cleanConfig(data: Record<string, unknown>, drawn: string[] = []): ScribeCardConfig {
  const DEFAULTS: Record<string, unknown> = {
    chart: "line",
    height: 250,
    refresh_interval: 0,
    zoom: false,
    stacked: false,
    fill: false,
    smooth: false,
    export: true,
    split_lines: true,
    y_log: false,
    y2_log: false,
    x_type: "auto",
    gradient: false,
    debug: false,
    connect_nulls: false,
    labels: false,
    animation: false,
    mark_average: false,
    mark_max: false,
    mark_min: false,
    sort: "none",
    legend_position: "top",
  };

  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    // The per-column pickers are gathered back into the list below.
    if (key.startsWith(COLOUR)) continue;
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    // The legend has three answers and the configuration has two, plus absent.
    // Stacking has one setting now, and "off" is the absence of it.
    if (key === "stacked") continue;
    if (key === "stack_mode" && value === "off") continue;
    if (key === "legend") {
      if (value !== "always" && value !== "never") continue;
      config.legend = value === "always";
      continue;
    }
    if (key in DEFAULTS && value === DEFAULTS[key]) continue;
    // A single column reads better than a list of one.
    const single = (key === "y" || key === "y2") && Array.isArray(value) && value.length === 1;
    config[key] = single ? (value as unknown[])[0] : value;
  }
  if (drawn.length) {
    // `none` is someone saying "whatever the palette says", which is an empty
    // slot; trailing empty slots are not worth writing down at all.
    const chosen = drawn.map((_, index) => {
      const picked = data[`${COLOUR}${index}`];
      return typeof picked === "string" && picked && picked !== "none" ? picked : "";
    });
    while (chosen.length && chosen[chosen.length - 1] === "") chosen.pop();
    if (chosen.length) config.colors = chosen;
    else delete config.colors;
  }

  config.type = data.type ?? "custom:scribe-card";
  return config as unknown as ScribeCardConfig;
}

/**
 * The configuration, as the form wants to receive it.
 *
 * The other direction of `cleanConfig`, and it has to exist: a form field
 * cannot hold "absent", and two of these mean something by it. The legend's
 * default is neither shown nor hidden, and a single column is written as
 * itself where the field expects a list of them.
 */
export function formData(
  config: Partial<ScribeCardConfig>,
  drawn: string[] = [],
): Record<string, unknown> {
  const { legend, y, y2, stacked, ...rest } = config;
  void stacked;
  const colours = config.colors ?? [];
  const asList = (value: string | string[] | undefined) =>
    value === undefined ? {} : { list: Array.isArray(value) ? value : [value] };
  return {
    ...rest,
    ...("list" in asList(y) ? { y: asList(y).list } : {}),
    ...("list" in asList(y2) ? { y2: asList(y2).list } : {}),
    legend: legend === undefined ? "auto" : legend ? "always" : "never",
    // Two more whose default is not what an unticked box means.
    export: config.export ?? true,
    split_lines: config.split_lines ?? true,
    // `stacked` said the same thing in fewer words; the form shows one answer.
    stack_mode: config.stack_mode ?? (config.stacked ? "total" : "off"),
    // One field per column, out of the list the configuration keeps.
    ...Object.fromEntries(drawn.map((_, index) => [`${COLOUR}${index}`, colours[index] ?? ""])),
  };
}
