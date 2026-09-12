/** The form the visual editor shows, and what it does with what comes back.
 *
 * `ha-form` takes a schema and renders Home Assistant's own selectors from it,
 * so the editor looks like every other card editor and needs no styling of its
 * own. Both functions here are pure, which is what makes the editor testable
 * without a browser.
 */

import type { ScribeCardConfig } from "./types";

export interface Schema {
  name: string;
  type?: string;
  selector?: Record<string, unknown>;
  schema?: Schema[];
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
 * The editor form.
 *
 * `columns` are the columns the query came back with, once it has been run —
 * the editor offers them for the axes rather than asking someone to retype a
 * name they already wrote in the SQL.
 */
export function editorSchema(columns: string[] = []): Schema[] {
  return [
    { name: "title", selector: { text: {} } },
    { name: "sql", selector: { text: { multiline: true } } },
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
        column("x", columns),
        column("y", columns, true),
        {
          name: "height",
          selector: {
            number: { min: 100, max: 1000, step: 10, mode: "box", unit_of_measurement: "px" },
          },
        },
        {
          name: "refresh_interval",
          selector: {
            number: { min: 0, max: 86400, step: 30, mode: "box", unit_of_measurement: "s" },
          },
        },
      ],
    },
    {
      name: "",
      type: "grid",
      schema: [
        { name: "zoom", selector: { boolean: {} } },
        { name: "stacked", selector: { boolean: {} } },
        { name: "fill", selector: { boolean: {} } },
        { name: "smooth", selector: { boolean: {} } },
      ],
    },
  ];
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
};

/** A line of help under the fields that need one. */
export const HELPERS: Record<string, string> = {
  sql: "Any SELECT against your Scribe database. Group long ranges with time_bucket().",
  x: "Left empty, the first time-looking column is used.",
  y: "Left empty, every numeric column is drawn.",
  refresh_interval: "0 runs the query once, when the card loads.",
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
  };

  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (key in DEFAULTS && value === DEFAULTS[key]) continue;
    // A single column reads better than a list of one.
    config[key] = key === "y" && Array.isArray(value) && value.length === 1 ? value[0] : value;
  }
  config.type = data.type ?? "custom:scribe-card";
  return config as unknown as ScribeCardConfig;
}
