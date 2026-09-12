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

import type { Chart, Series } from "./series";
import type { ScribeCardConfig } from "./types";

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

function seriesOption(series: Series, index: number, chart: Chart, config: ScribeCardConfig): Dict {
  const colours = config.colors ?? PALETTE;
  const colour = colours[index % colours.length];
  const type = config.chart === "bar" ? "bar" : config.chart === "scatter" ? "scatter" : "line";
  const filled = config.fill ?? config.chart === "area";

  const base: Dict = {
    name: series.name,
    type,
    // A time or number axis wants pairs; a category axis reads them in order.
    data:
      chart.kind === "category"
        ? series.values
        : series.values.map((value, i) => [chart.x[i], value]),
    itemStyle: { color: colour },
    ...(type === "line"
      ? {
          // Points on every sample turn a year of history into soup; the line
          // carries the shape, and hovering still finds the value.
          showSymbol: false,
          symbolSize: 6,
          smooth: config.smooth ?? false,
          lineStyle: { width: 2, color: colour },
          ...(filled ? { areaStyle: { color: colour, opacity: 0.18 } } : {}),
          ...(config.step ? { step: config.step } : {}),
        }
      : {}),
    ...(config.stacked ? { stack: "total" } : {}),
  };

  // `series:` takes ECharts series options, by column name.
  return merge(base, config.series?.[series.name]);
}

export function buildOption(chart: Chart, config: ScribeCardConfig, theme: Theme): Dict {
  const unit = config.unit ?? "";
  const axisLine = { lineStyle: { color: theme.grid } };
  const splitLine = { lineStyle: { color: theme.grid, type: "dashed" } };

  const xAxis: Dict = {
    type: chart.kind === "time" ? "time" : chart.kind === "number" ? "value" : "category",
    ...(chart.kind === "category" ? { data: chart.x } : {}),
    axisLine,
    axisLabel: { color: theme.secondaryText, hideOverlap: true },
    splitLine: { show: false },
  };

  const option: Dict = {
    // The card draws its own header, and a chart title would sit under it.
    backgroundColor: "transparent",
    animation: false,
    grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
    tooltip: {
      // Everything at that instant, which is what a history chart is read for.
      trigger: chart.kind === "category" ? "item" : "axis",
      axisPointer: { type: "line", lineStyle: { color: theme.secondaryText } },
      valueFormatter: unit ? `__unit__${unit}` : undefined,
    },
    legend: {
      show: config.legend ?? chart.series.length > 1,
      top: 0,
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: theme.secondaryText },
    },
    xAxis,
    yAxis: {
      type: "value",
      name: unit || undefined,
      nameTextStyle: { color: theme.secondaryText },
      axisLine: { show: false },
      axisLabel: { color: theme.secondaryText },
      splitLine,
    },
    series: chart.series.map((series, index) => seriesOption(series, index, chart, config)),
    ...(config.zoom
      ? {
          // Drag to zoom, wheel to scale — what makes a long history readable.
          dataZoom: [
            { type: "inside", throttle: 50 },
            { type: "slider", height: 18, bottom: 0, borderColor: theme.grid },
          ],
          grid: { left: 8, right: 12, top: 12, bottom: 28, containLabel: true },
        }
      : {}),
  };

  return merge(option, config.options);
}

/**
 * The value formatter, which an option object cannot carry as a function.
 *
 * `buildOption` marks it with a string so that the whole option stays plain
 * data — comparable in a test, and mergeable — and the card turns the mark
 * into the function ECharts calls.
 */
export function resolveFormatters(option: Dict): Dict {
  const tooltip = option.tooltip as Dict | undefined;
  const marked = tooltip?.valueFormatter;
  if (typeof marked === "string" && marked.startsWith("__unit__")) {
    const unit = marked.slice("__unit__".length);
    tooltip!.valueFormatter = (value: unknown) =>
      value === null || value === undefined ? "—" : `${value} ${unit}`;
  }
  return option;
}
