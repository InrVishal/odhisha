import type { Tone } from "@/components/dashboard/ui";

export function statusTone(status: string): Tone {
  if (status === "completed") return "good";
  if (status === "queued" || status === "running" || status === "quoted") return "warn";
  if (status === "deadline_missed" || status === "failed") return "bad";
  return "neutral";
}
