export type User = { id: string; name: string; admin: boolean };
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
