import { rateLimits } from './config.js';

/** @type {Map<String, {timestamps: Number[], blockedUntil: Number}>} */
const buckets = new Map();

/**
 * Check a single bucket against its limit
 * @param {String} key The bucket to check
 * @param {{messages: Number, seconds: Number, cooldown: Number}} limit The limit to apply
 * @param {Number} now The current time
 * @returns {'allowed'|'tripped'|'blocked'}
 */
function checkBucket( key, limit, now ) {
	if ( !limit?.messages ) return 'allowed';

	let bucket = buckets.get( key );
	if ( !bucket ) {
		bucket = { timestamps: [], blockedUntil: 0 };
		buckets.set( key, bucket );
	}

	// Still cooling down from an earlier burst
	if ( bucket.blockedUntil > now ) return 'blocked';

	const windowStart = now - ( limit.seconds * 1000 );
	bucket.timestamps = bucket.timestamps.filter( timestamp => timestamp > windowStart );

	if ( bucket.timestamps.length >= limit.messages ) {
		bucket.timestamps = [];
		bucket.blockedUntil = now + ( limit.cooldown * 1000 );
		return 'tripped';
	}

	bucket.timestamps.push( now );
	return 'allowed';
}

/**
 * Check whether a message may be relayed
 * @param {'discord_to_zulip'|'zulip_to_discord'} direction The direction the message is relayed in
 * @param {String|Number} userId The user id of the sender
 * @param {String|Number} channelId The channel the message was sent in
 * @returns {{allowed: Boolean, tripped: String?, cooldown: Number}} Whether the message may be relayed, and the limit it hit
 */
export function checkRateLimit( direction, userId, channelId ) {
	const limits = rateLimits[direction];
	if ( !limits ) return { allowed: true, tripped: null, cooldown: 0 };

	const now = Date.now();
	for ( let [scope, id] of [['per_user', userId], ['per_channel', channelId]] ) {
		let state = checkBucket( `${direction}:${scope}:${id}`, limits[scope], now );
		if ( state === 'allowed' ) continue;

		// Only the message that trips a limit is worth warning about
		return {
			allowed: false,
			tripped: ( state === 'tripped' ? scope : null ),
			cooldown: limits[scope].cooldown
		};
	}

	return { allowed: true, tripped: null, cooldown: 0 };
}

/**
 * Forget buckets that are no longer in use
 */
function pruneBuckets() {
	const now = Date.now();
	buckets.forEach( (bucket, key) => {
		if ( bucket.blockedUntil > now ) return;
		if ( bucket.timestamps.some( timestamp => timestamp > now - 300_000 ) ) return;
		buckets.delete( key );
	} );
}

setInterval( pruneBuckets, 300_000 ).unref();
