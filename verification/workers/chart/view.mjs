// Reader's words for one ticket of vigil's worker pool.
const run = (v) => (v.runs && v.runs.length ? v.runs[0] : null);
export const title = "One ticket in vigil's worker pool";
export const state = (v) => {
  const r = run(v), stage = v.stage[1], ended = v.status[1] === "ended";
  const pend = v.inputs.own[1] || v.inputs.oth[1] ? ", message waiting" : "";
  let where;
  if (v.stopped[1]) where = "Stopped by owner";
  else if (ended) where = "Finished (ready)";
  else if (stage === "queued") where = "Queued";
  else if (stage === "failed") where = "Failed, waiting for a reply";
  else if (stage === "idle") where = "Idle, waiting for a reply";
  else if (stage === "review") where = "Ready, kept open for the waiting message";
  else if (stage === "working") where = "Working";
  else where = stage;
  if (r) {
    const ph = r.ph === "starting" ? "worker starting" : r.ph === "prompting" ? "turn in flight" : "run ending";
    return `${where}: ${ph}${pend}`;
  }
  return `${where}${pend}`;
};
export const group = (v) => (v.stopped[1] ? "stopped" : run(v) ? "running" : "resting");
export const colors = { stopped: "pink", running: "orange", resting: "blue" };
export const step = (action, from, to) => {
  if (action.startsWith("Stop")) return "the owner sends /stop";
  if (action.startsWith("OwnerMessage")) return "the owner writes to the ticket";
  switch (action) {
    case "TimerPump": return "the 15 s pump starts it";
    case "OwnerOrConciergeWrites": return "the owner writes to the ticket";
    case "OwnerStops": return "the owner sends /stop";
    case "SessionReady": return "the worker session is ready";
    case "SessionThrows": return "the session cannot start";
    case "WorkerCallsTool": return "the worker reports ready";
    case "TurnReturns": return to.stage[1] === "failed" ? "the model call fails" : "the model turn returns";
    case "RunSettles": return "the run ends";
    default: return action;
  }
};
