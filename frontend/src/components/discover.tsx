import { useEffect, useRef, useState } from "react";
import {
  Check,
  Clock3,
  Compass,
  ExternalLink,
  Film,
  Play,
  Plus,
  RefreshCw,
  ThumbsDown,
  Tv,
} from "lucide-react";
import { api, post, useResource } from "@/lib/api";
import type {
  Pick,
  PickFilters,
  PickOptions,
  Picks,
  RequestDetails,
  SeerrConnection,
  User,
} from "@/lib/types";
import {
  Avatar,
  BusyButton,
  Empty,
  ErrorState,
  Loading,
} from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const statusNames: Record<string, string> = {
  available: "Ready to watch",
  missing: "Not in your library",
  pending: "Awaiting approval",
  processing: "Approved · processing",
  partial: "Some seasons available",
  failed: "Request failed",
  declined: "Request declined",
};

export function DiscoverPage({ user }: { user: User }) {
  const options = useResource<PickOptions>(
    "/api/recommendations/options",
    60000,
  );
  const [filters, setFilters] = useState<PickFilters>({
    mode: "tonight",
    viewers: [user.id],
    max_minutes: 120,
    media_type: "all",
    genre: "any",
    mood: "any",
    unseen: true,
    variation: 0,
  });
  const [data, setData] = useState<Picks>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [requesting, setRequesting] = useState<Pick | null>(null);
  const [feedback, setFeedback] = useState<{
    key: string;
    name: string;
    action: string;
  }>();
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const connection = data?.integration || options.data?.integration;
  const canDiscover = options.data?.integration.linked;
  useEffect(() => {
    if (!options.data) return;
    const controller = new AbortController();
    setError("");
    setData(undefined);
    setLoading(true);
    if (filters.mode === "discover" && !canDiscover) {
      setLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      void api<Picks>("/api/recommendations", {
        method: "POST",
        body: JSON.stringify(filters),
        signal: controller.signal,
      })
        .then((result) => {
          if (!controller.signal.aborted) setData(result);
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setError(e instanceof Error ? e.message : "Unable to find picks");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [filters, version, canDiscover, !!options.data]);
  useEffect(() => {
    if (filters.mode !== "discover" || !data || requesting || busy) return;
    const controller = new AbortController();
    let pending = false;
    const timer = window.setInterval(() => {
      if (document.hidden || pending) return;
      pending = true;
      void api<Picks>("/api/recommendations", {
        method: "POST",
        body: JSON.stringify(filters),
        signal: controller.signal,
      })
        .then((result) => {
          if (!controller.signal.aborted) setData(result);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setMutationError(
              "Couldn’t refresh request statuses. Choose another lineup to try again.",
            );
        })
        .finally(() => {
          pending = false;
        });
    }, 60000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [filters, !!data, requesting, busy]);
  function update<K extends keyof PickFilters>(key: K, value: PickFilters[K]) {
    setFilters((previous) => ({ ...previous, [key]: value, variation: 0 }));
  }
  async function sendFeedback(pick: Pick, action: "seen" | "not_interested") {
    setBusy(true);
    setMutationError("");
    try {
      await post("/api/recommendations/feedback", { key: pick.key, action });
      setNotice("");
      setFeedback({ key: pick.key, name: pick.name, action });
      setData((previous) =>
        previous
          ? {
              ...previous,
              items: previous.items.filter((item) => item.key !== pick.key),
            }
          : previous,
      );
    } catch (e) {
      setMutationError(
        e instanceof Error ? e.message : "Unable to save feedback",
      );
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    if (!feedback) return;
    setBusy(true);
    setMutationError("");
    try {
      await post("/api/recommendations/feedback", {
        key: feedback.key,
        action: null,
      });
      setFeedback(undefined);
      setVersion((value) => value + 1);
    } catch (e) {
      setMutationError(
        e instanceof Error ? e.message : "Unable to undo feedback",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-intro discover-intro">
        <h1>What are we watching?</h1>
        <p>A pick for your taste. A plan for your night.</p>
      </div>
      <Tabs
        value={filters.mode}
        onValueChange={(value) => update("mode", value as PickFilters["mode"])}
        className="discover-tabs"
      >
        <TabsList aria-label="Recommendation source">
          <TabsTrigger value="tonight">
            <Play />
            Watch tonight
          </TabsTrigger>
          <TabsTrigger value="discover">
            <Compass />
            Discover & request
          </TabsTrigger>
        </TabsList>
        <TabsContent value={filters.mode}>
          {options.error ? (
            <ErrorState message={options.error} retry={options.reload} />
          ) : options.loading && !options.data ? (
            <Loading />
          ) : (
            options.data && (
              <>
                <section
                  className="pick-filters panel"
                  aria-label="Recommendation filters"
                >
                  <div className="pick-viewers">
                    <h2>Who’s watching?</h2>
                    <p>
                      You’re included. Add up to three people for a shared pick.
                    </p>
                    <div className="viewer-choices">
                      {options.data.viewers.map((viewer) => (
                        <Button
                          key={viewer.id}
                          variant={
                            filters.viewers.includes(viewer.id)
                              ? "secondary"
                              : "outline"
                          }
                          aria-pressed={filters.viewers.includes(viewer.id)}
                          aria-label={`Include ${viewer.name}`}
                          disabled={
                            viewer.id === user.id ||
                            (!filters.viewers.includes(viewer.id) &&
                              filters.viewers.length >= 4)
                          }
                          onClick={() =>
                            update(
                              "viewers",
                              filters.viewers.includes(viewer.id)
                                ? filters.viewers.filter(
                                    (id) => id !== viewer.id,
                                  )
                                : [...filters.viewers, viewer.id],
                            )
                          }
                        >
                          <Avatar name={viewer.name} userId={viewer.id} />
                          {viewer.name}
                          {filters.viewers.includes(viewer.id) && (
                            <Check size={14} />
                          )}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="pick-controls">
                    <PickSelect
                      label="Time available"
                      value={filters.max_minutes?.toString() || "any"}
                      onChange={(value) =>
                        update(
                          "max_minutes",
                          value === "any" ? null : Number(value),
                        )
                      }
                      choices={[
                        { value: "any", name: "No time limit" },
                        ...[30, 60, 90, 120, 180].map((minutes) => ({
                          value: String(minutes),
                          name: `Up to ${minutes} minutes`,
                        })),
                      ]}
                    />
                    <PickSelect
                      label="Movie or show"
                      value={filters.media_type}
                      onChange={(value) =>
                        update("media_type", value as PickFilters["media_type"])
                      }
                      choices={[
                        { value: "all", name: "Movies & shows" },
                        { value: "movie", name: "Movies" },
                        { value: "tv", name: "Shows" },
                      ]}
                    />
                    <PickSelect
                      label="Genre"
                      value={filters.genre}
                      onChange={(value) => update("genre", value)}
                      choices={[
                        { value: "any", name: "Any genre" },
                        ...options.data.genres.map((name) => ({
                          value: name,
                          name,
                        })),
                      ]}
                    />
                    <PickSelect
                      label="Mood"
                      value={filters.mood}
                      onChange={(value) => update("mood", value)}
                      choices={options.data.moods}
                    />
                  </div>
                  <div className="pick-filter-foot">
                    <Button
                      variant="ghost"
                      aria-pressed={filters.unseen}
                      onClick={() => update("unseen", !filters.unseen)}
                    >
                      <span
                        className={`pick-check ${filters.unseen ? "checked" : ""}`}
                      >
                        {filters.unseen && <Check size={13} />}
                      </span>
                      Nobody has watched it
                    </Button>
                    <Button
                      variant="outline"
                      disabled={loading}
                      onClick={() =>
                        setFilters((previous) => ({
                          ...previous,
                          variation: (previous.variation + 1) % 10000,
                        }))
                      }
                    >
                      <RefreshCw />
                      Another lineup
                    </Button>
                  </div>
                </section>
                {mutationError && <ErrorState message={mutationError} />}
                {(feedback || notice) && (
                  <div className="pick-notice" role="status">
                    <span>
                      {notice ||
                        `${feedback?.name}: ${feedback?.action === "seen" ? "marked already seen" : "hidden from your picks"}.`}
                    </span>
                    {feedback && !notice && (
                      <BusyButton
                        variant="ghost"
                        size="sm"
                        busy={busy}
                        onClick={() => void undo()}
                      >
                        Undo
                      </BusyButton>
                    )}
                    {notice && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setNotice("")}
                      >
                        Dismiss
                      </Button>
                    )}
                  </div>
                )}
                {filters.mode === "discover" && !canDiscover ? (
                  <div className="panel connection-empty">
                    <Empty title="Connect your Seerr account">
                      {options.data.integration.message}
                    </Empty>
                    {options.data.integration.public_url && (
                      <Button asChild variant="outline">
                        <a
                          href={options.data.integration.public_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open Seerr
                          <ExternalLink />
                        </a>
                      </Button>
                    )}
                    <Button variant="ghost" onClick={options.reload}>
                      Check connection
                    </Button>
                  </div>
                ) : error ? (
                  <ErrorState
                    message={error}
                    retry={() => setVersion((v) => v + 1)}
                  />
                ) : loading ? (
                  <Loading />
                ) : data?.items.length ? (
                  <>
                    <div className="pick-results-heading">
                      <div>
                        <h2>
                          {filters.mode === "tonight"
                            ? "Tonight’s pick"
                            : "Your next discovery"}
                        </h2>
                        <p>
                          {data.personalised
                            ? "Chosen with your circle’s ratings in mind."
                            : "A starting lineup. Your ratings will make it more personal."}
                        </p>
                      </div>
                      <span>
                        {filters.mode === "tonight"
                          ? "In your Jellyfin library"
                          : "Not ready to watch yet"}
                      </span>
                    </div>
                    <PickCard
                      pick={data.items[0]}
                      featured
                      connection={connection}
                      busy={busy}
                      onRequest={setRequesting}
                      onFeedback={(pick, action) =>
                        void sendFeedback(pick, action)
                      }
                    />
                    {data.items.length > 1 && (
                      <section
                        className="pick-alternatives"
                        aria-label="More recommendations"
                      >
                        <h2>A few other good calls</h2>
                        <div className="pick-grid">
                          {data.items.slice(1).map((pick) => (
                            <PickCard
                              key={pick.key}
                              pick={pick}
                              connection={connection}
                              busy={busy}
                              onRequest={setRequesting}
                              onFeedback={(item, action) =>
                                void sendFeedback(item, action)
                              }
                            />
                          ))}
                        </div>
                      </section>
                    )}
                    <p className="pick-method">
                      {data.message}{" "}
                      {data.library_limited &&
                        "These picks use the 10,000 most recently added titles in each library."}
                      {filters.mode === "discover" &&
                        " Catalogue metadata and artwork from TMDB through Seerr."}
                    </p>
                  </>
                ) : (
                  <div className="panel">
                    <Empty title="Let’s widen the search">
                      Try more time, another mood or allow titles someone has
                      already watched.
                    </Empty>
                    <div className="empty-actions">
                      <Button
                        variant="outline"
                        onClick={() =>
                          setFilters((previous) => ({
                            ...previous,
                            max_minutes: null,
                            genre: "any",
                            mood: "any",
                            media_type: "all",
                            unseen: false,
                          }))
                        }
                      >
                        Clear filters
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )
          )}
        </TabsContent>
      </Tabs>
      {requesting && (
        <RequestDialog
          key={requesting.key}
          pick={requesting}
          onClose={() => setRequesting(null)}
          onRequested={(status) => {
            setNotice(
              `${requesting.name}: ${statusNames[status] || "Requested"}.`,
            );
            setFeedback(undefined);
            setData((previous) =>
              previous
                ? {
                    ...previous,
                    items: previous.items.map((item) =>
                      item.key === requesting.key ? { ...item, status } : item,
                    ),
                  }
                : previous,
            );
            options.reload();
            setRequesting(null);
          }}
        />
      )}
    </>
  );
}

function PickSelect({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string;
  choices: { value: string; name: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="pick-control">
      <span>{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Artwork({ pick }: { pick: Pick }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="pick-artwork">
      {pick.poster && !failed ? (
        <img
          src={pick.poster}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="pick-artwork-fallback">
          <Film size={36} strokeWidth={1} />
          <span>{pick.name}</span>
        </div>
      )}
    </div>
  );
}

function PickCard({
  pick,
  featured,
  connection,
  busy,
  onRequest,
  onFeedback,
}: {
  pick: Pick;
  featured?: boolean;
  connection?: SeerrConnection;
  busy: boolean;
  onRequest: (pick: Pick) => void;
  onFeedback: (pick: Pick, action: "seen" | "not_interested") => void;
}) {
  const canRequest =
    connection?.[
      pick.media_type === "movie" ? "can_request_movie" : "can_request_tv"
    ];
  const hasRequest = ["pending", "processing", "failed", "declined"].includes(
    pick.status,
  );
  return (
    <article
      className={`pick-card ${featured ? "pick-featured" : ""}`}
      aria-label={pick.name}
    >
      <Artwork key={pick.key} pick={pick} />
      <div className="pick-content">
        <Badge variant="secondary" className="pick-status">
          {pick.status === "available" ? (
            <Play size={12} />
          ) : (
            <Clock3 size={12} />
          )}
          {statusNames[pick.status] || "Not in your library"}
        </Badge>
        <h3>{pick.name}</h3>
        <div className="pick-meta">
          <span>
            {pick.media_type === "movie" ? (
              <Film size={14} />
            ) : (
              <Tv size={14} />
            )}
            {pick.media_type === "movie" ? "Movie" : "Show"}
          </span>
          {pick.year && <span>{pick.year}</span>}
          {pick.runtime_minutes ? (
            <span>
              {Math.round(pick.runtime_minutes)}m
              {pick.media_type === "tv" ? " / episode" : ""}
            </span>
          ) : (
            <span>Runtime unknown</span>
          )}
        </div>
        {pick.episode_label && (
          <p className="pick-episode">{pick.episode_label}</p>
        )}
        {pick.overview && <p className="pick-overview">{pick.overview}</p>}
        <ul className="pick-reasons">
          {pick.reasons.slice(0, featured ? 5 : 2).map((reason) => (
            <li key={reason}>
              <Check size={14} />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
        <div className="pick-actions">
          {pick.status === "available" ? (
            pick.watch_url ? (
              <Button asChild>
                <a
                  href={pick.watch_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Play />
                  Watch now
                </a>
              </Button>
            ) : (
              <span className="pick-permission">
                Open this title in your Jellyfin app.
              </span>
            )
          ) : hasRequest ? (
            pick.seerr_url && (
              <Button asChild variant="outline">
                <a
                  href={pick.seerr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View in Seerr
                  <ExternalLink />
                </a>
              </Button>
            )
          ) : (
            <Button disabled={!canRequest} onClick={() => onRequest(pick)}>
              <Plus />
              {pick.media_type === "tv" ? "Choose seasons" : "Request movie"}
            </Button>
          )}
          {pick.imdb_url && (
            <Button asChild variant="ghost" size="sm">
              <a href={pick.imdb_url} target="_blank" rel="noopener noreferrer">
                IMDb
                <ExternalLink size={13} />
              </a>
            </Button>
          )}
        </div>
        {!canRequest && pick.status !== "available" && !hasRequest && (
          <p className="pick-permission">
            Your Seerr permissions or request limit don’t allow this request
            right now.
          </p>
        )}
        <div className="pick-feedback">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onFeedback(pick, "not_interested")}
          >
            <ThumbsDown />
            Not interested
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onFeedback(pick, "seen")}
          >
            <Check />
            Already seen
          </Button>
        </div>
      </div>
    </article>
  );
}

function RequestDialog({
  pick,
  onClose,
  onRequested,
}: {
  pick: Pick;
  onClose: () => void;
  onRequested: (status: string) => void;
}) {
  const detail = useResource<RequestDetails>(
    `/api/seerr/${pick.media_type}/${pick.media_id}`,
  );
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const initialised = useRef(false);
  useEffect(() => {
    if (!detail.data) return;
    const available = detail.data.seasons
      .filter((season) => season.requestable)
      .map((season) => season.number);
    if (!initialised.current || !detail.data.partial_requests) {
      setSelected(
        detail.data.partial_requests ? available.slice(0, 1) : available,
      );
      initialised.current = true;
    } else
      setSelected((previous) =>
        previous.filter((number) => available.includes(number)),
      );
  }, [detail.data]);
  async function request() {
    setBusy(true);
    setError("");
    try {
      const result = await post<{ status: string }>("/api/seerr/request", {
        media_type: pick.media_type,
        media_id: pick.media_id,
        seasons: pick.media_type === "tv" ? selected : [],
      });
      onRequested(result.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to request this title");
      detail.reload();
    } finally {
      setBusy(false);
    }
  }
  const blocked =
    !detail.data?.can_request ||
    detail.data.status === "available" ||
    detail.data.status === "blocked" ||
    (pick.media_type === "movie" &&
      ["pending", "processing", "failed"].includes(detail.data.status));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="request-dialog"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Request {pick.name}</DialogTitle>
          <DialogDescription>
            This request belongs to your Seerr account and follows its approval
            rules.
          </DialogDescription>
        </DialogHeader>
        {detail.error ? (
          <ErrorState message={detail.error} retry={detail.reload} />
        ) : detail.loading && !detail.data ? (
          <Loading />
        ) : (
          detail.data && (
            <>
              <Badge variant="secondary">
                {statusNames[detail.data.status] || "Not in your library"}
              </Badge>
              {pick.media_type === "tv" && (
                <>
                  <p>
                    {detail.data.partial_requests
                      ? "Choose the seasons you want."
                      : "Your Seerr requires all missing seasons together."}
                  </p>
                  <div className="request-seasons">
                    {detail.data.seasons.map((season) => (
                      <Button
                        key={season.number}
                        variant={
                          selected.includes(season.number)
                            ? "secondary"
                            : "outline"
                        }
                        aria-pressed={selected.includes(season.number)}
                        disabled={
                          !season.requestable ||
                          !detail.data?.partial_requests ||
                          busy
                        }
                        onClick={() =>
                          setSelected((previous) =>
                            previous.includes(season.number)
                              ? previous.filter(
                                  (number) => number !== season.number,
                                )
                              : [...previous, season.number],
                          )
                        }
                      >
                        <span>
                          {season.name}
                          <small>
                            {season.episodes} episodes ·{" "}
                            {season.status === "missing"
                              ? "Not requested"
                              : season.status === "requested"
                                ? "Already requested"
                                : "Available"}
                          </small>
                        </span>
                        {selected.includes(season.number) && (
                          <Check size={16} />
                        )}
                      </Button>
                    ))}
                  </div>
                </>
              )}
              {blocked && (
                <p className="pick-permission">
                  This title is already available, requested, or your Seerr
                  account cannot request it right now.
                </p>
              )}
              {error && <ErrorState message={error} />}
              <div className="dialog-actions">
                <Button variant="outline" disabled={busy} onClick={onClose}>
                  Cancel
                </Button>
                <BusyButton
                  busy={busy}
                  disabled={
                    blocked ||
                    detail.loading ||
                    (pick.media_type === "tv" && !selected.length)
                  }
                  onClick={() => void request()}
                >
                  Request through Seerr
                </BusyButton>
              </div>
            </>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
