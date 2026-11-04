// The panel: one small web page served by the daemon. It lists first what waits for the owner
// (approvals, questions, blocked work, failing messages); a healthy state takes no space.

import type { RouteHandler } from "../channels/http.ts";
import { saveConfig } from "../config.ts";
import type { Daemon } from "../daemon.ts";

export interface PanelState {
	now: number;
	paused: boolean;
	mode: string;
	budget: ReturnType<Daemon["s"]["notifier"]["budget"]>;
	needsYou: { kind: string; id: string; title: string; detail: string; actions?: { label: string; data: string }[] }[];
	working: { id: string; title: string; stage: string; updated: number }[];
	waiting: { id: string; urgency: string; topic: string; text: string; created: number }[];
	jobs: { id: string; name: string; when: string; next: number | null; action: string; system: boolean; last: string | null }[];
	watchers: { id: string; name: string; target: string; every: number; error: string | null }[];
	events: { at: number; kind: string; text: string }[];
	/** What observe mode would have done in the last week; the case for switching to auto. */
	observed: { at: number; text: string }[];
	model: string | null;
}

function approvalText(tool: string, args: string): string {
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		if (tool === "bash" && typeof parsed.command === "string") return parsed.command.slice(0, 400);
		if (typeof parsed.path === "string") return parsed.path;
	} catch {}
	return args.slice(0, 400);
}

export function panelState(d: Daemon): PanelState {
	const s = d.s;
	const needsYou: PanelState["needsYou"] = [];
	for (const a of s.approvals.pending()) {
		needsYou.push({
			kind: "approval",
			id: a.id,
			title: `${a.requester} wants to run ${a.tool}`,
			detail: `${a.reason}: ${approvalText(a.tool, a.args)}`,
			actions: [
				{ label: "Approve", data: `approve:${a.id}` },
				{ label: "Deny", data: `deny:${a.id}` },
			],
		});
	}
	for (const q of s.db.all<{ id: string; ticket_id: string; question: string; choices: string }>("SELECT * FROM attentions WHERE status = 'open' ORDER BY created_at")) {
		const choices = JSON.parse(q.choices) as string[];
		needsYou.push({
			kind: "question",
			id: q.id,
			title: s.tickets.get(q.ticket_id)?.title ?? q.ticket_id,
			detail: q.question,
			actions: choices.map((c, i) => ({ label: c, data: `answer:${q.id}:${i}` })),
		});
	}
	const open = s.tickets.list("open");
	for (const t of open.filter((t) => t.stage === "blocked" || t.stage === "failed")) {
		needsYou.push({ kind: t.stage, id: t.id, title: t.title, detail: t.last_report?.summary ?? "" });
	}
	for (const p of s.outbox.problems()) {
		needsYou.push({ kind: "message failing", id: String(p.id), title: `to ${p.channel}, ${p.attempts} attempts`, detail: `${p.last_error ?? ""} — ${p.text.slice(0, 120)}` });
	}
	const tz = s.cfg.owner.timezone;
	const model = s.models.pick("concierge");
	return {
		now: s.clock.now(),
		paused: s.paused(),
		mode: s.cfg.proactive.mode,
		budget: s.notifier.budget(),
		needsYou,
		working: open.filter((t) => t.stage !== "blocked" && t.stage !== "failed").map((t) => ({ id: t.id, title: t.title, stage: t.stage, updated: t.updated_at })),
		waiting: s.notifier.waiting().map((n) => ({ id: n.id, urgency: n.effective, topic: n.topic, text: n.text, created: n.createdAt })),
		jobs: s.scheduler.list().map((j) => ({
			id: j.id,
			name: j.name,
			when: `${j.kind} ${j.spec}`,
			next: j.enabled ? j.next_run_at : null,
			action: j.action,
			system: j.created_by === "system",
			last: j.last_status,
		})),
		watchers: s.watchers.list().map((w) => ({ id: w.id, name: w.name, target: w.target, every: w.every_minutes, error: w.last_error })),
		events: s.db.all<{ at: number; kind: string; text: string }>("SELECT at, kind, text FROM events ORDER BY id DESC LIMIT 40"),
		observed: s.db.all<{ at: number; text: string }>("SELECT at, text FROM events WHERE kind = 'observe' AND at > ? ORDER BY id DESC LIMIT 20", s.clock.now() - 7 * 86_400_000),
		model: model ? `${model.provider}/${model.id}` : null,
		...{ tz },
	};
}

/** Routes for the HTTP channel: the page, its state, and its buttons. */
export function panelRoutes(daemon: () => Daemon | undefined): Record<string, RouteHandler> {
	return {
		"GET /": () => ({ status: 302, headers: { location: "/panel" } }),
		"GET /panel": () => ({ body: PAGE, headers: { "content-type": "text/html; charset=utf-8" } }),
		"GET /api/state": () => {
			const d = daemon();
			return d ? { body: panelState(d) } : { status: 503, body: { error: "starting" } };
		},
		"GET /api/status": () => {
			const d = daemon();
			return d ? { body: { text: d.statusText() } } : { status: 503, body: { error: "starting" } };
		},
		"POST /api/notify": (req) => {
			const d = daemon();
			if (!d) return { status: 503, body: { error: "starting" } };
			const b = (req.body ?? {}) as { text?: string; urgency?: string; topic?: string; dedup_key?: string };
			if (!b.text) return { status: 400, body: { error: "text is required" } };
			const urgency = (["critical", "high", "normal", "low"] as const).find((u) => u === b.urgency) ?? "normal";
			const n = d.s.notifier.notify({ text: b.text.slice(0, 600), urgency, topic: b.topic ?? "api", dedupKey: b.dedup_key });
			void d.s.outbox.deliverDue();
			return { body: { id: n.id, decision: n.decision } };
		},
		"POST /api/ticket": (req) => {
			const d = daemon();
			if (!d) return { status: 503, body: { error: "starting" } };
			const b = (req.body ?? {}) as { title?: string; request?: string; scope?: string };
			if (!b.request) return { status: 400, body: { error: "request is required" } };
			const route = d.s.ownerRoute();
			const t = d.s.tickets.create({
				title: (b.title ?? b.request).slice(0, 80),
				mandate: { request: b.request, scope: b.scope ?? "As requested by the owner through the API.", strength: "explicit" },
				origin: route ? { channel: route.channel, conversation: route.conversation } : { channel: "system", conversation: "" },
			});
			d.workers.pump();
			return { body: { id: t.id, title: t.title } };
		},
		"POST /api/action": async (req) => {
			const d = daemon();
			if (!d) return { status: 503, body: { error: "starting" } };
			const data = typeof req.body === "object" && req.body ? String((req.body as { data?: unknown }).data ?? "") : "";
			if (data === "pause" || data === "resume") {
				d.s.db.setKv("paused", data === "pause");
				return { body: { ok: true } };
			}
			if (data === "mode:off" || data === "mode:observe" || data === "mode:auto") {
				d.s.cfg.proactive.mode = data.slice(5) as "off" | "observe" | "auto";
				saveConfig(d.s.cfg, d.s.paths);
				d.s.db.event("mode", `proactive mode set to ${d.s.cfg.proactive.mode} from the panel`);
				return { body: { ok: true } };
			}
			await d.onInbound({
				channel: "http",
				externalId: `panel:${Date.now()}:${Math.random().toString(36).slice(2)}`,
				senderId: "owner",
				conversation: "panel",
				kind: "button",
				text: "",
				data,
				at: Date.now(),
			});
			return { body: { ok: true } };
		},
	};
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>vigil</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d1d1b;--mute:#6b6a65;--card:#fff;--line:#e3e1db;--accent:#2f6f4f;--warn:#a2491f;--chip:#efede7}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--mute:#9a988f;--card:#1d1d1b;--line:#2c2b28;--accent:#6fbf94;--warn:#e08a5f;--chip:#262522}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:20px 16px 60px}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:18px}
h1{font-size:20px;margin:0;letter-spacing:-.01em}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:26px 0 8px;font-weight:600}
.meta{color:var(--mute);font-size:13px}.chip{display:inline-block;background:var(--chip);border-radius:99px;padding:1px 9px;font-size:12px;color:var(--mute)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:8px 0}
.card.need{border-left:3px solid var(--warn)}.title{font-weight:600}.detail{color:var(--mute);font-size:13px;margin-top:3px;white-space:pre-wrap;word-break:break-word}
button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--chip);color:var(--fg);border-radius:7px;padding:4px 12px;margin:8px 6px 0 0;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}.row:last-child{border:0}
.row .r{color:var(--mute);font-size:13px;text-align:right;flex-shrink:0}
.meter{height:6px;background:var(--chip);border-radius:9px;overflow:hidden;margin-top:6px}.meter i{display:block;height:100%;background:var(--accent)}
.empty{color:var(--mute);font-size:14px}.ok{color:var(--accent)}
#login{display:none}input{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--fg);width:100%}
</style></head><body><main>
<div id="login" class="card"><div class="title">Panel token</div><div class="detail">Paste the HTTP token from your vigil config.</div><input id="tok" type="password" autocomplete="off"><button class="primary" onclick="saveTok()">Open</button></div>
<div id="app"></div>
</main><script>
let TOKEN = new URLSearchParams(location.search).get("token") || (()=>{try{return localStorage.getItem("vigil.token")}catch{return null}})();
if (new URLSearchParams(location.search).get("token")) { try{localStorage.setItem("vigil.token", TOKEN)}catch{} history.replaceState(null,"","/panel"); }
function saveTok(){TOKEN=document.getElementById("tok").value.trim();try{localStorage.setItem("vigil.token",TOKEN)}catch{};load()}
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ago = t => { const m = Math.round((Date.now()-t)/60000); return m < 1 ? "now" : m < 60 ? m+" min ago" : m < 1440 ? Math.round(m/60)+" h ago" : Math.round(m/1440)+" d ago"; };
const when = t => t ? new Date(t).toLocaleString([], {weekday:"short", hour:"2-digit", minute:"2-digit"}) : "—";
async function act(data){ await fetch("/api/action",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+TOKEN},body:JSON.stringify({data})}); load(); }
function render(s){
  const b = s.budget, pct = b.interruptsMax ? Math.min(100, 100*b.interruptsUsed/b.interruptsMax) : 100;
  let h = '<header><h1>vigil</h1><span class="chip">'+(s.paused?"paused":"running")+'</span><span class="chip">mode '+esc(s.mode)+'</span><span class="chip">'+(b.quietNow?"quiet hours":"awake")+'</span>'
    + '<span class="meta">'+esc(s.model || "no model — log in")+'</span>'
    + '<button onclick="act(\\''+(s.paused?"resume":"pause")+'\\')">'+(s.paused?"Resume":"Pause")+'</button></header>';
  h += '<h2>Needs you</h2>';
  h += s.needsYou.length ? s.needsYou.map(n => '<div class="card need"><div class="title">'+esc(n.title)+' <span class="chip">'+esc(n.kind)+'</span></div><div class="detail">'+esc(n.detail)+'</div>'
      + (n.actions||[]).map((a,i) => '<button class="'+(i===0?"primary":"")+'" onclick="act(\\''+esc(a.data)+'\\')">'+esc(a.label)+'</button>').join("") + '</div>').join("")
    : '<div class="empty ok">Nothing. </div>';
  h += '<h2>Attention budget</h2><div class="card"><div class="row"><span>Interrupts today</span><span class="r">'+b.interruptsUsed+' / '+b.interruptsMax+'</span></div><div class="meter"><i style="width:'+pct+'%"></i></div>'
    + '<div class="row"><span>Critical today</span><span class="r">'+b.criticalsUsed+' / '+b.criticalsMax+'</span></div><div class="row"><span>Waiting for the digest</span><span class="r">'+b.waiting+'</span></div></div>';
  if (s.waiting.length) h += '<div class="card">'+s.waiting.map(n => '<div class="row"><span>'+esc(n.text)+'</span><span class="r">'+esc(n.urgency)+' · '+esc(n.topic)+'</span></div>').join("")+'</div>';
  if (s.mode === "observe" && s.observed.length) h += '<h2>Would have done (observe mode)</h2><div class="card">'+s.observed.map(o => '<div class="row"><span>'+esc(o.text.replace(/^would /,""))+'</span><span class="r">'+ago(o.at)+'</span></div>').join("")+'<button class="primary" onclick="act(\\'mode:auto\\')">Looks right: switch to auto</button></div>';
  if (s.working.length) h += '<h2>Working</h2><div class="card">'+s.working.map(t => '<div class="row"><span>'+esc(t.title)+'</span><span class="r">'+esc(t.stage)+' · '+ago(t.updated)+'</span></div>').join("")+'</div>';
  if (s.jobs.length) h += '<h2>Schedule</h2><div class="card">'+s.jobs.map(j => '<div class="row"><span>'+esc(j.name)+(j.system?' <span class="chip">built in</span>':'')+'<div class="detail">'+esc(j.when)+' → '+esc(j.action)+(j.last?' · last: '+esc(j.last):'')+'</div></span><span class="r">'+when(j.next)+'</span></div>').join("")+'</div>';
  if (s.watchers.length) h += '<h2>Watching</h2><div class="card">'+s.watchers.map(w => '<div class="row"><span>'+esc(w.name)+'<div class="detail">'+esc(w.target)+(w.error?' · error: '+esc(w.error):'')+'</div></span><span class="r">every '+w.every+' min</span></div>').join("")+'</div>';
  h += '<h2>Recent</h2><div class="card">'+(s.events.map(e => '<div class="row"><span>'+esc(e.text)+'</span><span class="r">'+ago(e.at)+'</span></div>').join("")||'<div class="empty">Quiet.</div>')+'</div>';
  document.getElementById("app").innerHTML = h;
}
async function load(){
  if (!TOKEN) { document.getElementById("login").style.display="block"; return; }
  const r = await fetch("/api/state",{headers:{authorization:"Bearer "+TOKEN}});
  if (r.status === 401 || r.status === 403) { document.getElementById("login").style.display="block"; return; }
  document.getElementById("login").style.display="none";
  render(await r.json());
}
load(); setInterval(load, 5000);
</script></body></html>`;
