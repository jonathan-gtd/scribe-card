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
export function editorTabs(columns: string[] = []): Tab[] {
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
            { name: "stacked", selector: { boolean: {} } },
            { name: "colors", selector: open(PALETTE) },
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
          name: "remembering",
          type: "expandable",
          flatten: true,
          title: "Remembering the chosen range",
          icon: "mdi:content-save-outline",
          schema: [{ name: "storage_key", selector: { text: {} } }],
        },
        { name: "export", selector: { boolean: {} } },
      ],
    },
  ];
}

/** Every field of every tab, which is what the card is configured by. */
export function editorSchema(columns: string[] = []): Schema[] {
  return editorTabs(columns).flatMap((tab) => tab.schema);
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
  stacked: "Stacked",
  fill: "Filled",
  smooth: "Smooth line",
  step: "Steps",
  legend: "Legend",
  ranges: "Time ranges",
  colors: "Colours",
  export: "Offer a CSV",
  storage_key: "Remember under",
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
};

/**
 * The configuration to save, from what the form holds.
 *
 * A form hands back every field it showed, empty ones included; writing those
 * into the YAML would bury the two lines that matter under a dozen defaults.
 * So anything empty, and anything that is already the default, is dropped.
 */
export function cleanConfig(data: Record<string, unknown>): ScribeCardConfig {
  const DEFAULTS: Record<string, unknown> = {
    chart: "line",
    height: 250,
    refresh_interval: 0,
    zoom: false,
    stacked: false,
    fill: false,
    smooth: false,
    export: true,
  };

  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    // The legend has three answers and the configuration has two, plus absent.
    if (key === "legend") {
      if (value !== "always" && value !== "never") continue;
      config.legend = value === "always";
      continue;
    }
    if (key in DEFAULTS && value === DEFAULTS[key]) continue;
    // A single column reads better than a list of one.
    config[key] = key === "y" && Array.isArray(value) && value.length === 1 ? value[0] : value;
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
export function formData(config: Partial<ScribeCardConfig>): Record<string, unknown> {
  const { legend, y, ...rest } = config;
  return {
    ...rest,
    ...(y === undefined ? {} : { y: Array.isArray(y) ? y : [y] }),
    legend: legend === undefined ? "auto" : legend ? "always" : "never",
    export: config.export ?? true,
  };
}
