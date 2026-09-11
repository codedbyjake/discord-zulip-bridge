import { Events, PermissionFlagsBits } from 'discord.js';
import { zulipLimits } from './classes.js';
import { zulip, discord } from './clients.js';
import formatToZulip from './formatter/discordToZulip.js';
import { ignored_discord_users, discordToZulipFeatures, rate_limit_exempt_discord_users } from './config.js';
import { checkRateLimit } from './ratelimit.js';
import { db, channelsTable, messagesTable, isChannelPaused, pausedStatus } from './db.js';
import { eq, inArray } from 'drizzle-orm';

/**
 * Log errors instead of letting them crash the process
 * @param {Function} listener The event listener to wrap
 * @returns {Function} The wrapped event listener
 */
function safely( listener ) {
	return async ( ...args ) => {
		try {
			await listener( ...args );
		}
		catch ( error ) {
			console.error( '- Unhandled error while handling Discord event:', error );
		}
	};
}

/**
 * The bridged channels that belong to one Discord server
 * @param {String} guildId The id of the Discord server
 * @returns {Promise<Object[]>} The bridged channels in that server
 */
async function bridgedGuildChannels( guildId ) {
	const channels = await db.select().from(channelsTable);
	const inGuild = await Promise.all( channels.map( async channel => {
		const discordChannel = discord.channels.cache.get( channel.discordChannelId )
			?? await discord.channels.fetch( channel.discordChannelId ).catch( () => null );
		return ( discordChannel?.guildId === guildId ? channel : null );
	} ) );
	return inGuild.filter( channel => channel !== null );
}

/**
 * Handle the !bridge command on Discord
 * @param {import('discord.js').Message} msg The command message
 * @returns {Promise<Boolean>} Whether the message was handled as a command
 */
async function onDiscordCommand( msg ) {
	if ( !/^!bridge(?:\s|$)/.test( msg.content ) ) return false;

	// Check for Discord admin, anyone else just wrote a message starting with the command
	if ( msg.guild.ownerId !== msg.author.id && !msg.member?.permissions.has( PermissionFlagsBits.Administrator ) ) return false;

	// Only act on the server's own bridges, being an admin elsewhere grants nothing here
	const guildChannels = await bridgedGuildChannels( msg.guildId );
	if ( guildChannels.length === 0 ) return false;

	let [command, target] = msg.content.split( /\s+/ ).slice(1);

	if ( command === 'status' ) {
		await msg.reply( await pausedStatus( guildChannels ) );
		return true;
	}

	if ( command !== 'pause' && command !== 'resume' ) {
		await msg.reply( '`!bridge <pause|resume> [all]`\n`!bridge status`' );
		return true;
	}

	const paused = ( command === 'pause' );
	let action = ( paused ? 'Paused' : 'Resumed' );

	if ( target === 'all' ) {
		const channels = await db.update(channelsTable).set( { paused } ).where(inArray(
			channelsTable.discordChannelId, guildChannels.map( channel => channel.discordChannelId )
		)).returning();
		await msg.reply( `${action} the bridge for all ${channels.length} channels in this server.` );
		return true;
	}

	const channels = await db.update(channelsTable).set( { paused } ).where(eq(channelsTable.discordChannelId, msg.channelId)).returning();
	if ( channels.length === 0 ) await msg.reply( 'This channel is not bridged.' );
	else await msg.reply( `${action} the bridge for this channel.` );
	return true;
}

/**
 * Check the rate limit and warn on Zulip the first time it is hit
 * @param {import('discord.js').Message} msg The message to relay
 * @param {Object} [zulipChannel] The bridged channel, when it has already been looked up
 * @returns {Promise<Boolean>} Whether the message may be relayed
 */
async function allowedByRateLimit( msg, zulipChannel ) {
	if ( rate_limit_exempt_discord_users.includes( msg.author.id ) ) return true;

	const rateLimit = checkRateLimit( 'discord_to_zulip', msg.author.id, msg.channelId );
	if ( rateLimit.allowed ) return true;
	if ( !rateLimit.tripped ) return false;

	const zulipChannels = ( zulipChannel ? [zulipChannel] : await db.select().from(channelsTable).where(eq(channelsTable.discordChannelId, msg.channelId)) );
	if ( zulipChannels.length === 0 ) return false;

	let source = ( rateLimit.tripped === 'per_user' ? '@\u200b' + ( msg.member || msg.author ).displayName : 'this channel' );
	console.log( `- Rate limit hit by ${msg.author.id} in #${msg.channelId}, pausing for ${rateLimit.cooldown} seconds` );
	await zulip.sendMessage( {
		type: 'stream',
		to: zulipChannels[0].zulipStream,
		topic: zulipChannels[0].zulipSubject,
		content: `*Rate limit reached, messages from ${source} are not relayed for the next ${rateLimit.cooldown} seconds.*`
	} );
	return false;
}

discord.on( Events.MessageCreate, safely( async msg => {
	if ( !discordToZulipFeatures.messages ) return;
	if ( !msg.guildId || !msg.channel.isTextBased() || msg.system ) return;
	if ( msg.applicationId === msg.client.user.id ) return;
	if ( ignored_discord_users.includes( msg.author.id ) ) return;
	if ( msg.applicationId && ignored_discord_users.includes( msg.applicationId ) ) return;

	if ( await onDiscordCommand( msg ) ) return;

	const zulipChannels = await db.select().from(channelsTable).where(eq(channelsTable.discordChannelId, msg.channelId));
	if ( zulipChannels.length === 0 ) return;
	if ( zulipChannels[0].paused ) return;

	if ( !( await allowedByRateLimit( msg, zulipChannels[0] ) ) ) return;

	const zulipMsg = await zulip.sendMessage( Object.assign( await formatToZulip( msg ), {
		type: 'stream',
		to: zulipChannels[0].zulipStream,
		topic: zulipChannels[0].zulipSubject,
	} ) );

	await db.insert(messagesTable).values( {
		discordMessageId: msg.id,
		discordChannelId: msg.channelId,
		zulipMessageId: zulipMsg,
		zulipStream: zulipChannels[0].zulipStream,
		zulipSubject: zulipChannels[0].zulipSubject,
		source: 'discord',
	} );
} ) );

discord.on( Events.MessageUpdate, safely( async (oldmsg, msg) => {
	if ( !discordToZulipFeatures.edits ) return;
	if ( !msg.guildId || !msg.channel.isTextBased() || msg.system ) return;
	if ( msg.applicationId === msg.client.user.id ) return;
	if ( ignored_discord_users.includes( msg.author.id ) ) return;
	if ( msg.applicationId && ignored_discord_users.includes( msg.applicationId ) ) return;

	if ( !oldmsg.partial && msg.equals( oldmsg ) ) return;

	const zulipMessages = await db.select().from(messagesTable).where(eq(messagesTable.discordMessageId, msg.id));

	if ( zulipMessages.length === 0 ) return;
	if ( await isChannelPaused( msg.channelId ) ) return;
	if ( !( await allowedByRateLimit( msg ) ) ) return;

	await zulip.editMessage( zulipMessages[0].zulipMessageId, await formatToZulip( msg ) );
} ) );

discord.on( Events.MessageDelete, safely( async msg => {
	if ( !discordToZulipFeatures.deletes ) return;

	const zulipMessages = await db.delete(messagesTable).where(eq(messagesTable.discordMessageId, msg.id)).returning();

	if ( zulipMessages.length === 0 ) return;

	await zulip.deleteMessage( zulipMessages[0].zulipMessageId );
} ) );

discord.on( Events.MessageBulkDelete, safely( async messages => {
	if ( !discordToZulipFeatures.deletes ) return;

	const zulipMessages = await db.delete(messagesTable).where(inArray(messagesTable.discordMessageId, messages.map( msg => msg.id ))).returning();

	if ( zulipMessages.length === 0 ) return;

	await Promise.all( zulipMessages.map( async zulipMessage => {
		await zulip.deleteMessage( zulipMessage.zulipMessageId );
	} ) );
} ) );

discord.on( Events.ThreadCreate, safely( async (thread, isNew) => {
	if ( !discordToZulipFeatures.threads ) return;
	if ( !isNew ) return;
	if ( thread.ownerId === thread.client.user.id ) return;

	let msg = await thread.fetchStarterMessage().catch( error => {
		if ( error?.code === 10008 ) return null;
		throw error;
	} );

	if ( !msg ) return;
	if ( msg.applicationId === thread.client.user.id ) return;
	if ( ignored_discord_users.includes( msg.author.id ) ) return;
	if ( msg.applicationId && ignored_discord_users.includes( msg.applicationId ) ) return;

	const channels = await db.select().from(channelsTable).where(eq(channelsTable.discordChannelId, thread.parentId));
	if ( channels.length === 0 ) return;
	if ( channels[0].paused ) return;
	if ( !channels[0].includeThreads ) return;
	if ( !( await allowedByRateLimit( msg, channels[0] ) ) ) return;

	let subject = ( channels[0].zulipSubject ? channels[0].zulipSubject + '/' : '' ) + thread.name;
	if ( subject.length > zulipLimits.max_topic_length ) subject = subject.slice(0, zulipLimits.max_topic_length - 1) + '…';

	const zulipChannels = await db.insert(channelsTable).values( {
		zulipStream: channels[0].zulipStream,
		zulipSubject: subject,
		discordChannelId: thread.id
	} ).returning();

	const zulipMsg = await zulip.sendMessage( Object.assign( await formatToZulip(msg), {
		type: 'stream',
		to: zulipChannels[0].zulipStream,
		topic: zulipChannels[0].zulipSubject,
	} ) );

	await db.insert(messagesTable).values( {
		discordMessageId: msg.id,
		discordChannelId: msg.channelId,
		zulipMessageId: zulipMsg,
		zulipStream: zulipChannels[0].zulipStream,
		zulipSubject: zulipChannels[0].zulipSubject,
		source: 'discord',
	} );
} ) );

discord.on( Events.ChannelDelete, safely( async channel => {
	const zulipChannels = await db.delete(channelsTable).where(eq(channelsTable.discordChannelId, channel.id)).returning();

	if ( zulipChannels.length === 0 ) return;

	await db.delete(messagesTable).where(eq(messagesTable.discordChannelId, channel.id));
	console.log( `- Deleted connection between #${channel.name} and ${zulipChannels[0].zulipStream}>${zulipChannels[0].zulipSubject}` );
} ) );

discord.on( Events.ThreadDelete, safely( async thread => {
	const zulipChannels = await db.delete(channelsTable).where(eq(channelsTable.discordChannelId, thread.id)).returning();

	if ( zulipChannels.length === 0 ) return;

	await db.delete(messagesTable).where(eq(messagesTable.discordChannelId, thread.id));
	console.log( `- Deleted connection between #${thread.name} and ${zulipChannels[0].zulipStream}>${zulipChannels[0].zulipSubject}` );
} ) );

discord.on( Events.GuildCreate, safely( guild => {
	console.log( '- ' + guild.name + ': I\'ve been added to the server.' );
} ) );

discord.on( Events.GuildDelete, safely( guild => {
	if ( !guild.available ) {
		console.log( '- ' + guild.name + ': This server isn\'t responding.' );
		return;
	}
	console.log( '- ' + guild.name + ': I\'ve been removed from the server.' );
} ) );