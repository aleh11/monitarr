export const themes = [
  { value: "midnight", name: "Midnight", light: false },
  { value: "daylight", name: "Daylight", light: true },
  { value: "plum", name: "Plum", light: false },
  { value: "lavender", name: "Lavender", light: true },
  { value: "cyber", name: "Cyber", light: false },
  { value: "cinema", name: "Cinema", light: false },
  { value: "tron", name: "Tron Evolution", light: false },
] as const;

export type Theme = (typeof themes)[number]["value"] | "system";
