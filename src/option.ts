/** The card's configuration, as an ECharts option.
 *
 * Two layers, on purpose. A card that says `sql:` and nothing else must draw
 * something sensible; a card that wants a dashed line, a second axis or a log
 * scale says so **in ECharts' own words**, through `options:` and `series:`,
 * which are merged over what is built here. Anything from the ECharts
 * documentation therefore works, which is the point of using it.
 *
 * Pure: no DOM, no ECharts import. It is the part worth testing.
 */

import { numberFormatter, timeLevels, usesAmPm } from "./locale";
import type { Chart, Series } from "./series";
import type { HassLocale, ScribeCardConfig } from "./types";

/** Marks an option an ECharts function has to replace, which plain data cannot
 * carry. `resolveFormatters` swaps them for the real thing. */
const VALUE = "__value__";
const NUMBER = "__number__";
const TIME = "__time__";

/** A marker, with what the formatter it stands for will need. */
function mark(kind: string, settings: Record<string, unknown>): string {
  return kind + JSON.stringify(settings);
}

/** Points past which a chart is drawn differently, because it has to be. */
const CROWDED = 2000;

/** Readable on both themes, and distinguishable for the commonest colour blindness. */
export const PALETTE = [
  "#0072b2",
  "#e69f00",
  "#009e73",
  "#cc79a7",
  "#d55e00",
  "#56b4e9",
  "#f0e442",
  "#8c8c8c",
];

export interface Theme {
  text: string;
  secondaryText: string;
  grid: string;
  background: string;
}

type Dict = Record<string, unknown>;

/** One name or several, which is how every column option is written. */
export function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** A number the configuration gave, or nothing — `0` is a number. */
function orNothing(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Merge `over` into `base`, the way a user expects options to be overridden. */
export function merge<T extends Dict>(base: T, over: Dict | undefined): T {
  if (!over) return base;
  const result: Dict = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = result[key];
    const mergeable =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current);
    result[key] = mergeable ? merge(current as Dict, value as Dict) : value;
  }
  return result as T;
}

/** Where the legend sits, and which way it runs when it is beside the chart. */
function legendPlace(where: string): Dict {
  switch (where) {
    case "bottom":
      return { bottom: 0, left: "center" };
    case "left":
      return { left: 0, top: "middle", orient: "vertical" };
    case "right":
      return { right: 0, top: "middle", orient: "vertical" };
    default:
      return { top: 0, left: "center" };
  }
}

/** Room around the chart. The slider under a zoomable chart needs its own. */
function margins(config: ScribeCardConfig, zoomed: boolean): Dict {
  return {
    left: config.margin_left ?? 8,
    right: config.margin_right ?? 12,
    top: config.margin_top ?? 12,
    bottom: config.margin_bottom ?? (zoomed ? 28 : 8),
    containLabel: true,
  };
}

/** The fill under a line: a flat wash, or one that fades towards the bottom. */
function fillStyle(colour: string, config: ScribeCardConfig): Dict {
  if (!config.gradient) return { color: colour, opacity: config.opacity ?? 0.18 };
  // A gradient carries its own fading towards the bottom, so the flat opacity
  // of a plain fill would fade it twice.
  return {
    opacity: config.opacity ?? 0.55,
    color: {
      type: "linear",
      x: 0,
      y: 0,
      x2: 0,
      y2: 1,
      colorStops: [
        { offset: 0, color: colour },
        { offset: 1, color: "transparent" },
      ],
    },
  };
}

/**
 * The lines drawn across the chart.
 *
 * On the first series only: an average line per series turns four series into
 * twelve lines, and a threshold belongs to the chart rather than to any one
 * column of it.
 */
function markLines(config: ScribeCardConfig, theme: Theme): Dict | undefined {
  const data: Dict[] = [];
  if (config.mark_average) data.push({ type: "average", name: "Average" });
  if (config.mark_max) data.push({ type: "max", name: "Highest" });
  if (config.mark_min) data.push({ type: "min", name: "Lowest" });
  if (typeof config.threshold === "number" && Number.isFinite(config.threshold)) {
    data.push({ yAxis: config.threshold, name: config.threshold_name ?? "Limit" });
  }
  if (!data.length) return undefined;

  return {
    silent: true,
    symbol: "none",
    data,
    lineStyle: { color: theme.secondaryText, type: "dashed", width: 1 },
    label: { color: theme.secondaryText, formatter: "{b}", position: "insideEndTop" },
  };
}

function seriesOption(
  series: Series,
  index: number,
  chart: Chart,
  config: ScribeCardConfig,
  theme: Theme,
): Dict {
  const colours = config.colors ?? PALETTE;
  const colour = colours[index % colours.length];
  const type = config.chart === "bar" ? "bar" : config.chart === "scatter" ? "scatter" : "line";
  // Stacked lines that are not filled read as a tangle: what is stacked is an
  // area, whatever it is called.
  const filled =
    config.fill ?? (config.chart === "area" || (config.stacked === true && type === "line"));
  // Past a few thousand points the canvas slows down and the drawing gains
  // nothing: LTTB keeps the shape of a line with far fewer of them.
  const crowded = chart.x.length > CROWDED;
  const symbol = config.symbol ?? "circle";
  const marks = index === 0 ? markLines(config, theme) : undefined;

  const base: Dict = {
    name: series.name,
    type,
    // A column named on the right-hand axis is drawn against it, and carries
    // that axis's unit into the tooltip: one unit for both would be a lie.
    ...(toList(config.y2).includes(series.name)
      ? {
          yAxisIndex: 1,
          tooltip: {
            valueFormatter: mark(VALUE, {
              unit: config.y2_unit ?? config.unit ?? "",
              decimals: config.decimals,
            }),
          },
        }
      : {}),
    // A time or number axis wants pairs; a category axis reads them in order.
    data:
      chart.kind === "category"
        ? series.values
        : series.values.map((value, i) => [chart.x[i], value]),
    itemStyle: { color: colour },
    ...(type === "line"
      ? {
          // Points on every sample turn a year of history into soup; the line
          // carries the shape, and hovering still finds the value. Asking for
          // a symbol is asking to see them.
          showSymbol:
            (config.symbol !== undefined || config.symbol_size !== undefined) && symbol !== "none",
          symbol: symbol === "none" ? "circle" : symbol,
          symbolSize: config.symbol_size ?? 6,
          smooth: config.smooth ?? false,
          lineStyle: { width: config.line_width ?? 2, color: colour },
          ...(filled ? { areaStyle: fillStyle(colour, config) } : {}),
          ...(config.step ? { step: config.step } : {}),
          ...(crowded ? { sampling: "lttb" } : {}),
          ...(config.connect_nulls ? { connectNulls: true } : {}),
        }
      : crowded
        ? { large: true }
        : {}),
    ...(type === "bar" && config.bar_width !== undefined ? { barWidth: config.bar_width } : {}),
    ...(type === "scatter"
      ? { symbol: symbol === "none" ? "circle" : symbol, symbolSize: config.symbol_size ?? 10 }
      : {}),
    ...(config.stacked || config.stack_mode ? { stack: "total" } : {}),
    ...(config.labels
      ? {
          label: {
            show: true,
            position: config.label_position ?? (type === "bar" ? "top" : "top"),
            color: theme.text,
            formatter: mark(VALUE, { unit: config.unit ?? "", decimals: config.decimals }),
          },
        }
      : {}),
    ...(marks ? { markLine: marks } : {}),
  };

  // `series:` takes ECharts series options, by column name.
  return merge(base, config.series?.[series.name]);
}

export function buildOption(chart: Chart, config: ScribeCardConfig, theme: Theme): Dict {
  const unit = config.unit ?? "";
  const axisLine = { lineStyle: { color: theme.grid } };
  const splitLine = {
    show: config.split_lines ?? true,
    lineStyle: { color: theme.grid, type: "dashed" },
  };

  const xAxis: Dict = {
    type: chart.kind === "time" ? "time" : chart.kind === "number" ? "value" : "category",
    ...(chart.kind === "category" ? { data: chart.x } : {}),
    ...(config.x_name
      ? { name: config.x_name, nameTextStyle: { color: theme.secondaryText } }
      : {}),
    axisLine,
    axisLabel: {
      color: theme.secondaryText,
      hideOverlap: true,
      ...(chart.kind === "time" ? { formatter: TIME } : {}),
      // Long entity names on a bar chart overlap until they are turned.
      ...(orNothing(config.x_rotate) !== undefined ? { rotate: config.x_rotate } : {}),
    },
    splitLine: { show: false },
  };

  /** One value axis, left or right. They differ only in where they sit. */
  const valueAxis = (side: "left" | "right"): Dict => {
    const right = side === "right";
    const name = right ? (config.y2_name ?? config.y2_unit) : (config.y_name ?? unit);
    return {
      type: (right ? config.y2_log : config.y_log) ? "log" : "value",
      ...(right ? { position: "right" } : {}),
      name: name || undefined,
      nameTextStyle: { color: theme.secondaryText },
      min: orNothing(right ? config.y2_min : config.y_min),
      max: orNothing(right ? config.y2_max : config.y_max),
      axisLine: { show: false },
      axisLabel: {
        color: theme.secondaryText,
        formatter: mark(NUMBER, { decimals: config.decimals }),
      },
      // Two sets of horizontal lines at different heights is a mess; only the
      // left axis draws them.
      splitLine: right ? { show: false } : splitLine,
    };
  };

  const option: Dict = {
    // The card draws its own header, and a chart title would sit under it.
    backgroundColor: "transparent",
    // A chart that redraws every thirty seconds should not dance each time.
    animation: config.animation ?? false,
    grid: margins(config, false),
    tooltip: {
      ...(config.tooltip_trigger === "none" ? { show: false } : {}),
      // Everything at that instant, which is what a history chart is read for.
      trigger: config.tooltip_trigger ?? (chart.kind === "category" ? "item" : "axis"),
      axisPointer: { type: "line", lineStyle: { color: theme.secondaryText } },
      valueFormatter: mark(VALUE, { unit, decimals: config.decimals }),
    },
    legend: {
      show: config.legend ?? chart.series.length > 1,
      ...legendPlace(config.legend_position ?? "top"),
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: theme.secondaryText },
    },
    xAxis,
    // A second axis only exists when something is drawn against it.
    yAxis: toList(config.y2).length ? [valueAxis("left"), valueAxis("right")] : valueAxis("left"),
    series: chart.series.map((series, index) => seriesOption(series, index, chart, config, theme)),
    ...(config.zoom
      ? {
          // Drag to zoom, wheel to scale — what makes a long history readable.
          dataZoom: [
            { type: "inside", throttle: 50 },
            { type: "slider", height: 18, bottom: 0, borderColor: theme.grid },
          ],
          grid: margins(config, true),
        }
      : {}),
  };

  return merge(option, config.options);
}

/**
 * The formatters, which an option object cannot carry as functions.
 *
 * `buildOption` marks them with strings so that the whole option stays plain
 * data — comparable in a test, and mergeable — and the card turns the marks
 * into what ECharts calls: the dashboard's own way of writing numbers, and its
 * own clock on the time axis.
 *
 * The whole option is walked rather than a list of places being visited, so a
 * mark put anywhere — on a series of its own, on an axis a configuration
 * added — is found.
 */
export function resolveFormatters(option: Dict, locale?: HassLocale): Dict {
  const number = numberFormatter(locale);
  const levels = timeLevels(usesAmPm(locale));

  /** What a mark stands for, or nothing if the string is not one. */
  const resolve = (value: string): unknown => {
    if (value === TIME || value.startsWith(TIME)) return levels;

    const kind = value.startsWith(VALUE) ? VALUE : value.startsWith(NUMBER) ? NUMBER : undefined;
    if (!kind) return undefined;

    let settings: { unit?: string; decimals?: number } = {};
    try {
      settings = JSON.parse(value.slice(kind.length) || "{}");
    } catch {
      // A mark nobody wrote; leave the string alone below.
      return undefined;
    }

    const write = (raw: unknown) => {
      if (raw === null || raw === undefined) return "—";
      const count = settings.decimals;
      const rounded =
        typeof count === "number" && Number.isFinite(Number(raw))
          ? Number(Number(raw).toFixed(count))
          : raw;
      return number(rounded);
    };

    if (kind === NUMBER) return (raw: unknown) => write(raw);
    const unit = settings.unit ?? "";
    return (raw: unknown) =>
      raw === null || raw === undefined ? "—" : `${write(raw)}${unit ? ` ${unit}` : ""}`;
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Dict)) {
      if (typeof value === "string") {
        const resolved = resolve(value);
        if (resolved !== undefined) (node as Dict)[key] = resolved;
      } else {
        walk(value);
      }
    }
  };

  walk(option);
  return option;
}
