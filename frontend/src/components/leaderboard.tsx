import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";
import { Clock3, Clapperboard, Flame, Medal, Tv, Info } from "lucide-react";
import { format, parseISO } from "date-fns";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Avatar, Empty, duration, hours } from "@/components/shared";
import type { Analytics, Metric } from "@/lib/types";

const metrics = [
  {
    key: "seconds",
    name: "Total watch time",
    icon: Clock3,
    description:
      "Measured active viewing. Simultaneous streams count once per viewer.",
  },
  {
    key: "peak_day_seconds",
    name: "Peak day",
    icon: Flame,
    description:
      "The most active viewing time in one calendar day in the selected timezone.",
  },
  {
    key: "consecutive_seconds",
    name: "Longest watch",
    icon: Medal,
    description:
      "Consecutive active viewing. Pauses longer than 15 seconds break a run; gaps add no time.",
  },
  {
    key: "episodes",
    name: "Episodes completed",
    icon: Tv,
    description:
      "Episodes with at least 90% measured coverage in one playback.",
  },
  {
    key: "movies",
    name: "Movies completed",
    icon: Clapperboard,
    description: "Movies with at least 90% measured coverage in one playback.",
  },
] as const;
const colors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
export function metricValue(metric: Metric, value: number) {
  return metric === "movies" || metric === "episodes"
    ? value.toLocaleString()
    : hours(value);
}

export function Leaderboard({ data }: { data: Analytics }) {
  const [metric, setMetric] = useState<Metric>("seconds");
  const [viewer, setViewer] = useState("all");
  const selected = metrics.find((m) => m.key === metric)!;
  const rows = [...data.users].sort(
    (a, b) => b[metric] - a[metric] || a.user_name.localeCompare(b.user_name),
  );
  const selectedViewer = data.users.find((u) => u.user_id === viewer);
  const chartData = data.daily.map((day) => ({
    ...day,
    hours: (selectedViewer ? day.users[viewer] || 0 : day.seconds) / 3600,
  }));
  const config = {
    hours: { label: "Watch time", color: "var(--chart-1)" },
  } satisfies ChartConfig;
  const breakdown = [
    { type: "Episode", seconds: data.breakdown.Episode, fill: colors[0] },
    { type: "Movie", seconds: data.breakdown.Movie, fill: colors[1] },
  ];
  return (
    <>
      <div className="intro-row">
        <div>
          <Badge variant="outline" className="period-badge">
            {format(parseISO(data.range.start), "MMMM yyyy")}
          </Badge>
          <h1>
            A little friendly
            <br className="desktop-break" /> competition.
          </h1>
          <p>Your viewing habits, with the numbers to back them up.</p>
        </div>
        <div className="intro-side">
          <span className="orbit-mark">
            <Tv strokeWidth={1.2} />
          </span>
          <span>
            {data.totals.viewers} active{" "}
            {data.totals.viewers === 1 ? "viewer" : "viewers"}
            <br />
            this period
          </span>
        </div>
      </div>
      <div className="metrics-strip">
        {metrics.map((m) => {
          const winner = data.users.find(
            (u) => u.user_id === data.leaders[m.key][0],
          );
          const tied = data.leaders[m.key].length > 1;
          return (
            <button
              key={m.key}
              className={`metric-tile ${metric === m.key ? "selected" : ""}`}
              onClick={() => setMetric(m.key)}
              aria-pressed={metric === m.key}
            >
              <span className="metric-label">
                <m.icon size={16} />
                {m.name}
              </span>
              <strong>
                {winner ? metricValue(m.key, winner[m.key]) : "—"}
              </strong>
              <span className="metric-winner">
                {winner
                  ? `${winner.user_name}${tied ? ` + ${data.leaders[m.key].length - 1} tied` : ""}`
                  : "No leader yet"}
              </span>
            </button>
          );
        })}
      </div>
      <section className="panel timeline-panel">
        <div className="panel-heading">
          <div>
            <h2>Time well watched</h2>
            <p>
              Daily viewing{" "}
              {selectedViewer
                ? `by ${selectedViewer.user_name}`
                : "across your circle"}
            </p>
          </div>
          <Select
            value={selectedViewer ? viewer : "all"}
            onValueChange={setViewer}
          >
            <SelectTrigger className="viewer-filter" aria-label="Chart viewer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All viewers</SelectItem>
              {data.users.map((u) => (
                <SelectItem value={u.user_id} key={u.user_id}>
                  {u.user_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="chart-headline">
          <strong>
            {hours(
              selectedViewer ? selectedViewer.seconds : data.totals.seconds,
            )}
          </strong>
          <span>of actual watch time</span>
          <span className="chart-key">
            <i />
            Watch hours
          </span>
        </div>
        <ChartContainer config={config} className="daily-chart">
          <AreaChart
            data={chartData}
            margin={{ top: 12, right: 14, left: 0, bottom: 0 }}
            accessibilityLayer
          >
            <defs>
              <linearGradient id="watch-fill" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="var(--chart-1)"
                  stopOpacity={0.35}
                />
                <stop
                  offset="100%"
                  stopColor="var(--chart-1)"
                  stopOpacity={0.01}
                />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              stroke="var(--border)"
              strokeDasharray="3 5"
            />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              minTickGap={28}
              tickFormatter={(v) => format(parseISO(v), "d MMM")}
              tickMargin={12}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}h`}
              width={42}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) =>
                    format(parseISO(String(value)), "EEEE, d MMM")
                  }
                  formatter={(value) => (
                    <span className="tooltip-value">
                      {Number(value).toFixed(2)} hours
                    </span>
                  )}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="hours"
              stroke="var(--chart-1)"
              strokeWidth={2.5}
              fill="url(#watch-fill)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      </section>
      <div className="board-grid">
        <section className="panel rankings-panel">
          <div className="panel-heading">
            <div>
              <h2>The leaderboard</h2>
              <p>Same circle. Five ways to take the crown.</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="info-button" aria-label="How rankings work">
                  <Info size={17} />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                {selected.description}
              </TooltipContent>
            </Tooltip>
          </div>
          <Select value={metric} onValueChange={(v) => setMetric(v as Metric)}>
            <SelectTrigger
              className="ranking-select"
              aria-label="Ranking metric"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {metrics.map((m) => (
                <SelectItem key={m.key} value={m.key}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!rows.length ? (
            <Empty title="The crown is up for grabs">
              Play something in Jellyfin to start recording measured watch time.
            </Empty>
          ) : (
            <div className="rankings">
              <div className="ranking-table-head">
                <span>Viewer</span>
                <span>{selected.name}</span>
              </div>
              {rows.map((u, index) => {
                const rank = rows.findIndex((r) => r[metric] === u[metric]) + 1;
                const lead = index === 0 && u[metric] > 0;
                return (
                  <div
                    className={`ranking-row ${lead ? "rank-lead" : ""}`}
                    key={u.user_id}
                  >
                    <span className="rank-number">
                      {lead ? (
                        <Medal size={21} />
                      ) : (
                        String(rank).padStart(2, "0")
                      )}
                    </span>
                    <Avatar
                      name={u.user_name}
                      index={data.users.findIndex(
                        (v) => v.user_id === u.user_id,
                      )}
                    />
                    <div className="rank-person">
                      <strong>{u.user_name}</strong>
                      <span>
                        {u.episodes} episodes · {u.movies} movies
                        {metric === "peak_day_seconds" && u.peak_day
                          ? ` · ${format(parseISO(u.peak_day), "d MMM")}`
                          : ""}
                      </span>
                    </div>
                    <div className="rank-value">
                      <strong>{metricValue(metric, u[metric])}</strong>
                      <div className="rank-bar">
                        <span
                          style={{
                            width: `${rows[0][metric] ? (u[metric] / rows[0][metric]) * 100 : 0}%`,
                            background:
                              colors[
                                data.users.findIndex(
                                  (v) => v.user_id === u.user_id,
                                ) % 5
                              ],
                          }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <section className="panel mix-panel">
          <div className="panel-heading">
            <div>
              <h2>Your viewing mix</h2>
              <p>A taste for long stories or movie nights?</p>
            </div>
          </div>
          {data.breakdown.Episode + data.breakdown.Movie > 0 ? (
            <>
              <div className="donut-wrap">
                <ChartContainer
                  config={{
                    Episode: { label: "Episodes", color: colors[0] },
                    Movie: { label: "Movies", color: colors[1] },
                  }}
                  className="mix-chart"
                >
                  <PieChart accessibilityLayer>
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          nameKey="type"
                          formatter={(value, name) => (
                            <span>
                              {name}: {duration(Number(value))}
                            </span>
                          )}
                        />
                      }
                    />
                    <Pie
                      data={breakdown}
                      dataKey="seconds"
                      nameKey="type"
                      innerRadius={76}
                      outerRadius={98}
                      paddingAngle={4}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {breakdown.map((d) => (
                        <Cell key={d.type} fill={d.fill} />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="donut-center">
                  <strong>{data.totals.episodes + data.totals.movies}</strong>
                  <span>completed</span>
                </div>
              </div>
              <div className="mix-legend">
                {breakdown.map((d) => (
                  <div key={d.type}>
                    <span>
                      <i style={{ background: d.fill }} />
                      {d.type === "Episode" ? "Episodes" : "Movies"}
                    </span>
                    <strong>{hours(d.seconds)}</strong>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Empty title="Your next story starts here">
              Movie and episode viewing will appear as you watch.
            </Empty>
          )}
          <div className="completion-note">
            <Info size={14} />
            <p>
              Completions need 90% measured coverage. Partial watches still add
              watch time.
            </p>
          </div>
        </section>
      </div>
      <div className="board-grid lower-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Stories you come back to</h2>
              <p>Most watched titles in this period</p>
            </div>
          </div>
          {data.top_titles.length ? (
            <ChartContainer
              className="titles-chart"
              config={{
                seconds: { label: "Watched", color: "var(--chart-2)" },
              }}
            >
              <BarChart
                layout="vertical"
                data={data.top_titles.slice(0, 5)}
                margin={{ left: 0, right: 30 }}
                accessibilityLayer
              >
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="item_name"
                  width={125}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => (
                        <span>{duration(Number(value))}</span>
                      )}
                    />
                  }
                />
                <Bar
                  dataKey="seconds"
                  fill="var(--chart-2)"
                  radius={[0, 4, 4, 0]}
                  barSize={12}
                  isAnimationActive={false}
                />
              </BarChart>
            </ChartContainer>
          ) : (
            <Empty title="No viewing in this range">
              Try another month or come back after your next watch.
            </Empty>
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Recently finished</h2>
              <p>The latest credits to roll</p>
            </div>
          </div>
          <div className="recent-list">
            {data.recent.length ? (
              data.recent.slice(0, 4).map((r, i) => (
                <div className="recent-row" key={r.id}>
                  <Avatar name={r.user_name} index={i} />
                  <div>
                    <strong>{r.series_name || r.item_name}</strong>
                    <span>
                      {r.user_name} finished{" "}
                      {r.item_type === "Episode" ? "an episode" : "a movie"}
                    </span>
                  </div>
                  <span className="recent-date">
                    {format(parseISO(r.at), "d MMM")}
                  </span>
                </div>
              ))
            ) : (
              <Empty title="No completions yet">
                Measured completions will appear here.
              </Empty>
            )}
          </div>
        </section>
      </div>
      <div className="tracking-footnote">
        <span
          className={`status-dot ${data.tracking.error ? "status-warn" : ""}`}
        />
        <span>
          {data.tracking.error ||
            `Measured playback · sampled every ${data.tracking.sample_seconds}s · tracking since ${format(parseISO(data.tracking.since), "d MMM yyyy")}`}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="info-button" aria-label="Tracking limitations">
              <Info size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">
            Brief plays and final seconds between samples may be missed. Pauses,
            seeks and outages receive no guessed time. Earlier runtime estimates
            are excluded. Simultaneous movie and episode playback shares the
            time equally in the viewing mix. Total watch time counts each viewer
            once.
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  );
}
