export type User = { id: string; name: string; admin: boolean };
export type SeerrConnection = {
  connected: boolean;
  linked: boolean;
  message: string;
  public_url: string;
  can_request_movie: boolean;
  can_request_tv: boolean;
};
export type PickFilters = {
  mode: "tonight" | "discover";
  viewers: string[];
  max_minutes: number | null;
  media_type: "all" | "movie" | "tv";
  genre: string;
  mood: string;
  unseen: boolean;
  variation: number;
};
export type Pick = {
  key: string;
  item_id?: string;
  play_item_id?: string;
  media_type: "movie" | "tv";
  media_id?: number;
  name: string;
  year?: number;
  genres: string[];
  overview: string;
  runtime_minutes: number | null;
  poster: string | null;
  status: string;
  reasons: string[];
  episode_label?: string;
  watch_url: string | null;
  seerr_url: string | null;
  imdb_url: string | null;
};
export type Picks = {
  items: Pick[];
  personalised: boolean;
  integration: SeerrConnection | null;
  candidate_count: number;
  library_limited: boolean;
  message: string;
};
export type PickOptions = {
  viewers: { id: string; name: string }[];
  genres: string[];
  moods: { value: string; name: string }[];
  integration: SeerrConnection;
};
export type RequestDetails = {
  name: string;
  status: string;
  can_request: boolean;
  partial_requests: boolean;
  seasons: {
    number: number;
    name: string;
    episodes: number;
    status: string;
    requestable: boolean;
  }[];
};
export type UserProfile = {
  id: string;
  name: string;
  image_tag: string | null;
  can_edit_image: boolean;
};
export type Media = {
  item_id: string;
  item_name: string;
  item_type: string;
  series_name?: string;
  series_id?: string;
  year?: number;
  season?: number;
  episode?: number;
  runtime_s?: number;
  resume_pct?: number;
  listed?: boolean;
};
export type Viewer = {
  user_id: string;
  user_name: string;
  seconds: number;
  peak_day_seconds: number;
  peak_day: string | null;
  consecutive_seconds: number;
  episodes: number;
  movies: number;
  active_days: number;
};
export type Metric =
  | "seconds"
  | "peak_day_seconds"
  | "consecutive_seconds"
  | "episodes"
  | "movies";
export type Analytics = {
  range: { start: string; end: string; timezone: string };
  tracking: {
    since: string;
    last_sample: string | null;
    error?: string | null;
    sample_seconds: number;
    completion_coverage: number;
    consecutive_gap_seconds: number;
  };
  users: Viewer[];
  leaders: Record<Metric, string[]>;
  totals: {
    seconds: number;
    episodes: number;
    movies: number;
    viewers: number;
  };
  daily: {
    date: string;
    seconds: number;
    episodes: number;
    movies: number;
    users: Record<string, number>;
  }[];
  breakdown: { Movie: number; Episode: number };
  top_titles: (Media & { seconds: number })[];
  recent: (Media & {
    user_id: string;
    user_name: string;
    at: string;
    id: string;
  })[];
};
export type Playing = Media & {
  user_id?: string;
  user: string;
  device: string;
  client: string;
  progress: number | null;
  paused: boolean;
  method: string;
  transcode_reasons: string[];
  hw_accel?: string;
};
export type Review = {
  user_id: string;
  user_name: string;
  score: number;
  note: string;
  updated_at: string;
};
export type RatedMedia = Media & { avg: number; reviews: Review[] };
export type WatchItem = Media & {
  added_by_name: string;
  note: string;
  in: string[];
  progress: Record<string, { watched?: number; total?: number; done: boolean }>;
  done: boolean;
  missing: boolean;
  can_remove: boolean;
};
export type Taste = {
  a: string;
  b: string;
  match: number;
  shared: number;
  fights: { item: string; a_score: number; b_score: number }[];
};
export type Activity = {
  id: string;
  user_id: string;
  user: string;
  item_id: string;
  series_id?: string;
  series_name?: string;
  type: string;
  name: string;
  at: string;
  seconds: number;
  completed: boolean;
  device: string;
  client: string;
};
export type ReportedActivity = {
  user_id?: string;
  at: string;
  user: string;
  name: string;
  seconds: number;
  method: string;
  device: string;
  client: string;
};
export type System = {
  disks: {
    label: string;
    total: number;
    used: number;
    free: number;
    days_to_full: number | null;
  }[];
  cpu: number | null;
  cores: number;
  load: number[];
  memory: { total: number; available: number };
  uptime: number;
  temps: Record<string, number>;
  containers: { name: string; state: string; status: string }[];
  queue: {
    app: string;
    title: string;
    status: string;
    progress?: number;
    warning?: boolean;
    timeleft?: string;
  }[];
  library: { MovieCount: number; SeriesCount: number; EpisodeCount: number };
};
