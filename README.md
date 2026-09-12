# Scribe Card

A Lovelace card that charts the result of a SQL query, through the [Scribe](https://github.com/jonathan-gtd/scribe) integration.

![Two Scribe cards: daily minimum, average and maximum temperature over a month, and states recorded per hour](https://raw.githubusercontent.com/jonathan-gtd/scribe-card/master/docs/screenshot.png)

_The card itself, rendered with sample rows by `npm run screenshot`._

Scribe stores your Home Assistant history in TimescaleDB. This card puts any query against it on a dashboard — a year of temperatures averaged by day, the ten entities writing the most rows, the compression ratio of your database over time. Anything you can write in SQL.

The query goes through Scribe's `scribe.query` service, not to the database: **there is no second connection to configure and no database password in your dashboard**. Home Assistant's own authentication applies, and Scribe runs every query in a read-only transaction with a time limit.

## Requirements

- [Scribe](https://github.com/jonathan-gtd/scribe) 4.0 or later, set up and recording.

## Installation

### HACS

1. HACS → three dots → **Custom repositories**, add `https://github.com/jonathan-gtd/scribe-card` with the category **Dashboard**.
2. Install **Scribe Card**, then reload your browser.

### By hand

Download `scribe-card.js` from the [latest release](https://github.com/jonathan-gtd/scribe-card/releases/latest) into `config/www/`, then add it under Settings → Dashboards → three dots → **Resources**, as a JavaScript module: `/local/scribe-card.js`.

## Usage

Add a **Manual** card and write:

```yaml
type: custom:scribe-card
title: Temperature, last 24 hours
sql: >
  SELECT time, value
  FROM states
  WHERE entity_id = 'sensor.living_room_temperature'
    AND time > now() - interval '24 hours'
  ORDER BY time
unit: °C
```

The card draws the rows the query returns. It puts the first column that looks like time on the x axis, and every numeric column beside it becomes a line.

## Options

| Option             | Type                  | Default                                              | What it does                                                      |
| ------------------ | --------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `sql`              | string                | **required**                                         | The query to run.                                                 |
| `title`            | string                | —                                                    | Card header.                                                      |
| `x`                | string                | the first time-looking column, else the first column | Column for the x axis.                                            |
| `y`                | string or list        | every numeric column besides `x`                     | Columns to draw.                                                  |
| `chart`            | `line`, `area`, `bar` | `line`                                               | How to draw them.                                                 |
| `unit`             | string                | —                                                    | Appended to the y axis labels.                                    |
| `height`           | number                | `250`                                                | Chart height, in pixels.                                          |
| `refresh_interval` | number                | `0`                                                  | Seconds between refreshes. `0` queries once, when the card loads. |
| `colors`           | list                  | a colour-blind-safe palette                          | Colours, in series order.                                         |

## Examples

**Daily average, over a year** — TimescaleDB buckets the time for you:

```yaml
type: custom:scribe-card
title: Outside temperature, daily average
sql: >
  SELECT time_bucket('1 day', time) AS day, avg(value) AS average
  FROM states
  WHERE entity_id = 'sensor.outside_temperature'
    AND time > now() - interval '1 year'
  GROUP BY 1 ORDER BY 1
unit: °C
chart: area
```

**Minimum, average and maximum in one chart:**

```yaml
type: custom:scribe-card
title: Temperature range per day
sql: >
  SELECT time_bucket('1 day', time) AS day,
         min(value) AS minimum, avg(value) AS average, max(value) AS maximum
  FROM states
  WHERE entity_id = 'sensor.outside_temperature'
    AND time > now() - interval '30 days'
  GROUP BY 1 ORDER BY 1
unit: °C
```

**What is filling your database** — a bar chart with no time axis at all:

```yaml
type: custom:scribe-card
title: Busiest entities, last 24 hours
chart: bar
sql: >
  SELECT e.entity_id, count(*) AS rows
  FROM states_raw s JOIN entities e ON e.id = s.metadata_id
  WHERE s.time > now() - interval '24 hours'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10
```

**How many states Scribe records per hour:**

```yaml
type: custom:scribe-card
title: States recorded per hour
refresh_interval: 300
sql: >
  SELECT time_bucket('1 hour', time) AS time, count(*) AS states
  FROM states_raw
  WHERE time > now() - interval '24 hours'
  GROUP BY 1 ORDER BY 1
```

The tables and views these queries use are described in [Scribe's data structure guide](https://github.com/jonathan-gtd/scribe/blob/master/docs/data-structure.md).

## Good to know

- **Give Scribe its own database user.** Every query runs as whatever user Scribe connects with. A read-only transaction stops writes, but a superuser can still read things that have nothing to do with your history. A user that owns only Scribe's database is the right answer, and it is what Scribe's setup guide recommends.
- **Return what you need to draw, not everything you have.** A query without `GROUP BY` or `LIMIT` over a year of history can return millions of rows, and they all travel to your browser. `time_bucket(…)` exists for this.
- **A query that fails shows what the database said**, on the card, rather than an empty chart.

## Development

```
npm install
npm test          # the row-to-series rules
npm run typecheck
npm run build     # dist/scribe-card.js, what HACS installs
```

Releases are built by CI from the tag, and the published file carries a [build provenance attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations): `gh attestation verify scribe-card.js --repo jonathan-gtd/scribe-card`.

## License

MIT, like Scribe.
