import { useEffect, useState } from "react";
import { addDays, endOfMonth, format, startOfMonth, subMonths } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarDays, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type Range = { from: Date; to: Date };
export const browserTimezone =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export function todayIn(tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const number = (name: string) =>
    Number(parts.find((p) => p.type === name)?.value);
  return new Date(number("year"), number("month") - 1, number("day"));
}
export function currentMonth(tz: string): Range {
  const today = todayIn(tz);
  return { from: startOfMonth(today), to: today };
}
export function rangeQuery(range: Range, tz: string) {
  return new URLSearchParams({
    start: format(range.from, "yyyy-MM-dd"),
    end: format(range.to, "yyyy-MM-dd"),
    tz,
  }).toString();
}
export function DateFilter({
  range,
  onChange,
  tz,
  onTimezone,
}: {
  range: Range;
  onChange: (range: Range) => void;
  tz: string;
  onTimezone: (tz: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(range);
  useEffect(() => {
    setDraft(range);
  }, [range]);
  const today = todayIn(tz);
  const presets = [
    { name: "This month", from: startOfMonth(today), to: today },
    {
      name: "Last month",
      from: startOfMonth(subMonths(today, 1)),
      to: endOfMonth(subMonths(today, 1)),
    },
    { name: "Last 7 days", from: addDays(today, -6), to: today },
    { name: "Last 30 days", from: addDays(today, -29), to: today },
  ];
  return (
    <div className="date-controls">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="date-trigger">
            <CalendarDays />
            <span>
              {format(range.from, "d MMM")} – {format(range.to, "d MMM yyyy")}
            </span>
            <ChevronDown size={14} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="range-popover">
          <div className="range-presets">
            {presets.map((p) => (
              <Button
                key={p.name}
                variant="ghost"
                size="sm"
                onClick={() => {
                  onChange({ from: p.from, to: p.to });
                  setOpen(false);
                }}
              >
                {p.name}
              </Button>
            ))}
          </div>
          <Calendar
            mode="range"
            selected={draft}
            onSelect={(r, day) =>
              setDraft(
                draft.from && draft.to
                  ? { from: day, to: undefined }
                  : r || { from: undefined },
              )
            }
            defaultMonth={range.from}
            numberOfMonths={1}
            disabled={{ after: today, before: addDays(today, -365) }}
          />
          <div className="calendar-footer">
            <span>
              {draft.from ? format(draft.from, "d MMM") : "Start date"}
              {draft.to ? ` – ${format(draft.to, "d MMM")}` : ""}
            </span>
            <Button
              size="sm"
              disabled={!draft.from || !draft.to}
              onClick={() => {
                if (draft.from && draft.to) {
                  onChange({ from: draft.from, to: draft.to });
                  setOpen(false);
                }
              }}
            >
              Apply range
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <Select value={tz} onValueChange={onTimezone}>
        <SelectTrigger className="timezone-trigger" aria-label="Timezone">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Array.from(
            new Set([
              browserTimezone,
              "UTC",
              "Africa/Johannesburg",
              "Europe/London",
              "America/New_York",
              "America/Los_Angeles",
              "Asia/Tokyo",
              "Australia/Sydney",
            ]),
          ).map((zone) => (
            <SelectItem key={zone} value={zone}>
              {zone.replaceAll("_", " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
