import { zulipLimits } from './classes.js';
import { zulip, discord } from './clients.js';
import { default as formatToDiscord, editFileUploads, update_linkifier_rules } from './formatter/zulipToDiscord.js';
import { ignored_zulip_users, zulipToDiscordFeatures, rate_limit_exempt_zulip_users } from './config.js';
import { checkRateLimit } from './ratelimit.js';
import { db, channelsTable, messagesTable, uploadsTable, isChannelPaused, pausedStatus } from './db.js';
import { and, eq, inArray, isNull } from 'drizzle-orm';

/** @type {Map<String, import('discord.js').Webhook>} */
const webhookMap = new Map();

zulip.registerMainQueue( [
	'message',
	'update_message',
	'delete_message',
	'realm_linkifiers',
	'attachment',
	'realm'
], {
	fetch_event_types: [
		'realm',
		'realm_linkifiers'
	],
	client_capabilities: {
		bulk_message_deletion: true,
		linkifier_url_template: true
	}
} ).then( body => {
	const {
		realm_name, realm_linkifiers,
		max_stream_name_length, max_topic_length,
		max_message_length, max_file_upload_size_mib,
		realm_default_code_block_language: default_code_block_language
	} = body;
	console.log( `\n- Successfully registered the main Zulip even queue for ${realm_name}!\n` );
	if ( zulipToDiscordFeatures.linkifiers ) update_linkifier_rules( realm_linkifiers );
	Object.assign( zulipLimits, {
		max_stream_name_length,
		max_topic_length,
		max_message_length,
		max_file_upload_size_mib,
		default_code_block_language
	} );
}, error => {
	console.log( '- Error during the main event queue:', error );
} );

/**
 * Check the rate limit and warn on Discord the first time it is hit
 * @param {Object} msg The Zulip message to relay
 * @param {Number} msg.sender_id The user id of the sender
 * @param {Number} msg.stream_id The channel the message was sent in
 * @param {String} msg.subject The topic the message was sent in
 * @param {String} msg.sender_full_name The name of the sender
 * @returns {Promise<Boolean>} Whether the message may be relayed
 */
async function allowedByRateLimit( msg ) {
	if ( rate_limit_exempt_zulip_users.includes( msg.sender_id ) ) return true;

	const rateLimit = checkRateLimit( 'zulip_to_discord', msg.sender_id, `${msg.stream_id}>${msg.subject}` );
	if ( rateLimit.allowed ) return true;
	if ( !rateLimit.tripped ) return false;

	const discordChannels = await db.select().from(channelsTable).where(and(eq(channelsTable.zulipStream, msg.stream_id),eq(channelsTable.zulipSubject, msg.subject)));
	if ( discordChannels.length === 0 ) return false;

	/** @type {import('discord.js').GuildTextBasedChannel} */
	const discordChannel = await discord.channels.fetch(discordChannels[0].discordChannelId).catch( () => null );
	if ( !discordChannel ) return false;

	let source = ( rateLimit.tripped === 'per_user' ? msg.sender_full_name : 'this channel' );
	console.log( `- Rate limit hit by ${msg.sender_id} in ${msg.stream_id}>${msg.subject}, pausing for ${rateLimit.cooldown} seconds` );
	await discordChannel.send( {
		content: `*Rate limit reached, messages from ${source} are not relayed for the next ${rateLimit.cooldown} seconds.*`,
		allowedMentions: { parse: [] }
	} );
	return false;
}

zulip.on( 'message', async msg => {
	if ( msg.sender_id === zulip.userId ) return;
	if ( msg.type === 'private' ) return await onZulipCommand( msg );
	if ( !zulipToDiscordFeatures.messages ) return;
	if ( msg.type !== 'stream' ) return;
	if ( ignored_zulip_users.includes( msg.sender_id ) ) return;

	let threadName = null;
	/** @type {null|import('discord.js').TextChannel} */
	let parentChannel = null;
	const discordChannels = await db.select().from(channelsTable).where(and(eq(channelsTable.zulipStream, msg.stream_id),eq(channelsTable.zulipSubject, msg.subject)));
	if ( discordChannels.length > 0 && discordChannels[0].paused ) return;
	if ( discordChannels.length === 0 ) {
		if ( msg.subject.startsWith( '✔ ' ) ) return;
		let parent = msg.subject.includes( '/' ) ? msg.subject.split('/')[0] : null;
		const parentChannels = await db.select().from(channelsTable).where(and(
			eq(channelsTable.zulipStream, msg.stream_id),
			parent ? eq(channelsTable.zulipSubject, parent) : isNull(channelsTable.zulipSubject)
		));
		if ( parentChannels.length === 0 ) return;

		if ( parentChannels[0].paused ) return;
		if ( !parentChannels[0].includeThreads ) return;
		if ( !zulipToDiscordFeatures.threads ) return;
		if ( !( await allowedByRateLimit( msg ) ) ) return;
		threadName = msg.subject.includes( '/' ) ? msg.subject.split('/').slice(1).join('/') : msg.subject;
		parentChannel = await discord.channels.fetch(parentChannels[0].discordChannelId).catch( async error => {
			if ( error?.code !== 10003 ) return console.error( error );
	
			await db.delete(channelsTable).where(eq(channelsTable.discordChannelId, parentChannels[0].discordChannelId));
			await db.delete(messagesTable).where(eq(messagesTable.discordChannelId, parentChannels[0].discordChannelId));
			console.log( `- Deleted connection between #${parentChannels[0].discordChannelId} and ${parentChannels[0].zulipStream}>${parentChannels[0].zulipSubject}` );
			return null;
		} );
		if ( !parentChannel ) return;
		if ( !parentChannel.isThreadOnly() ) {
			let thread = await parentChannel.threads.create( {
				name: threadName,
				reason: 'New topic created on Zulip'
			} );
			await db.insert(channelsTable).values( {
				zulipStream: msg.stream_id,
				zulipSubject: msg.subject,
				discordChannelId: thread.id
			} );
			parentChannel = thread;
			threadName = null;
		}
	}
	// An already bridged topic, the new topic branch above has its own check
	else if ( !( await allowedByRateLimit( msg ) ) ) return;

	/** @type {import('discord.js').GuildTextBasedChannel} */
	const discordChannel = parentChannel || await discord.channels.fetch(discordChannels[0].discordChannelId).catch( async error => {
		if ( error?.code !== 10003 ) return console.error( error );

		await db.delete(channelsTable).where(eq(channelsTable.discordChannelId, discordChannels[0].discordChannelId));
		await db.delete(messagesTable).where(eq(messagesTable.discordChannelId, discordChannels[0].discordChannelId));
		console.log( `- Deleted connection between #${discordChannels[0].discordChannelId} and ${discordChannels[0].zulipStream}>${discordChannels[0].zulipSubject}` );
		return null;
	} );
	if ( !discordChannel ) return;

	let threadId = null;
	/** @type {import('discord.js').BaseGuildTextChannel} */
	let webhookChannel = discordChannel;
	if ( discordChannel.isThread() ) {
		webhookChannel = discordChannel.parent;
		threadId = discordChannel.id;
	}
	if ( !webhookMap.has( webhookChannel.id ) ) {
		let webhooks = await webhookChannel.fetchWebhooks();
		let newWebhook = webhooks.filter( webhook => webhook.applicationId === webhook.client.user.id ).first();
		if ( !newWebhook ) newWebhook = await webhookChannel.createWebhook({name: 'Zulip Bridge Webhook'});
		webhookMap.set( webhookChannel.id, newWebhook );
	}
	let webhook = webhookMap.get( webhookChannel.id );

	const discordMsg = await webhook.send( Object.assign( await formatToDiscord( msg, {
		zulipMessageId: msg.id,
		zulipStream: msg.stream_id,
		zulipSubject: msg.subject,
		discordChannel
	} ), { threadId, threadName } ) );
	if ( threadName ) {
		await db.insert(channelsTable).values( {
			zulipStream: msg.stream_id,
			zulipSubject: msg.subject,
			discordChannelId: discordMsg.channelId
		} );
	}
	await db.insert(messagesTable).values( {
		discordMessageId: discordMsg.id,
		discordChannelId: discordMsg.channelId,
		zulipMessageId: msg.id,
		zulipStream: msg.stream_id,
		zulipSubject: msg.subject,
		source: 'zulip',
	} );
	if ( discordMsg.embeds.length ) {
		const newMessage = await editFileUploads(discordMsg);
		if ( newMessage ) await webhook.editMessage( discordMsg, newMessage );
	}
} );

zulip.on( 'update_message', async msg => {
	if ( !zulipToDiscordFeatures.edits ) return;
	if ( msg.rendering_only ) return;
	if ( msg.user_id === zulip.userId ) return;
	if ( ignored_zulip_users.includes( msg.user_id ) ) return;

	if ( msg.orig_content === msg.content ) return;
	
	const discordMessages = await db.select().from(messagesTable).where(eq(messagesTable.zulipMessageId, msg.message_id));

	if ( discordMessages.length === 0 ) return;

	if ( await isChannelPaused( discordMessages[0].discordChannelId ) ) return;

	// Edits count against the same budget as new messages
	if ( !( await allowedByRateLimit( {
		sender_id: msg.user_id,
		stream_id: discordMessages[0].zulipStream,
		subject: discordMessages[0].zulipSubject,
		sender_full_name: 'this user'
	} ) ) ) return;
	
	/** @type {import('discord.js').GuildTextBasedChannel} */
	const discordChannel = await discord.channels.fetch(discordMessages[0].discordChannelId).catch( async error => {
		if ( error?.code !== 10003 ) return console.error( error );

		await db.delete(channelsTable).where(eq(channelsTable.discordChannelId, discordMessages[0].discordChannelId));
		await db.delete(messagesTable).where(eq(messagesTable.discordChannelId, discordMessages[0].discordChannelId));
		console.log( `- Deleted connection between #${discordMessages[0].discordChannelId} and ${discordMessages[0].zulipStream}>${discordMessages[0].zulipSubject}` );
		return null;
	} );

	if ( !discordChannel ) return;

	let threadId = null;
	/** @type {import('discord.js').BaseGuildTextChannel} */
	let webhookChannel = discordChannel;
	if ( discordChannel.isThread() ) {
		webhookChannel = discordChannel.parent;
		threadId = discordChannel.id;
	}
	if ( !webhookMap.has( webhookChannel.id ) ) {
		let webhooks = await webhookChannel.fetchWebhooks();
		let newWebhook = webhooks.filter( webhook => webhook.applicationId === webhook.client.user.id ).first();
		if ( !newWebhook ) newWebhook = await webhookChannel.createWebhook({name: 'Zulip Bridge Webhook'});
		webhookMap.set( webhookChannel.id, newWebhook );
	}
	let webhook = webhookMap.get( webhookChannel.id );

	const editedMessage = await formatToDiscord( msg, {
		zulipMessageId: msg.message_id,
		zulipStream: discordMessages[0].zulipStream,
		zulipSubject: discordMessages[0].zulipSubject,
		discordChannel
	} );

	await webhook.editMessage( discordMessages[0].discordMessageId, { threadId,
		content: editedMessage.content,
		allowedMentions: editedMessage.allowedMentions
	} );
} );

zulip.on( 'delete_message', async msg => {
	if ( !zulipToDiscordFeatures.deletes ) return;
	if ( msg.message_type !== 'stream' ) return;

	/** @type {Number[]} */
	let zulipMessages = msg.message_ids ?? [msg.message_id];

	const discordMessages = await db.delete(messagesTable).where(inArray(messagesTable.zulipMessageId, zulipMessages)).returning();

	if ( discordMessages.length === 0 ) return;

	await Promise.all( [...new Set( discordMessages.map( discordMessage => discordMessage.discordChannelId ) )].map( async discordChannelId => {
		/** @type {import('discord.js').GuildTextBasedChannel} */
		const discordChannel = await discord.channels.fetch(discordChannelId).catch( async error => {
			if ( error?.code !== 10003 ) return console.error( error );

			const discordChannels = await db.delete(channelsTable).where(eq(channelsTable.discordChannelId, discordChannelId)).returning();
			await db.delete(messagesTable).where(eq(messagesTable.discordChannelId, discordChannelId));
			console.log( `- Deleted connection between #${discordChannelId} and ${discordChannels[0]?.zulipStream}>${discordChannels[0]?.zulipSubject}` );
			return null;
		} );

		if ( !discordChannel ) return;

		let channelMessages = discordMessages.filter( discordMessage => discordMessage.discordChannelId === discordChannel.id );
		const bulkDeleted = await discordChannel.bulkDelete( [
			...new Set( channelMessages.slice(0, 100).map( channelMessage => channelMessage.discordMessageId ) )
		], true );
		channelMessages = channelMessages.filter( channelMessage => !bulkDeleted.has( channelMessage.discordMessageId ) );
		await Promise.all( channelMessages.map( async channelMessage => {
			await discordChannel.messages.delete( channelMessage.discordMessageId );
		} ) );
	} ) );
} );

zulip.on( 'attachment', async ({ op, attachment }) => {
	if ( op === 'remove' ) {
		await db.delete(uploadsTable).where(eq(uploadsTable.zulipFileId, attachment.id));
		return;
	}
	await db.update(uploadsTable).set( {
		zulipFileId: attachment.id
	} ).where(eq(uploadsTable.zulipFileUrl, attachment.path_id));
} );

if ( zulipToDiscordFeatures.linkifiers ) zulip.on( 'realm_linkifiers', update_linkifier_rules );

zulip.on( 'realm:update_dict', settings => {
	Object.keys( settings ).forEach( setting => {
		switch ( setting ) {
			case 'max_file_upload_size_mib':
			case 'default_code_block_language':
				zulipLimits[setting] = settings[setting];
				break;
		}
	} );
} );

async function onZulipCommand( msg ) {
	if ( msg.sender_id === zulip.userId ) return;

	if ( !msg.content.startsWith( '!bridge' ) ) return;

	const zulipUser = await zulip.getUser( msg.sender_id );

	// Check for Zulip admin
	if ( zulipUser.role > 200 ) return;

	// Pause and resume the bridge
	let [pauseCommand, pauseTarget] = msg.content.match( /^!bridge (pause|resume)(?: (all|#\*\*[^*]+\*\*))?/ )?.slice(1) ?? [];
	if ( pauseCommand ) return await setPaused( pauseCommand === 'pause', pauseTarget, content => zulip.sendMessage( {
		type: 'direct',
		to: [msg.sender_id],
		content
	} ) );

	if ( msg.content.startsWith( '!bridge status' ) ) return await zulip.sendMessage( {
		type: 'direct',
		to: [msg.sender_id],
		content: await pausedStatus()
	} );

	/** @type {[Number, String | null, String, Boolean]} */
	let [
		zulipStream,
		zulipSubject,
		discordChannelId,
		includeThreads = 'true'
	] = msg.content.match( /^!bridge #\*\*([^>*]+)(?:>([^@*]+))?\*\* (\d+)(?: (true|false))?/ )?.slice(1) ?? [];

	if ( !zulipStream || !discordChannelId ) {
		return await zulip.sendMessage( {
			type: 'direct',
			to: [msg.sender_id],
			content: '`!bridge <zulipChannelMention> <discordChannelId> <includeThreads>`\n> `!bridge #**Channel>Topic** 123456789012345 true`\n`!bridge <pause|resume> [all|<zulipChannelMention>]`\n`!bridge status`'
		} );
	}

	zulipStream = ( await zulip.getStreamId( zulipStream ) );
	includeThreads = ( includeThreads === 'true' );
	zulipSubject ??= null;

	if ( !zulipStream ) {
		return await zulip.sendMessage( {
			type: 'direct',
			to: [msg.sender_id],
			content: "Zulip channel doesn't exist or I'm not a subscriber yet!"
		} );
	}

	await db.insert(channelsTable).values( {
		zulipStream,
		zulipSubject,
		discordChannelId,
		includeThreads
	} );
	return await zulip.sendMessage( {
		type: 'direct',
		to: [msg.sender_id],
		content: 'Bridge added!'
	} );
}

/**
 * Pause or resume bridged channels
 * @param {Boolean} paused Whether to pause the bridge
 * @param {String} [target] The channel mention to act on, or "all"
 * @param {(content: String) => Promise<any>} reply How to answer the command
 */
async function setPaused( paused, target, reply ) {
	let action = ( paused ? 'Paused' : 'Resumed' );

	if ( target === 'all' ) {
		const channels = await db.update(channelsTable).set( { paused } ).returning();
		return await reply( `${action} the bridge for all ${channels.length} channels.` );
	}

	let zulipChannel = target?.match( /^#\*\*([^>*]+)(?:>([^@*]+))?\*\*$/ )?.slice(1);
	if ( !zulipChannel ) return await reply( '`!bridge <pause|resume> [all|<zulipChannelMention>]`' );

	const zulipStream = ( await zulip.getStreamId( zulipChannel[0] ) );
	if ( !zulipStream ) return await reply( "Zulip channel doesn't exist or I'm not a subscriber yet!" );

	const channels = await db.update(channelsTable).set( { paused } ).where(and(
		eq(channelsTable.zulipStream, zulipStream),
		zulipChannel[1] ? eq(channelsTable.zulipSubject, zulipChannel[1]) : isNull(channelsTable.zulipSubject)
	)).returning();
	if ( channels.length === 0 ) return await reply( 'That Zulip channel is not bridged.' );
	return await reply( `${action} the bridge for ${channels.length} channel.` );
}
