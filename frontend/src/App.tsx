import { Suspense, lazy, useEffect, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowUpRight,
  History,
  LogOut,
  Menu,
  MonitorPlay,
  Moon,
  Palette,
  Radio,
  Star,
  Sun,
  Trophy,
  Tv,
  X,
} from "lucide-react";
import { api, ApiError, post, useResource } from "@/lib/api";
import type { Analytics, User } from "@/lib/types";
import { themes, type Theme } from "@/lib/themes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Avatar, BusyButton, ErrorState, Loading } from "@/components/shared";
import { ProfileProvider } from "@/components/profile-context";
import { ProfileDialog } from "@/components/profile-dialog";
import {
  DateFilter,
  browserTimezone,
  currentMonth,
  rangeQuery,
  type Range,
} from "@/components/date-filter";
const Leaderboard = lazy(() =>
  import("@/components/leaderboard").then((module) => ({
    default: module.Leaderboard,
  })),
);
import {
  HistoryPage,
  NowPage,
  RatingsPage,
  SystemPage,
  WatchPage,
} from "@/components/pages";

const nav = [
  { id: "now", name: "Now playing", icon: Radio },
  { id: "watch", name: "Watchlist", icon: MonitorPlay },
  { id: "board", name: "Leaderboard", icon: Trophy },
  { id: "ratings", name: "Ratings", icon: Star },
  { id: "history", name: "History", icon: History },
  { id: "system", name: "System", icon: Activity },
] as const;
export type Tab = (typeof nav)[number]["id"];
function stored(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const value = stored("monitor:theme", "midnight");
    return value === "system" || themes.some((option) => option.value === value)
      ? (value as Theme)
      : "midnight";
  });
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      const resolved =
        theme === "system" ? (media.matches ? "midnight" : "daylight") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.classList.toggle(
        "dark",
        !themes.find((option) => option.value === resolved)?.light,
      );
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute(
          "content",
          getComputedStyle(document.documentElement)
            .getPropertyValue("--background")
            .trim(),
        );
    };
    update();
    save("monitor:theme", theme);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);
  async function boot() {
    setError("");
    try {
      setUser(await api<User>("/api/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
      else
        setError(
          e instanceof Error ? e.message : "Unable to connect to Monitor",
        );
    }
  }
  useEffect(() => {
    void boot();
    const unauthorized = () => setUser(null);
    window.addEventListener("monitor:unauthorized", unauthorized);
    return () =>
      window.removeEventListener("monitor:unauthorized", unauthorized);
  }, []);
  const themeOptions = (
    <Select value={theme} onValueChange={(value) => setTheme(value as Theme)}>
      <SelectTrigger aria-label="Theme">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {themes.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.name}
          </SelectItem>
        ))}
        <SelectItem value="system">System preference</SelectItem>
      </SelectContent>
    </Select>
  );
  return (
    <TooltipProvider>
      <>
        {user === undefined ? (
          <div className="boot-screen">
            <Brand />
            {error ? (
              <ErrorState message={error} retry={() => void boot()} />
            ) : (
              <Loading />
            )}
          </div>
        ) : user === null ? (
          <Login
            onLogin={setUser}
            theme={theme}
            onTheme={() => setSettings(true)}
          />
        ) : (
          <ProfileProvider>
            <Dashboard
              user={user}
              onLogout={() => setUser(null)}
              onTheme={() => setSettings(true)}
            />
          </ProfileProvider>
        )}
        <Dialog open={settings} onOpenChange={setSettings}>
          <DialogContent className="theme-dialog">
            <DialogHeader>
              <DialogTitle>Set the mood</DialogTitle>
              <DialogDescription>
                A different look for every kind of night. Your choice is saved
                on this device.
              </DialogDescription>
            </DialogHeader>
            <div className="theme-options">
              {themes.map(({ value, name }) => (
                <button
                  key={value}
                  className={`theme-option ${theme === value ? "theme-selected" : ""}`}
                  aria-pressed={theme === value}
                  onClick={() => setTheme(value)}
                >
                  <span className="theme-preview" data-theme={value}>
                    <i />
                    <i />
                    <i />
                  </span>
                  <strong>{name}</strong>
                </button>
              ))}
            </div>
            {themeOptions}
            <Button onClick={() => setSettings(false)}>Done</Button>
          </DialogContent>
        </Dialog>
      </>
    </TooltipProvider>
  );
}
function Brand() {
  return (
    <span className="brand">
      <span className="brand-symbol">
        <Tv size={21} strokeWidth={1.9} />
      </span>
      monitor<span className="brand-dot">.</span>
    </span>
  );
}
function Login({
  onLogin,
  theme,
  onTheme,
}: {
  onLogin: (user: User) => void;
  theme: Theme;
  onTheme: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await post<User>("/api/login", { username, password });
      setPassword("");
      onLogin(user);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to log in");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-layout">
      <header>
        <Brand />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Choose theme"
          onClick={onTheme}
        >
          {themes.find((option) => option.value === theme)?.light ? (
            <Sun />
          ) : (
            <Moon />
          )}
        </Button>
      </header>
      <div className="login-content">
        <div className="login-editorial">
          <div className="login-reels" aria-hidden="true">
            <div />
            <div />
            <div />
          </div>
          <h1>
            Every watch
            <br />
            has a story.
          </h1>
          <p>
            Your nights in. Your shared picks.
            <br />A little competition along the way.
          </p>
        </div>
        <form className="login-form panel" onSubmit={(e) => void login(e)}>
          <h2>Welcome back.</h2>
          <p>Sign in with your Jellyfin account.</p>
          <label htmlFor="username">Username</label>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <label htmlFor="password">Password</label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <ErrorState message={error} />}
          <BusyButton busy={busy} type="submit">
            Sign in
            <ArrowUpRight />
          </BusyButton>
          <span className="login-hint">The same account you use to watch.</span>
        </form>
      </div>
      <footer>Your viewing, in perspective.</footer>
    </div>
  );
}
function Dashboard({
  user,
  onLogout,
  onTheme,
}: {
  user: User;
  onLogout: () => void;
  onTheme: () => void;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = stored("monitor:tab", "board");
    return nav.some((n) => n.id === saved) ? (saved as Tab) : "board";
  });
  const [mobileNav, setMobileNav] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  useEffect(() => {
    if (!mobileNav) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNav(false);
    };
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", close);
    };
  }, [mobileNav]);
  const [timezone, setTimezone] = useState(() => {
    const zone = stored("monitor:timezone", browserTimezone);
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return zone;
    } catch {
      return browserTimezone;
    }
  });
  const [range, setRange] = useState<Range>(() => currentMonth(timezone));
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const query = rangeQuery(range, timezone);
  const analytics = useResource<Analytics>(`/api/analytics?${query}`, 15000);
  function changeTab(value: Tab) {
    setTab(value);
    save("monitor:tab", value);
    setMobileNav(false);
  }
  function changeTimezone(value: string) {
    setTimezone(value);
    save("monitor:timezone", value);
  }
  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      await post("/api/logout");
      onLogout();
    } catch (e) {
      setLogoutError(e instanceof Error ? e.message : "Unable to sign out");
    } finally {
      setLoggingOut(false);
    }
  }
  const stale = analytics.data?.tracking.last_sample
    ? Date.now() - Date.parse(analytics.data.tracking.last_sample) > 30000
    : true;
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "nav-open" : ""}`}>
        <div className="sidebar-brand">
          <Brand />
          <Button
            size="icon"
            variant="ghost"
            className="nav-close"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          >
            <X />
          </Button>
        </div>
        <div className="sidebar-caption">Your nights in, together.</div>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <button
              className={tab === n.id ? "active" : ""}
              key={n.id}
              onClick={() => changeTab(n.id)}
              aria-current={tab === n.id ? "page" : undefined}
            >
              <n.icon size={19} strokeWidth={1.7} />
              <span>{n.name}</span>
              {tab === n.id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span
              className={`status-dot ${analytics.error || analytics.data?.tracking.error || stale ? "status-warn" : ""}`}
            />
            <div>
              <strong>
                {analytics.error || analytics.data?.tracking.error || stale
                  ? "Tracking waiting"
                  : "Playback tracking"}
              </strong>
              <span>
                {analytics.data?.tracking.error
                  ? "Reconnecting to Jellyfin"
                  : stale
                    ? "Awaiting a fresh sample"
                    : "Watching the watches"}
              </span>
            </div>
          </div>
          <button className="theme-button" onClick={onTheme}>
            <Palette size={18} />
            Set the mood
          </button>
          <div className="account-row">
            <button
              className="profile-button"
              aria-label="Edit profile picture"
              onClick={() => {
                setMobileNav(false);
                setProfileOpen(true);
              }}
            >
              <Avatar name={user.name} userId={user.id} />
            </button>
            <div>
              <strong>{user.name}</strong>
              <span>{user.admin ? "Administrator" : "Jellyfin viewer"}</span>
            </div>
            <Button
              size="icon"
              variant="ghost"
              disabled={loggingOut}
              aria-label="Sign out"
              onClick={() => void logout()}
            >
              <LogOut size={17} />
            </Button>
          </div>
        </div>
      </aside>
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="Dismiss navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-location">
            <Button
              variant="ghost"
              size="icon"
              className="nav-toggle"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu />
            </Button>
            <span>Your circle</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{nav.find((n) => n.id === tab)?.name}</strong>
          </div>
          {["board", "history", "now"].includes(tab) ? (
            <DateFilter
              range={range}
              onChange={setRange}
              tz={timezone}
              onTimezone={changeTimezone}
            />
          ) : (
            <Button variant="ghost" size="sm" onClick={onTheme}>
              <Palette />
              Set the mood
            </Button>
          )}
        </header>
        <main>
          {logoutError && <ErrorState message={logoutError} />}
          {["board", "now"].includes(tab) && analytics.error && (
            <ErrorState message={analytics.error} retry={analytics.reload} />
          )}
          {tab === "board" &&
            (analytics.loading && !analytics.data ? (
              <Loading />
            ) : analytics.data ? (
              <Suspense fallback={<Loading />}>
                <Leaderboard data={analytics.data} />
              </Suspense>
            ) : null)}
          {tab === "now" && <NowPage analytics={analytics.data} />}
          {tab === "watch" && <WatchPage user={user} />}
          {tab === "ratings" && <RatingsPage user={user} />}
          {tab === "history" && (
            <HistoryPage query={query} timezone={timezone} />
          )}
          {tab === "system" && <SystemPage />}
        </main>
        <footer className="app-footer">
          <span>monitor.</span>
          <span>For the love of a good night in.</span>
        </footer>
      </div>
      <ProfileDialog
        user={user}
        open={profileOpen}
        onOpenChange={setProfileOpen}
      />
    </div>
  );
}
