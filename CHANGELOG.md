# Changelog

## Unreleased

**`$__timeFilter(column)`**, which is how Grafana spells it, and **`$__timezone`**, which is the
instance's own — a day, a week or a month only line up with the calendar if the database is told
which calendar to count in. Without it `time_bucket('1 day', time)` starts its days at midnight
UTC rather than where you live.

**`sync_group`**: cards given the same name share a pointer, so hovering one moment on any of them
marks it on all the others.

**Colour from the value.** `warn_above` draws the first column in a warning colour past a limit,
`warn_below` under one, and `scale_from` / `scale_to` run it through a gradient instead. ECharts'
`visualMap` is now bundled, which it never was — an `options: { visualMap: … }` written by hand did
nothing at all before this. It costs 38 KB, 12 of them over the wire.

**`debug: true`** puts the row count and the time the query took under the chart, and the query
itself — every marker filled in — in the browser console. For working out why a card behaves oddly
on somebody else's dashboard without asking them for a container log.

**Colours are picked, not typed.** The editor shows one of Home Assistant's colour pickers per
drawn series, and a colour it has a name for — `red`, `primary` — follows the theme rather than
being fixed. Hexadecimal is still accepted.

Fixed: shares counted the series on the right-hand axis; a chart of shares kept the unit of the
values it no longer showed; two settings could disagree about stacking; a `y2` naming a column
that is not drawn raised an axis for it; lines across the chart landed on the right-hand axis when
the first column belonged to it; `label_position` was documented and unreachable.

## 0.4.0

**One card, several time ranges.** A query can leave its period out — `$__from`, `$__to` and
`$__interval` — and the card fills it in from a picker at the top of it. The bucket follows the
span, and the choice is remembered per user on your Home Assistant, so it outlives the browser
closing and reading the same dashboard from another machine. Only a duration the card recognises
reaches the SQL.

**A second axis, and thirty-six other ECharts options.** `y2: humidity` puts a column on its own
axis, on the right, with its own unit in the tooltip. Alongside it: axis minimum, maximum,
logarithmic scale, decimals, names, label rotation, margins, grid lines; line thickness, fill
strength, gradients, point symbols, bar width, joining across gaps; stacking by share of each
moment; ordering a chart of labels by its values; dashed lines at the average, the highest, the
lowest, or a limit of your own; legend position, tooltip trigger, animation. `options:` and
`series:` still win over all of it.

**An editor in four tabs** — Query, Chart, Axes, Time & data — with the less common settings in
sections that open, and every switch on a row of its own.

**Dates and numbers in your language.** Month names, a twelve- or twenty-four-hour clock and
decimal separators come from Home Assistant's own settings.

**On a real dashboard**: a theme switched repaints the chart; a card moved across a dashboard draws
itself again; a refresh that fails keeps the rows that worked, under a line saying they are older;
a hidden tab stops querying the database; a sections view is told how tall the card is; a query
that fails says what the database said. The chart carries a description and its rows for a screen
reader, and the rows can be taken away as CSV.

Breaking changes: none.

## 0.2.0

The first release. A Lovelace card that charts the result of a SQL query, through Scribe's
`scribe.query` service, drawn with Apache ECharts — with a visual editor that offers the columns
the query returned.
