# Changelog

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
