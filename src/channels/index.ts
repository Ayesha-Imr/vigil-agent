// Builds the configured channels and picks where proactive messages to the owner go.

import type { ChannelId, Paths, VigilConfig } from "../config.ts";
import { CliChannel, type CliOptions } from "./cli.ts";
import { DiscordChannel } from "./discord.ts";
import { HttpChannel, type RouteHandler } from "./http.ts";
import { NtfyChannel } from "./ntfy.ts";
import { SignalChannel } from "./signal.ts";
import { SlackChannel } from "./slack.ts";
import { TelegramChannel } from "./telegram.ts";
import type { Channel } from "./types.ts";
import { type Log, stderrLog } from "./util.ts";
import { WhatsAppChannel } from "./whatsapp.ts";

export interface CreateChannelsOptions {
	log?: Log;
	/** Also create the terminal channel (for `vigil chat`). */
	cli?: boolean | CliOptions;
	/** Extra HTTP routes, keyed `"METHOD /path"` (the panel). */
	httpHandlers?: Record<string, RouteHandler>;
	/** Bind address for the HTTP channel; defaults to 127.0.0.1. */
	httpHost?: string;
}

/**
 * Create a channel for each configured channel. Channels that cannot work (no token) are left
 * out with a log line saying why. Nothing connects until `start()`.
 */
export function createChannels(cfg: VigilConfig, paths: Paths, opts: CreateChannelsOptions = {}): Map<ChannelId, Channel> {
	const log = opts.log ?? stderrLog;
	const ids = cfg.owner.identities;
	const ch = cfg.channels;
	const out = new Map<ChannelId, Channel>();
	const ownerNote = (id: ChannelId): void => {
		if (!ids[id]?.length) log(`channels: ${id}: no owner identity in owner.identities.${id}; vigil prints a /pair code at startup; send it to the bot from your account`);
	};

	if (ch.telegram) {
		if (ch.telegram.token) {
			out.set("telegram", new TelegramChannel({ token: ch.telegram.token, ownerUserId: ids.telegram?.[0], log }));
			ownerNote("telegram");
		} else log("channels: telegram skipped: no token (set channels.telegram.token or VIGIL_TELEGRAM_TOKEN)");
	}

	if (ch.discord) {
		if (ch.discord.token) {
			out.set("discord", new DiscordChannel({ token: ch.discord.token, ownerUserId: ids.discord?.[0], log }));
			ownerNote("discord");
		} else log("channels: discord skipped: no token (set channels.discord.token or VIGIL_DISCORD_TOKEN)");
	}

	if (ch.slack) {
		const { botToken, appToken } = ch.slack;
		if (botToken && appToken) {
			out.set("slack", new SlackChannel({ botToken, appToken, ownerUserId: ids.slack?.[0], log }));
			ownerNote("slack");
		} else {
			log("channels: slack skipped: needs a bot token and an app token (set channels.slack.botToken and appToken, or VIGIL_SLACK_BOT_TOKEN and VIGIL_SLACK_APP_TOKEN)");
		}
	}

	if (ch.signal) {
		if (ch.signal.url && ch.signal.account) {
			log("channels: signal talks to a signal-cli daemon (unofficial client, real Signal protocol); install, link and run it separately");
			out.set("signal", new SignalChannel({ url: ch.signal.url, account: ch.signal.account, ownerNumbers: ids.signal, log }));
			ownerNote("signal");
		} else log("channels: signal skipped: channels.signal needs url (the signal-cli daemon, e.g. http://127.0.0.1:8080) and account (its number)");
	}

	if (ch.whatsapp?.enabled) {
		log("channels: whatsapp uses Baileys, an unofficial client; WhatsApp may ban the number. Use a secondary number");
		out.set("whatsapp", new WhatsAppChannel({ home: paths.home, ownerJids: ids.whatsapp, log }));
		ownerNote("whatsapp");
	}

	const http = ch.http;
	// ntfy topics can be read by anyone who knows the name, and a signed action URL works for whoever
	// holds it, so buttons go to ntfy only when the owner allowed approvals over HTTP.
	const callback = http?.publicUrl && http.token && http.allowApprovals ? { publicUrl: http.publicUrl, token: http.token } : undefined;

	if (ch.ntfy) {
		if (ch.ntfy.server && ch.ntfy.topic) {
			out.set("ntfy", new NtfyChannel({ server: ch.ntfy.server, topic: ch.ntfy.topic, token: ch.ntfy.token, callback }));
			if (!callback) log("channels: ntfy notifications have no action buttons (needs channels.http.publicUrl, token and allowApprovals)");
		} else log("channels: ntfy skipped: channels.ntfy needs server and topic");
	}

	if (http) {
		if (http.token) {
			out.set("http", new HttpChannel({ port: http.port, token: http.token, host: opts.httpHost, handlers: opts.httpHandlers, log }));
		} else log("channels: http skipped: no token (set channels.http.token or VIGIL_HTTP_TOKEN)");
	}

	if (opts.cli) out.set("cli", new CliChannel(opts.cli === true ? {} : opts.cli));
	return out;
}

/** The first channel in `owner.notify` order that is running and knows the owner's conversation. */
export function ownerRoute(
	cfg: VigilConfig,
	channels: Map<ChannelId, Channel>,
): { channel: Channel; conversation: string } | undefined {
	for (const id of cfg.owner.notify) {
		const channel = channels.get(id);
		const conversation = channel?.ownerConversation();
		if (channel && conversation) return { channel, conversation };
	}
	return undefined;
}

export { CliChannel } from "./cli.ts";
export { DiscordChannel } from "./discord.ts";
export { HttpChannel, HttpServer } from "./http.ts";
export { NtfyChannel } from "./ntfy.ts";
export { SignalChannel } from "./signal.ts";
export { SlackChannel } from "./slack.ts";
export { TelegramChannel } from "./telegram.ts";
export { WhatsAppChannel } from "./whatsapp.ts";
