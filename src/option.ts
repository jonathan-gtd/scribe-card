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
  /** Turns a colour Home Assistant has a name for — `red`, `primary` — into
   * the colour the current theme gives it. */
  colour?: (name: string) => string;
}

/**
 * A colour as ECharts needs it.
 *
 * Home Assistant names its colours, and a theme decides what they look like,
 * so a card that says `red` follows the dashboard instead of being stuck at
 * one particular red. Anything already written as a colour — a hex triple,
 * `rgb(…)` — is left alone, and a name nothing answers for is handed over
 * untouched rather than dropped.
 */
export function resolveColour(value: string, lookup?: (name: string) => string): string {
  if (!value || /^(#|rgb|hsl|transparent)/i.test(value)) return value;
  return lookup?.(value) || value;
}

type Dict = Record<string, unknown>;

/**
 * How the series are stacked, from the two settings that can say so.
 *
 * `stacked` came first and is a boolean; `stack_mode` came later and can also
 * ask for shares. Stacking shares without stacking makes no sense, so naming a
 * mode is asking to stack.
 */
export function stacking(config: ScribeCardConfig): "total" | "percent" | undefined {
  return config.stack_mode ?? (config.stacked ? "total" : undefined);
}

/** The columns drawn against the right-hand axis, of those actually drawn. */
export function rightHand(chart: Chart, config: ScribeCardConfig): string[] {
  const asked = toList(config.y2);
  return chart.series.map((one) => one.name).filter((name) => asked.includes(name));
}

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

/**
 * Colour taken from the value rather than from the series.
 *
 * Two shapes, and a threshold wins over a range: past a limit the line turns a
 * colour, or it runs through a gradient between two values. On the first column
 * left on the left-hand axis, like the lines across the chart — a gradient over
 * several series would leave nothing to tell them apart by.
 */
function colourByValue(chart: Chart, config: ScribeCardConfig, theme: Theme): Dict | undefined {
  const right = rightHand(chart, config);
  const index = chart.series.findIndex((one) => !right.includes(one.name));
  if (index < 0) return undefined;

  const colours = config.colors ?? PALETTE;
  const base = resolveColour(colours[index % colours.length], theme.colour);
  const common = { show: false, seriesIndex: index, outOfRange: { color: base } };

  const above = orNothing(config.warn_above);
  const below = orNothing(config.warn_below);
  if (above !== undefined || below !== undefined) {
    const warn = resolveColour(config.warn_color ?? "red", theme.colour);
    return {
      ...common,
      type: "piecewise",
      pieces: [
        ...(below !== undefined ? [{ lt: below, color: warn }] : []),
        ...(above !== undefined ? [{ gt: above, color: warn }] : []),
      ],
    };
  }

  const from = orNothing(config.scale_from);
  const to = orNothing(config.scale_to);
  if (from === undefined || to === undefined || to <= from) return undefined;
  return {
    ...common,
    type: "continuous",
    min: from,
    max: to,
    inRange: {
      color: (config.scale_colors ?? ["blue", "red"]).map((one) =>
        resolveColour(one, theme.colour),
      ),
    },
  };
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
  const colour = resolveColour(colours[index % colours.length], theme.colour);
  const type = config.chart === "bar" ? "bar" : config.chart === "scatter" ? "scatter" : "line";
  // Stacked lines that are not filled read as a tangle: what is stacked is an
  // area, whatever it is called.
  const filled =
    config.fill ?? (config.chart === "area" || (stacking(config) !== undefined && type === "line"));
  // Past a few thousand points the canvas slows down and the drawing gains
  // nothing: LTTB keeps the shape of a line with far fewer of them.
  const crowded = chart.x.length > CROWDED;
  const symbol = config.symbol ?? "circle";
  // On the first series left on the left-hand axis: an average drawn against
  // the right-hand one is an average of something else entirely.
  const right = rightHand(chart, config);
  const firstLeft = chart.series.findIndex((one) => !right.includes(one.name));
  const marks = index === firstLeft ? markLines(config, theme) : undefined;

  const base: Dict = {
    name: series.name,
    type,
    // A column named on the right-hand axis is drawn against it, and carries
    // that axis's unit into the tooltip: one unit for both would be a lie.
    ...(right.includes(series.name)
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
    ...(stacking(config) ? { stack: "total" } : {}),
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
  // What is drawn in percent mode is a share of each moment, so the unit the
  // values were measured in is no longer what the axis carries.
  const byValue = colourByValue(chart, config, theme);
  const shares = stacking(config) === "percent";
  const unit = shares ? "%" : (config.unit ?? "");
  const right = rightHand(chart, config);
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
    const onRight = side === "right";
    const name = onRight ? (config.y2_name ?? config.y2_unit) : (config.y_name ?? unit);
    // A share runs from nothing to everything, unless told otherwise.
    const floor = shares && !onRight ? 0 : undefined;
    const ceiling = shares && !onRight ? 100 : undefined;
    return {
      type: (onRight ? config.y2_log : config.y_log) ? "log" : "value",
      ...(onRight ? { position: "right" } : {}),
      name: name || undefined,
      nameTextStyle: { color: theme.secondaryText },
      min: orNothing(onRight ? config.y2_min : config.y_min) ?? floor,
      max: orNothing(onRight ? config.y2_max : config.y_max) ?? ceiling,
      axisLine: { show: false },
      axisLabel: {
        color: theme.secondaryText,
        formatter: mark(NUMBER, { decimals: config.decimals }),
      },
      // Two sets of horizontal lines at different heights is a mess; only the
      // left axis draws them.
      splitLine: onRight ? { show: false } : splitLine,
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
    // A second axis only exists when something drawn actually goes to it: a
    // `y2` naming a column the query no longer returns is an empty axis.
    yAxis: right.length ? [valueAxis("left"), valueAxis("right")] : valueAxis("left"),
    series: chart.series.map((series, index) => seriesOption(series, index, chart, config, theme)),
    ...(byValue ? { visualMap: byValue } : {}),
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
