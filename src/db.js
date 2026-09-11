import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';

export const db = drizzle({ connection: { url: 'file:messages.db' } });

export const channelsTable = sqliteTable(
	'channels',
	{
		discordChannelId: text().unique().notNull(),
		zulipStream: integer().notNull(),
		zulipSubject: text(),
		includeThreads: integer({ mode: 'boolean' }).default(true),
		paused: integer({ mode: 'boolean' }).default(false),
	},
	(table) => [
		uniqueIndex('discord_channel_idx').on(table.discordChannelId),
		uniqueIndex('zulip_stream_topic_idx').on(table.zulipStream, table.zulipSubject),
	]
);

export const messagesTable = sqliteTable(
	'messages',
	{
		discordMessageId: text().unique(),
		discordChannelId: text(),
		zulipMessageId: integer().unique(),
		zulipStream: integer(),
		zulipSubject: text(),
		source: text({enum:['discord', 'zulip']}).notNull(),
	},
	(table) => [
		uniqueIndex('discord_id_idx').on(table.discordMessageId),
		uniqueIndex('zulip_message_id_idx').on(table.zulipMessageId),
	]
);

export const uploadsTable = sqliteTable(
	'uploads',
	{
		discordFileUrl: text().unique().notNull(),
		discordFileQuery: text().default(''),
		zulipFileUrl: text().unique().notNull(),
		zulipFileId: integer().unique(),
	},
	(table) => [
		uniqueIndex('discord_url_idx').on(table.discordFileUrl),
		uniqueIndex('zulip_file_url_idx').on(table.zulipFileUrl),
		uniqueIndex('zulip_file_id_idx').on(table.zulipFileId),
	]
);

/**
 * Check whether a bridged channel is paused
 * @param {String} discordChannelId The id of the Discord channel
 * @returns {Promise<Boolean>} Whether the bridge is paused
 */
export async function isChannelPaused( discordChannelId ) {
	const channels = await db.select().from(channelsTable).where(eq(channelsTable.discordChannelId, discordChannelId));
	return channels.length > 0 && !!channels[0].paused;
}

/**
 * Describe which bridged channels are paused
 * @param {Object[]} [channels] The channels to describe, defaults to every bridged channel
 * @returns {Promise<String>} The status message
 */
export async function pausedStatus( channels ) {
	channels ??= await db.select().from(channelsTable);
	const paused = channels.filter( channel => channel.paused );
	if ( !paused.length ) return `${channels.length} bridged channels, none paused.`;
	return `${channels.length} bridged channels, ${paused.length} paused:\n` + paused.map( channel => {
		return `- Zulip ${channel.zulipStream}>${channel.zulipSubject} / Discord ${channel.discordChannelId}`;
	} ).join('\n');
}
