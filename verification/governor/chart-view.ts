// Reader's words for the governor chart: one notice, the default-like policy (quiet 00-08, digest at 16:00).
const notice: Record<string, string> = {
  none: "No notice yet",
  queued: "Waiting for the digest",
  held: "Held for the morning",
  delivered: "Sent on its own",
  digested: "Sent in a digest",
  dropped: "Dropped",
  expired: "Expired unsent",
};
const clock = ["Night (quiet hours)", "Day", "Evening"];
export const state = (v: any) => ({ Notice: notice[v.st[1]], Clock: clock[v.now % 3] });
export const step = (action: string) =>
  ({
    OfferAny: "a notice comes in",
    Tick: "the 30-second tick runs",
    Advance: "time passes",
    DigestCommand: "you send /digest",
  })[action] ?? action;
export const title = "Attention governor: one notice through a day";
