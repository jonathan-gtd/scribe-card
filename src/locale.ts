/** Home Assistant's idea of dates and numbers, in ECharts' words.
 *
 * A dashboard is read in the language and the conventions its owner chose, and
 * Home Assistant already knows both: `hass.locale` carries the language, the
 * number format and whether the clock is on twelve hours or twenty-four. None
 * of that reached the chart, which formatted everything the way ECharts does
 * out of the box — English month names, a twenty-four hour clock and a full
 * stop for a decimal separator.
 *
 * Rather than bundle ECharts' thirty locale packs for the one the browser
 * needs, the month and weekday names are built from `Intl` at runtime, for
 * whatever language Home Assistant is in.
 *
 * Pure: no DOM, no ECharts import.
 */

import type { HassLocale } from "./types";

/** ECharts' leveled time labels: which format each zoom level uses. */
export interface TimeLevels {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  millisecond: string;
  none: string;
}

export interface EChartsLocale {
  time: {
    month: string[];
    monthAbbr: string[];
    dayOfWeek: string[];
    dayOfWeekAbbr: string[];
  };
}

/**
 * The locales `Intl` should use, which is the mapping Home Assistant itself
 * applies: a number format names the convention, not the language, and
 * `system` means "whatever the browser is set to".
 */
export function numberLocales(locale?: HassLocale): string[] | undefined {
  switch (locale?.number_format) {
    case "comma_decimal":
      return ["en-US", "en"];
    case "decimal_comma":
      return ["de", "es", "it"];
    case "space_comma":
      return ["fr", "sv", "cs"];
    case "quote_decimal":
      return ["de-CH"];
    case "system":
      return undefined;
    default:
      return locale?.language ? [locale.language] : undefined;
  }
}

/** Formats a number the way the dashboard writes numbers. */
export function numberFormatter(locale?: HassLocale): (value: unknown) => string {
  // `none` is someone asking for the digits they wrote, untouched.
  if (locale?.number_format === "none") {
    return (value) => (value === null || value === undefined ? "" : String(value));
  }
  let format: Intl.NumberFormat | undefined;
  try {
    format = new Intl.NumberFormat(numberLocales(locale), { maximumFractionDigits: 3 });
  } catch {
    format = undefined;
  }
  return (value) => {
    if (value === null || value === undefined || value === "") return "";
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return format ? format.format(number) : String(number);
  };
}

/**
 * Whether the clock is on twelve hours.
 *
 * `language` and `system` mean "ask the locale", which Home Assistant does by
 * formatting a known hour and looking at what came back.
 */
export function usesAmPm(locale?: HassLocale): boolean {
  if (locale?.time_format === "am_pm") return true;
  if (locale?.time_format === "twenty_four") return false;
  const language = locale?.time_format === "system" ? undefined : locale?.language;
  try {
    // Ten at night is "22" on a twenty-four hour clock, and "10 PM" otherwise.
    return !new Date(2021, 0, 1, 22)
      .toLocaleTimeString(language, { hour: "numeric" })
      .includes("22");
  } catch {
    return false;
  }
}

/**
 * ECharts' own leveled time formats, with the clock the dashboard uses.
 *
 * The levels are what keeps a time axis readable as it is zoomed: hours while
 * a day is on screen, a date when a month is, a year when a decade is. Only
 * the clock changes here — the rest is what ECharts already does.
 */
export function timeLevels(amPm: boolean): TimeLevels {
  const hour = amPm ? "{h}:{mm} {A}" : "{HH}:{mm}";
  return {
    year: "{yyyy}",
    month: "{MMM}",
    day: "{d} {MMM}",
    hour,
    minute: hour,
    second: amPm ? "{h}:{mm}:{ss} {A}" : "{HH}:{mm}:{ss}",
    millisecond: amPm ? "{h}:{mm}:{ss} {SSS}" : "{HH}:{mm}:{ss} {SSS}",
    none: "{yyyy}-{MM}-{dd} {HH}:{mm}:{ss}",
  };
}

/**
 * The month and weekday names ECharts needs, in the dashboard's language.
 *
 * ECharts ships a locale pack per language; this builds the same thing from
 * `Intl` instead, so every language Home Assistant speaks is covered and none
 * of them is bundled.
 */
export function echartsLocale(language?: string): EChartsLocale {
  const name = (options: Intl.DateTimeFormatOptions, date: Date) => {
    try {
      return new Intl.DateTimeFormat(language || undefined, {
        ...options,
        timeZone: "UTC",
      }).format(date);
    } catch {
      return "";
    }
  };

  const months = Array.from({ length: 12 }, (_, month) => new Date(Date.UTC(2021, month, 15)));
  // 3 January 2021 was a Sunday, which is where ECharts' week starts.
  const days = Array.from({ length: 7 }, (_, day) => new Date(Date.UTC(2021, 0, 3 + day)));

  return {
    time: {
      month: months.map((date) => name({ month: "long" }, date)),
      monthAbbr: months.map((date) => name({ month: "short" }, date)),
      dayOfWeek: days.map((date) => name({ weekday: "long" }, date)),
      dayOfWeekAbbr: days.map((date) => name({ weekday: "short" }, date)),
    },
  };
}
