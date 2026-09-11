import 'dotenv/config';
import * as Discord from 'discord.js';
import config from '../config.json' with { type: 'json' };

const allowedGuilds = config.allowed_discord_guilds ?? [];
const confirmed = process.argv.includes( '--confirm' );

if ( !allowedGuilds.length ) {
	console.error( '- Set "allowed_discord_guilds" in config.json first, there is nothing to keep.' );
	process.exit(1);
}

const discord = new Discord.Client( {
	intents: [Discord.GatewayIntentBits.Guilds]
} );

discord.once( Discord.Events.ClientReady, async () => {
	console.log( `\n- Logged in as ${discord.user.username}, currently in ${discord.guilds.cache.size} server(s):\n` );

	const leaving = [];
	discord.guilds.cache.forEach( guild => {
		let keep = allowedGuilds.includes( guild.id );
		if ( !keep ) leaving.push( guild );
		console.log( `  ${keep ? 'keep  ' : 'LEAVE '} ${guild.id}  ${guild.name}` );
	} );

	if ( !leaving.length ) {
		console.log( '\n- Nothing to leave.' );
		return await discord.destroy();
	}

	if ( !confirmed ) {
		console.log( `\n- Dry run, nothing changed. Re-run with --confirm to leave ${leaving.length} server(s).` );
		return await discord.destroy();
	}

	for ( let guild of leaving ) {
		await guild.leave().then( () => {
			console.log( `- Left ${guild.name} (${guild.id})` );
		}, error => {
			console.error( `- Could not leave ${guild.name} (${guild.id}):`, error.message );
		} );
	}

	console.log( '\n- Done.' );
	await discord.destroy();
} );

discord.login( process.env.DISCORD_TOKEN ).catch( error => {
	console.error( '- Error while logging in:', error.message );
	process.exit(1);
} );
