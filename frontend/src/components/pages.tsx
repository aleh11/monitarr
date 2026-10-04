import { useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  Activity as ActivityIcon,
  Check,
  Dice5,
  Film,
  Pause,
  Play,
  Plus,
  Search,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, post, useResource } from "@/lib/api";
import type {
  Activity,
  Analytics,
  Media,
  Playing,
  RatedMedia,
  ReportedActivity,
  System,
  Taste,
  User,
  WatchItem,
} from "@/lib/types";
import {
  Avatar,
  BusyButton,
  Empty,
  ErrorState,
  Loading,
  Poster,
  bytes,
  duration,
  episode,
  title,
} from "@/components/shared";

function PageIntro({
  heading,
  description,
}: {
  heading: string;
  description: string;
}) {
  return (
    <div className="page-intro">
      <h1>{heading}</h1>
      <p>{description}</p>
    </div>
  );
}
function useMutation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<unknown>, success?: () => void) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      success?.();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to save. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
function SearchLibrary({
  label,
  onSelect,
}: {
  label: string;
  onSelect: (item: Media) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Media[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      if (query.trim().length < 2) {
        setResults([]);
        setError("");
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const items = await api<Media[]>(
          `/api/search?q=${encodeURIComponent(query.trim())}`,
          { signal: abort.signal },
        );
        if (!abort.signal.aborted) {
          setResults(items);
          setError("");
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "Search failed");
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query]);
  return (
    <div className="library-search">
      <div className="search-input">
        <Search size={18} />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={label}
          aria-label={label}
        />
      </div>
      {error && <ErrorState message={error} />}
      {loading && <p className="muted">Searching your library…</p>}
      {query.trim().length >= 2 && !loading && !error && !results.length && (
        <p className="muted">No matching titles. Try another name.</p>
      )}
      {results.length > 0 && (
        <div className="search-results">
          {results.map((item) => (
            <button
              key={item.item_id}
              onClick={() => {
                onSelect(item);
                setQuery("");
                setResults([]);
              }}
            >
              <Film size={17} />
              <span>
                <strong>{title(item)}</strong>
                <small>
                  {item.series_name ? item.item_name : item.item_type}
                  {item.year ? ` · ${item.year}` : ""}
                </small>
              </span>
              <Plus size={16} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NowPage({ analytics }: { analytics?: Analytics }) {
  const { data, error, loading, reload } = useResource<Playing[]>(
    "/api/now",
    10000,
  );
  return (
    <>
      <PageIntro
        heading="What's on tonight?"
        description="A window into what everyone is watching, right now."
      />
      {error && <ErrorState message={error} retry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : data?.length ? (
        <div className="playing-grid">
          {data.map((p, i) => (
            <section
              className="panel playing-card"
              key={`${p.user}-${p.device}-${p.item_id}`}
            >
              <Poster media={p} />
              <div className="playing-info">
                <Badge variant="outline">
                  {p.paused ? <Pause size={12} /> : <Play size={12} />}
                  {p.paused ? "Paused" : "Playing"}
                </Badge>
                <h2>{title(p)}</h2>
                <p>
                  {p.series_name
                    ? `${episode(p)} · ${p.item_name}`
                    : `${p.year || ""}`}
                </p>
                <div className="playing-person">
                  <Avatar name={p.user} index={i} />
                  <div>
                    <strong>{p.user}</strong>
                    <span>{p.device || p.client}</span>
                  </div>
                </div>
                {p.progress != null && (
                  <>
                    <Progress value={Math.max(0, Math.min(100, p.progress))} />
                    <span className="muted small">
                      {p.progress.toFixed(0)}% through
                    </span>
                  </>
                )}
                <span className="play-method">
                  {p.method === "Transcode"
                    ? `Transcoding${p.hw_accel ? ` · ${p.hw_accel}` : ""}`
                    : p.method === "DirectPlay"
                      ? "Direct play"
                      : p.method || "Playback"}
                  {p.transcode_reasons.length
                    ? ` · ${p.transcode_reasons.join(", ")}`
                    : ""}
                </span>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty title="A quiet moment">
            Nobody is playing anything right now. Choose your next watch in the
            watchlist.
          </Empty>
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Finished in this period</h2>
            <p>Measured completions from your selected dates</p>
          </div>
        </div>
        {analytics?.recent.length ? (
          <div className="recent-list">
            {analytics.recent.slice(0, 10).map((r, i) => (
              <div className="recent-row" key={r.id}>
                <Avatar name={r.user_name} index={i} />
                <div>
                  <strong>
                    {r.series_name
                      ? `${r.series_name} · ${r.item_name}`
                      : r.item_name}
                  </strong>
                  <span>
                    {r.user_name} finished{" "}
                    {r.item_type === "Episode" ? "an episode" : "a movie"}
                  </span>
                </div>
                <span className="recent-date">
                  {format(parseISO(r.at), "d MMM")}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No completions in this range">
            Your next finished story will show up here.
          </Empty>
        )}
      </section>
    </>
  );
}

export function WatchPage({ user }: { user: User }) {
  const up = useResource<Media[]>("/api/up-next", 60000);
  const list = useResource<WatchItem[]>("/api/watchlist", 60000);
  const fresh = useResource<Media[]>("/api/latest", 60000);
  const mutation = useMutation();
  const [adding, setAdding] = useState<Media | null>(null);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<WatchItem | null>(null);
  const [showDone, setShowDone] = useState(false);
  const candidates = (list.data || []).filter((i) => !i.done && !i.missing);
  function pick() {
    if (candidates.length)
      setPicked(candidates[Math.floor(Math.random() * candidates.length)]);
  }
  function reload() {
    list.reload();
    fresh.reload();
  }
  return (
    <>
      <PageIntro
        heading="Make a night of it."
        description="Keep your next watch close. Get everyone in on the plan."
      />
      {mutation.error && <ErrorState message={mutation.error} />}
      <section>
        <div className="section-heading">
          <h2>Continue your story</h2>
          <span>Up next for {user.name}</span>
        </div>
        {up.error ? (
          <ErrorState message={up.error} retry={up.reload} />
        ) : up.loading && !up.data ? (
          <Loading />
        ) : up.data?.length ? (
          <div className="poster-row">
            {up.data.map((m) => (
              <Poster key={m.item_id} media={m} />
            ))}
          </div>
        ) : (
          <Empty title="A fresh start">
            Pick a movie or series from the library below.
          </Empty>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>The shared watchlist</h2>
            <p>A good plan starts with a good pick.</p>
          </div>
          <Button
            variant="outline"
            onClick={pick}
            disabled={!candidates.length}
          >
            <Dice5 />
            Pick for us
          </Button>
        </div>
        <SearchLibrary
          label="Find a movie or series to add…"
          onSelect={(m) => {
            setAdding(m);
            setNote("");
          }}
        />
        {list.error && <ErrorState message={list.error} retry={list.reload} />}
        {list.loading && !list.data ? (
          <Loading />
        ) : (list.data || []).filter((i) => showDone || !i.done).length ? (
          <div className="watchlist-rows">
            {(list.data || [])
              .filter((i) => showDone || !i.done)
              .map((item) => (
                <div className="watchlist-row" key={item.item_id}>
                  <Poster media={item} />
                  <div className="watch-details">
                    <div className="watch-title">
                      <h3>{item.item_name}</h3>
                      <Badge variant="secondary">
                        {item.item_type === "Series" ? "Series" : "Movie"}
                      </Badge>
                      {item.done && (
                        <Badge>
                          <Check size={12} />
                          Watched
                        </Badge>
                      )}
                      {item.missing && (
                        <Badge variant="destructive">
                          Removed from library
                        </Badge>
                      )}
                    </div>
                    <p>
                      Added by {item.added_by_name}
                      {item.year ? ` · ${item.year}` : ""}
                    </p>
                    {item.note && <p className="watch-note">{item.note}</p>}
                    <div className="watch-progress">
                      {Object.entries(item.progress).map(([name, progress]) => (
                        <span key={name}>
                          {item.in.includes(name) && <Users size={12} />}
                          {name}{" "}
                          {progress.total != null
                            ? `${progress.watched}/${progress.total}`
                            : progress.done
                              ? "✓"
                              : "Unwatched"}
                        </span>
                      ))}
                    </div>
                    <div className="watch-actions">
                      <BusyButton
                        busy={mutation.busy}
                        variant={
                          item.in.includes(user.name) ? "secondary" : "default"
                        }
                        size="sm"
                        onClick={() =>
                          void mutation.run(
                            () =>
                              post(
                                `/api/watchlist/${item.item_id}/in`,
                                undefined,
                                item.in.includes(user.name) ? "DELETE" : "POST",
                              ),
                            reload,
                          )
                        }
                      >
                        {item.in.includes(user.name) ? "I'm out" : "I'm in"}
                      </BusyButton>
                      {item.can_remove && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={mutation.busy}
                          onClick={() =>
                            void mutation.run(
                              () =>
                                post(
                                  `/api/watchlist/${item.item_id}`,
                                  undefined,
                                  "DELETE",
                                ),
                              reload,
                            )
                          }
                        >
                          <Trash2 />
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <Empty title="Room for a new obsession">
            Search your library and add a title to start a shared watchlist.
          </Empty>
        )}
        {list.data?.some((i) => i.done) && (
          <Button variant="ghost" onClick={() => setShowDone((v) => !v)}>
            {showDone ? "Hide completed titles" : "Show completed titles"}
          </Button>
        )}
      </section>
      <section>
        <div className="section-heading">
          <h2>Fresh on the shelf</h2>
          <span>Recently added to Jellyfin</span>
        </div>
        {fresh.error ? (
          <ErrorState message={fresh.error} retry={fresh.reload} />
        ) : fresh.data?.length ? (
          <div className="poster-row">
            {fresh.data.map((m) => (
              <Poster
                key={m.item_id}
                media={m}
                onClick={
                  m.listed
                    ? undefined
                    : () => {
                        setAdding(m);
                        setNote("");
                      }
                }
              >
                <Badge
                  className="poster-badge"
                  variant={m.listed ? "secondary" : "default"}
                >
                  {m.listed ? <Check size={12} /> : <Plus size={12} />}
                  {m.listed ? "Listed" : "Add"}
                </Badge>
              </Poster>
            ))}
          </div>
        ) : (
          <Empty title="Nothing new just yet">
            New arrivals will appear here.
          </Empty>
        )}
      </section>
      <Dialog
        open={!!adding}
        onOpenChange={(open) => {
          if (!open) setAdding(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add {adding ? title(adding) : "a title"}</DialogTitle>
            <DialogDescription>
              An episode adds its whole series to the watchlist.
            </DialogDescription>
          </DialogHeader>
          <label className="field-label" htmlFor="watch-note">
            A note for everyone
          </label>
          <Textarea
            id="watch-note"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="For the next movie night…"
          />
          {mutation.error && <ErrorState message={mutation.error} />}
          <BusyButton
            busy={mutation.busy}
            onClick={() => {
              if (adding)
                void mutation.run(
                  () =>
                    post("/api/watchlist", { item_id: adding.item_id, note }),
                  () => {
                    setAdding(null);
                    reload();
                  },
                );
            }}
          >
            Add to watchlist
          </BusyButton>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!picked}
        onOpenChange={(open) => {
          if (!open) setPicked(null);
        }}
      >
        <DialogContent className="pick-dialog">
          <DialogHeader>
            <DialogTitle>Tonight's pick</DialogTitle>
            <DialogDescription>
              {picked?.in.length
                ? `Who's in: ${picked.in.join(", ")}`
                : "Your next movie night, sorted."}
            </DialogDescription>
          </DialogHeader>
          {picked && <Poster media={picked} />}
          <div className="dialog-actions">
            <Button variant="outline" onClick={pick}>
              <Dice5 />
              Pick again
            </Button>
            <Button onClick={() => setPicked(null)}>Let's watch it</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function RatingsPage({ user }: { user: User }) {
  const suggestions = useResource<Media[]>("/api/to-rate");
  const reviews = useResource<RatedMedia[]>("/api/ratings");
  const taste = useResource<Taste[]>("/api/taste");
  const mutation = useMutation();
  const [selected, setSelected] = useState<Media | null>(null);
  const [target, setTarget] = useState("");
  const [score, setScore] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const mine = reviews.data
    ?.find((r) => r.item_id === target)
    ?.reviews.find((r) => r.user_id === user.id);
  function chooseTarget(itemId: string) {
    setTarget(itemId);
    const existing = reviews.data
      ?.find((r) => r.item_id === itemId)
      ?.reviews.find((r) => r.user_id === user.id);
    setScore(existing?.score ?? null);
    setNote(existing?.note || "");
  }
  function open(media: Media) {
    setSelected(media);
    chooseTarget(
      media.item_type === "Episode" && media.series_id
        ? media.series_id
        : media.item_id,
    );
  }
  function reload() {
    suggestions.reload();
    reviews.reload();
    taste.reload();
    setSelected(null);
  }
  return (
    <>
      <PageIntro
        heading="Good taste is personal."
        description="Rate your watches, trade opinions, and find your cinematic kindred spirits."
      />
      {mutation.error && !selected && <ErrorState message={mutation.error} />}
      <section>
        <div className="section-heading">
          <h2>What did you think?</h2>
          <span>Recently watched by you</span>
        </div>
        {suggestions.error ? (
          <ErrorState message={suggestions.error} retry={suggestions.reload} />
        ) : suggestions.data?.length ? (
          <div className="poster-row">
            {suggestions.data.map((m) => (
              <Poster key={m.item_id} media={m} onClick={() => open(m)}>
                <Badge className="poster-badge">
                  <Star size={12} />
                  Rate
                </Badge>
              </Poster>
            ))}
          </div>
        ) : (
          <Empty title="All caught up">
            Search below to rate any movie, show or episode.
          </Empty>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Find a title to rate</h2>
            <p>A score from 1 to 10, with room for your take.</p>
          </div>
        </div>
        <SearchLibrary
          label="Search movies, series and episodes…"
          onSelect={open}
        />
      </section>
      {taste.error && <ErrorState message={taste.error} retry={taste.reload} />}
      {!!taste.data?.length && (
        <section>
          <div className="section-heading">
            <h2>On the same wavelength</h2>
            <span>Taste match</span>
          </div>
          <div className="taste-grid">
            {taste.data.map((pair) => (
              <section className="panel taste-card" key={`${pair.a}-${pair.b}`}>
                <strong className="taste-number">
                  {pair.match}
                  <small>%</small>
                </strong>
                <h3>
                  {pair.a} & {pair.b}
                </h3>
                <p>{pair.shared} shared ratings</p>
                {pair.fights.map((f) => (
                  <div key={f.item} className="taste-fight">
                    <span>{f.item}</span>
                    <strong>
                      {f.a_score} / {f.b_score}
                    </strong>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </section>
      )}
      <section>
        <div className="section-heading">
          <h2>The reviews are in</h2>
          <span>{reviews.data?.length || 0} rated titles</span>
        </div>
        {reviews.error ? (
          <ErrorState message={reviews.error} retry={reviews.reload} />
        ) : reviews.loading && !reviews.data ? (
          <Loading />
        ) : reviews.data?.length ? (
          <div className="reviews-grid">
            {reviews.data.map((media) => (
              <section className="panel review-card" key={media.item_id}>
                <div className="review-heading">
                  <div>
                    <h3>{title(media)}</h3>
                    <p>
                      {media.item_type === "Series"
                        ? "Series"
                        : media.item_type}
                      {media.year ? ` · ${media.year}` : ""}
                    </p>
                  </div>
                  <span className="review-score">
                    {media.avg}
                    <small>/10</small>
                  </span>
                </div>
                {media.reviews.map((review) => (
                  <div className="user-review" key={review.user_id}>
                    <div>
                      <Avatar name={review.user_name} />
                      <strong>{review.user_name}</strong>
                      <span>{review.score}/10</span>
                    </div>
                    {review.note && <p>{review.note}</p>}
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => open(media)}>
                  <Star />
                  {media.reviews.some((r) => r.user_id === user.id)
                    ? "Edit my rating"
                    : "Add my rating"}
                </Button>
              </section>
            ))}
          </div>
        ) : (
          <section className="panel">
            <Empty title="The first review is yours">
              Choose a title above and share what you thought.
            </Empty>
          </section>
        )}
      </section>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selected ? title(selected) : "Rate a title"}
            </DialogTitle>
            <DialogDescription>
              How was it? Choose a score, and add a note if you like.
            </DialogDescription>
          </DialogHeader>
          {selected?.item_type === "Episode" && selected.series_id && (
            <Select value={target} onValueChange={chooseTarget}>
              <SelectTrigger aria-label="Rate series or episode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={selected.series_id}>Whole series</SelectItem>
                <SelectItem value={selected.item_id}>
                  This episode: {selected.item_name}
                </SelectItem>
              </SelectContent>
            </Select>
          )}
          <div className="score-options" role="group" aria-label="Rating score">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <Button
                key={n}
                variant={score === n ? "default" : "outline"}
                onClick={() => setScore(n)}
                aria-pressed={score === n}
              >
                {n}
              </Button>
            ))}
          </div>
          <label className="field-label" htmlFor="rating-note">
            Your take
          </label>
          <Textarea
            id="rating-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={280}
            placeholder="The part that stuck with you…"
          />
          {mutation.error && <ErrorState message={mutation.error} />}
          <div className="dialog-actions">
            {mine && (
              <Button
                variant="ghost"
                disabled={mutation.busy}
                onClick={() =>
                  void mutation.run(
                    () => post(`/api/ratings/${target}`, undefined, "DELETE"),
                    reload,
                  )
                }
              >
                <Trash2 />
                Remove rating
              </Button>
            )}
            <BusyButton
              busy={mutation.busy}
              disabled={!score}
              onClick={() =>
                void mutation.run(
                  () => post("/api/ratings", { item_id: target, score, note }),
                  reload,
                )
              }
            >
              Save rating
            </BusyButton>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function HistoryPage({
  query,
  timezone,
}: {
  query: string;
  timezone: string;
}) {
  const [source, setSource] = useState("measured");
  const [search, setSearch] = useState("");
  const measured = useResource<Activity[]>(`/api/activity?${query}`, 30000);
  return (
    <>
      <PageIntro
        heading="Your viewing journal."
        description="Every measured session, including the ones you didn't finish."
      />
      <Tabs value={source} onValueChange={setSource}>
        <TabsList>
          <TabsTrigger value="measured">Measured playback</TabsTrigger>
          <TabsTrigger value="reported">Playback Reporting archive</TabsTrigger>
        </TabsList>
      </Tabs>
      {source === "reported" ? (
        <ReportedHistory />
      ) : (
        <section className="panel history-panel">
          <div className="panel-heading">
            <div>
              <h2>Playback sessions</h2>
              <p>Filtered by the calendar above · latest 200 sessions</p>
            </div>
            <div className="search-input">
              <Search size={17} />
              <Input
                aria-label="Filter playback sessions"
                placeholder="Find a title or viewer…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          {measured.error && (
            <ErrorState message={measured.error} retry={measured.reload} />
          )}
          {measured.loading && !measured.data ? (
            <Loading />
          ) : measured.data?.length ? (
            <div className="table-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Viewer</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Watched</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Device</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {measured.data
                    .filter((r) =>
                      `${r.user} ${r.name} ${r.series_name || ""}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <div className="table-viewer">
                            <Avatar name={r.user} />
                            {r.user}
                          </div>
                        </TableCell>
                        <TableCell>
                          <strong>{r.series_name || r.name}</strong>
                          {r.series_name && (
                            <span className="table-subtitle">{r.name}</span>
                          )}
                        </TableCell>
                        <TableCell>{duration(r.seconds)}</TableCell>
                        <TableCell>
                          <Badge
                            variant={r.completed ? "default" : "secondary"}
                          >
                            {r.completed ? "Completed" : "Partial watch"}
                          </Badge>
                        </TableCell>
                        <TableCell className="muted">
                          {r.device || r.client || "—"}
                        </TableCell>
                        <TableCell className="muted">
                          {new Intl.DateTimeFormat("en", {
                            timeZone: timezone,
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                            hourCycle: "h23",
                          }).format(parseISO(r.at))}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <Empty title="No measured sessions in this range">
              Try another month, or start watching in Jellyfin.
            </Empty>
          )}
        </section>
      )}
    </>
  );
}
function ReportedHistory() {
  const history = useResource<ReportedActivity[]>("/api/history");
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Playback Reporting archive</h2>
          <p>
            Latest 100 plugin records across all dates. This archive is separate
            from measured rankings.
          </p>
        </div>
      </div>
      {history.error ? (
        <ErrorState
          message="The Playback Reporting archive is unavailable. Check that the Jellyfin plugin is installed and enabled."
          retry={history.reload}
        />
      ) : history.loading ? (
        <Loading />
      ) : history.data?.length ? (
        <div className="table-scroll">
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "Viewer",
                  "Title",
                  "Reported time",
                  "Method",
                  "Device",
                  "When",
                ].map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.data.map((r, i) => (
                <TableRow key={i}>
                  <TableCell>{r.user}</TableCell>
                  <TableCell>{r.name}</TableCell>
                  <TableCell>{duration(r.seconds)}</TableCell>
                  <TableCell>{r.method}</TableCell>
                  <TableCell>{r.device || r.client}</TableCell>
                  <TableCell>{r.at}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <Empty title="No plugin history yet">
          The Jellyfin plugin will record new playbacks here.
        </Empty>
      )}
    </section>
  );
}

export function SystemPage() {
  const { data, error, loading, reload } = useResource<System>(
    "/api/system",
    15000,
  );
  return (
    <>
      <PageIntro
        heading="Behind the screen."
        description="Your media stack, from the disks to the downloads."
      />
      {error && <ErrorState message={error} retry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="system-metrics">
              <section className="panel">
                <ActivityIcon />
                <span>CPU usage</span>
                <strong>{data.cpu == null ? "—" : `${data.cpu}%`}</strong>
                <p>
                  {data.cores} cores · load{" "}
                  {data.load.map((n) => n.toFixed(1)).join(" / ")}
                </p>
              </section>
              <section className="panel">
                <span>Memory used</span>
                <strong>
                  {bytes(data.memory.total - data.memory.available)}
                </strong>
                <Progress
                  value={
                    ((data.memory.total - data.memory.available) /
                      data.memory.total) *
                    100
                  }
                />
                <p>of {bytes(data.memory.total)}</p>
              </section>
              <section className="panel">
                <span>In the library</span>
                <strong>
                  {data.library.MovieCount} <small>movies</small>
                </strong>
                <p>
                  {data.library.SeriesCount} series ·{" "}
                  {data.library.EpisodeCount} episodes
                </p>
              </section>
              <section className="panel">
                <span>Uptime</span>
                <strong>
                  {Math.floor(data.uptime / 86400)} <small>days</small>
                </strong>
                <p>
                  {Object.entries(data.temps)
                    .map(([name, value]) => `${name} ${value.toFixed(0)}°C`)
                    .join(" · ") || "Temperature unavailable"}
                </p>
              </section>
            </div>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Storage</h2>
                  <p>A little room for your next obsession</p>
                </div>
              </div>
              <div className="storage-grid">
                {data.disks.map((disk) => (
                  <div key={disk.label} className="disk">
                    <div>
                      <strong>{disk.label}</strong>
                      <span>{bytes(disk.free)} free</span>
                    </div>
                    <Progress value={(disk.used / disk.total) * 100} />
                    <p>
                      {bytes(disk.used)} of {bytes(disk.total)} used
                      {disk.days_to_full != null
                        ? ` · estimated full in ${disk.days_to_full} days`
                        : ""}
                    </p>
                  </div>
                ))}
              </div>
            </section>
            <div className="system-grid">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Containers</h2>
                    <p>
                      {
                        data.containers.filter((c) => c.state === "running")
                          .length
                      }{" "}
                      of {data.containers.length} running
                    </p>
                  </div>
                </div>
                {data.containers.length ? (
                  data.containers.map((c) => (
                    <div className="container-row" key={c.name}>
                      <span
                        className={`status-dot ${c.state !== "running" || /unhealthy/.test(c.status) ? "status-warn" : ""}`}
                      />
                      <strong>{c.name}</strong>
                      <span>{c.status}</span>
                    </div>
                  ))
                ) : (
                  <Empty title="Container status unavailable">
                    Check the Docker proxy connection.
                  </Empty>
                )}
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>On the way</h2>
                    <p>Sonarr & Radarr download queue</p>
                  </div>
                </div>
                {data.queue.length ? (
                  data.queue.map((q, i) => (
                    <div className="download-row" key={`${q.title}-${i}`}>
                      <Badge
                        variant={
                          q.warning || q.status === "error"
                            ? "destructive"
                            : "secondary"
                        }
                      >
                        {q.app}
                      </Badge>
                      <strong>{q.title}</strong>
                      <p>
                        {q.status}
                        {q.timeleft ? ` · ${q.timeleft} left` : ""}
                      </p>
                      {q.progress != null && <Progress value={q.progress} />}
                    </div>
                  ))
                ) : (
                  <Empty title="All downloaded">
                    Your download queue is clear.
                  </Empty>
                )}
              </section>
            </div>
          </>
        )
      )}
    </>
  );
}
