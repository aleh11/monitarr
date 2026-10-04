import { Film, LoaderCircle, RefreshCw, Tv, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Media } from "@/lib/types";
import { profileImageUrl, useProfiles } from "@/components/profile-context";

export function duration(seconds: number) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}m`;
}
export function watchTime(seconds: number) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}
export function bytes(value: number) {
  return value >= 1e12
    ? `${(value / 1e12).toFixed(1)} TB`
    : `${(value / 1e9).toFixed(1)} GB`;
}
export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}
export function Avatar({
  name,
  userId,
  index = 0,
}: {
  name: string;
  userId?: string;
  index?: number;
}) {
  const { profiles } = useProfiles();
  const profile = profiles.find((item) =>
    userId ? item.id === userId : item.name === name,
  );
  const src = profileImageUrl(profile);
  const [failed, setFailed] = useState<string>();
  return (
    <span className={`viewer-avatar avatar-${index % 5}`} aria-hidden="true">
      {src && failed !== src ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} />
      ) : (
        initials(name)
      )}
    </span>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Tv size={28} strokeWidth={1.3} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <TriangleAlert size={18} />
      <span>{message}</span>
      {retry && (
        <Button size="sm" variant="outline" onClick={retry}>
          <RefreshCw />
          Retry
        </Button>
      )}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading-grid" aria-label="Loading">
      <Skeleton className="h-24" />
      <Skeleton className="h-64" />
      <Skeleton className="h-40" />
    </div>
  );
}
export function BusyButton({
  busy,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button {...props} disabled={busy || props.disabled}>
      {busy && <LoaderCircle className="animate-spin" />}
      {children}
    </Button>
  );
}
export function title(media: Media) {
  return media.series_name || media.item_name;
}
export function episode(media: Media) {
  return media.season != null && media.episode != null
    ? `S${String(media.season).padStart(2, "0")} E${String(media.episode).padStart(2, "0")}`
    : media.item_type === "Episode"
      ? "Episode"
      : media.year || media.item_type;
}
export function Poster({
  media,
  children,
  onClick,
}: {
  media: Media;
  children?: ReactNode;
  onClick?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const content = (
    <>
      <div className="poster-art">
        {!failed ? (
          <img
            src={`/api/img/${media.series_id || media.item_id}`}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="poster-fallback">
            <Film size={30} strokeWidth={1} />
            <span>{title(media)}</span>
          </div>
        )}
        {children}
        {media.resume_pct ? (
          <div className="poster-resume">
            <span style={{ width: `${Math.min(100, media.resume_pct)}%` }} />
          </div>
        ) : null}
      </div>
      <strong>{title(media)}</strong>
      <span className="poster-subtitle">{episode(media)}</span>
    </>
  );
  return onClick ? (
    <button className="poster" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="poster">{content}</div>
  );
}
