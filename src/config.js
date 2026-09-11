import config from '../config.json' with { type: 'json' };

export const {
	ignored_discord_users = [],
	ignored_zulip_users = [],
	mentionable_discord_roles = [],
	mentionable_zulip_groups = [],
	text_replacements = {},
	upload_files_to_zulip = false,
	discord_username_prefix = "",
	discord_username_suffix = "",
	rate_limit_exempt_discord_users = [],
	rate_limit_exempt_zulip_users = [],
	allow_mass_mentions = false
} = config;

export const zulipToDiscordReplacements = new Map( Object.entries( text_replacements ).map( replacement => [replacement[0], String(replacement[1])] ) );
export const discordToZulipReplacements = new Map( Object.entries( text_replacements ).map( replacement => [String(replacement[1]), replacement[0]] ) );

/**
 * The default feature toggles
 * @type {Record<String, Record<String, Boolean>>}
 */
const featureDefaults = {
	discord_to_zulip: {
		// Relay
		messages: true,
		edits: true,
		deletes: true,
		threads: true,
		// Message formatting
		replies: true,
		forwards: true,
		embeds: true,
		message_links: true,
		channel_mentions: true,
		group_mentions: true,
		escape_wildcard_mentions: true,
		quote_blocks: true,
		text_replacements: true,
		timestamps: true,
		stickers: true,
		attachments: true,
		// Defaults to the top-level option
		upload_files: upload_files_to_zulip
	},
	zulip_to_discord: {
		// Relay
		messages: true,
		edits: true,
		deletes: true,
		threads: true,
		// Message formatting
		text_replacements: true,
		role_mentions: true,
		user_mentions: true,
		silent_mentions: true,
		message_links: true,
		message_mentions: true,
		topic_mentions: true,
		channel_mentions: true,
		file_uploads: true,
		quotes: true,
		default_code_block_language: true,
		timestamps: true,
		linkifiers: true
	}
};

/**
 * Merge the configured feature toggles into the defaults
 * @param {Record<String, Record<String, Boolean>>} defaults The default feature toggles
 * @param {Record<String, Record<String, Boolean>>} [overrides] The feature toggles from the config
 * @returns {Record<String, Record<String, Boolean>>} The merged feature toggles
 */
function mergeFeatures( defaults, overrides = {} ) {
	/** @type {Record<String, Record<String, Boolean>>} */
	const merged = {};

	Object.entries( defaults ).forEach( ([group, groupDefaults]) => {
		merged[group] = Object.assign( {}, groupDefaults );

		Object.entries( overrides[group] ?? {} ).forEach( ([feature, value]) => {
			if ( !Object.hasOwn( groupDefaults, feature ) ) {
				console.warn( `- Config: Unknown feature "features.${group}.${feature}", ignoring it.` );
				return;
			}
			if ( typeof value !== 'boolean' ) {
				console.warn( `- Config: "features.${group}.${feature}" must be true or false, ignoring it.` );
				return;
			}
			merged[group][feature] = value;
		} );
	} );

	// Unknown feature groups
	Object.keys( overrides ).forEach( group => {
		if ( !Object.hasOwn( defaults, group ) ) console.warn( `- Config: Unknown feature group "features.${group}", ignoring it.` );
	} );

	return merged;
}

export const {
	discord_to_zulip: discordToZulipFeatures,
	zulip_to_discord: zulipToDiscordFeatures
} = mergeFeatures( featureDefaults, config.features );

const disabledFeatures = Object.entries( { discord_to_zulip: discordToZulipFeatures, zulip_to_discord: zulipToDiscordFeatures } ).flatMap( ([group, groupFeatures]) => {
	return Object.entries( groupFeatures ).filter( ([, enabled]) => !enabled ).map( ([feature]) => `${group}.${feature}` );
} );

if ( disabledFeatures.length ) console.log( '- Config: Disabled features: ' + disabledFeatures.join( ', ' ) );

/**
 * The default rate limits, a message count allowed within a number of seconds
 * Setting the message count to 0 turns that limit off
 * @type {Record<String, Record<String, {messages: Number, seconds: Number, cooldown: Number}>>}
 */
const rateLimitDefaults = {
	discord_to_zulip: {
		per_user: { messages: 10, seconds: 30, cooldown: 60 },
		per_channel: { messages: 60, seconds: 30, cooldown: 30 }
	},
	zulip_to_discord: {
		per_user: { messages: 10, seconds: 30, cooldown: 60 },
		per_channel: { messages: 60, seconds: 30, cooldown: 30 }
	}
};

/**
 * Merge the configured rate limits into the defaults
 * @param {Record<String, Record<String, Record<String, Number>>>} defaults The default rate limits
 * @param {Record<String, Record<String, Record<String, Number>>>} [overrides] The rate limits from the config
 * @returns {Record<String, Record<String, Record<String, Number>>>} The merged rate limits
 */
function mergeRateLimits( defaults, overrides = {} ) {
	/** @type {Record<String, Record<String, Record<String, Number>>>} */
	const merged = {};

	Object.entries( defaults ).forEach( ([group, groupDefaults]) => {
		merged[group] = {};

		Object.entries( groupDefaults ).forEach( ([scope, scopeDefaults]) => {
			merged[group][scope] = Object.assign( {}, scopeDefaults );

			Object.entries( overrides[group]?.[scope] ?? {} ).forEach( ([option, value]) => {
				if ( !Object.hasOwn( scopeDefaults, option ) ) {
					console.warn( `- Config: Unknown rate limit "rate_limits.${group}.${scope}.${option}", ignoring it.` );
					return;
				}
				if ( typeof value !== 'number' || !Number.isFinite( value ) || value < 0 ) {
					console.warn( `- Config: "rate_limits.${group}.${scope}.${option}" must be a positive number, ignoring it.` );
					return;
				}
				merged[group][scope][option] = value;
			} );
		} );

		// Unknown rate limit scopes
		Object.keys( overrides[group] ?? {} ).forEach( scope => {
			if ( !Object.hasOwn( groupDefaults, scope ) ) console.warn( `- Config: Unknown rate limit scope "rate_limits.${group}.${scope}", ignoring it.` );
		} );
	} );

	// Unknown rate limit groups
	Object.keys( overrides ).forEach( group => {
		if ( !Object.hasOwn( defaults, group ) ) console.warn( `- Config: Unknown rate limit group "rate_limits.${group}", ignoring it.` );
	} );

	return merged;
}

export const rateLimits = mergeRateLimits( rateLimitDefaults, config.rate_limits );

const disabledRateLimits = Object.entries( rateLimits ).flatMap( ([group, scopes]) => {
	return Object.entries( scopes ).filter( ([, limit]) => !limit.messages ).map( ([scope]) => `${group}.${scope}` );
} );

if ( disabledRateLimits.length ) console.log( '- Config: Disabled rate limits: ' + disabledRateLimits.join( ', ' ) );
