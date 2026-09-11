# discord-zulip-bridge

## Features

- [x] Two-way Discord-Zulip message relay
- [x] Supports message edit/delete/reply with SQLite
- [x] Converts Discord/Zulip specific message format
  - [x] Reply (except ping)
  - [x] Quote block
  - [x] Message link
  - [x] Channel mention
  - [x] Discord message forwarding
  - [x] Discord embeds
  - [x] Escape wildcard mention
  - [x] Timestamp
  - [ ] File
  - [x] Silent mention
  - [x] Zulip linkifier

## Setup

1. Install latest LTS Node.js
2. Run `npm install` and `npm run build` (`npm run build` also applies database schema changes when updating)
3. Create `.env` file with:
```env
DISCORD_TOKEN=""
DISCORD_ID="(Discord user id of the bot)"
ZULIP_ID="(Zulip user id of the bot)"
ZULIP_USERNAME="(This is the bot email)"
ZULIP_API_KEY=""
ZULIP_REALM="https://your-org.zulipchat.com"
```
4. Create `config.json` file (see `config.example.json`) with:
```json
{
	"ignored_discord_users": [],
	"ignored_zulip_users": [],
	"mentionable_discord_roles": [],
	"mentionable_zulip_groups": [],
	"text_replacements": {},
	"upload_files_to_zulip": false
}
```
   See [Feature toggles](#feature-toggles) to turn individual features on and off.
5. Run `npm start` to start the bridge
6. See [Commands](#commands) to set up channel links

## Feature toggles

Every relayed feature can be switched off individually with an optional `features` key in `config.json`.

```json
{
	"features": {
		"discord_to_zulip": {
			"embeds": false,
			"stickers": false
		},
		"zulip_to_discord": {
			"deletes": false
		}
	}
}
```

### `discord_to_zulip`

| Option | Effect when `false` |
| --- | --- |
| `messages` | No Discord message is relayed to Zulip (makes the bridge Zulip→Discord only) |
| `edits` | Editing a Discord message leaves the Zulip copy untouched |
| `deletes` | Deleting a Discord message leaves the Zulip copy in place |
| `threads` | New Discord threads no longer create a Zulip topic |
| `replies` | Replies relay as plain messages, without the quoted source line |
| `forwards` | Forwarded messages relay as plain messages |
| `embeds` | Rich embeds are replaced by a `[1 embed]` placeholder linking to the Discord message |
| `message_links` | Discord message links stay as `discord.com` links instead of becoming Zulip narrow links |
| `channel_mentions` | `#channel` mentions are not rewritten to Zulip channel mentions |
| `group_mentions` | Role/group mentions are not converted (`mentionable_zulip_groups` is ignored) |
| `escape_wildcard_mentions` | `@**all**` and friends are relayed unescaped and **will** ping the Zulip channel |
| `quote_blocks` | Discord `>>>` quote blocks are not converted to Zulip quote blocks |
| `text_replacements` | `text_replacements` is not applied in this direction |
| `timestamps` | Discord timestamps stay as raw `<t:…>` markup |
| `stickers` | Stickers are replaced by a `[1 sticker]` placeholder linking to the Discord message |
| `attachments` | Attachments are replaced by a `[1 attachment]` placeholder linking to the Discord message |
| `upload_files` | Files are linked by Discord CDN URL instead of re-uploaded to Zulip (defaults to the top-level `upload_files_to_zulip` value) |

### `zulip_to_discord`

| Option | Effect when `false` |
| --- | --- |
| `messages` | No Zulip message is relayed to Discord (makes the bridge Discord→Zulip only). The `!bridge` command keeps working |
| `edits` | Editing a Zulip message leaves the Discord copy untouched |
| `deletes` | Deleting a Zulip message leaves the Discord copy in place |
| `threads` | New Zulip topics no longer create a Discord thread |
| `text_replacements` | `text_replacements` is not applied in this direction |
| `role_mentions` | Zulip group mentions never become real Discord role pings (`mentionable_discord_roles` is ignored) |
| `user_mentions` | User mentions keep their Zulip `|id` suffix |
| `silent_mentions` | Zulip silent mentions (`@_`) are relayed literally rather than as plain mentions |
| `message_links` | Zulip narrow links stay as Zulip URLs instead of becoming Discord message links |
| `message_mentions` | `#**channel>topic@123**` is not resolved to the bridged Discord message |
| `topic_mentions` | `#**channel>topic**` is not resolved to the bridged Discord channel |
| `channel_mentions` | `#**channel**` is not resolved to the bridged Discord channel |
| `file_uploads` | Zulip uploads are linked by Zulip URL instead of being mirrored to Discord (files in private channels will not be viewable from Discord) |
| `quotes` | Zulip quote blocks are relayed as raw ```` ```quote ```` fences |
| `default_code_block_language` | Unlabelled code blocks are not given the realm's default language |
| `timestamps` | Zulip `<time:…>` markup is relayed literally |
| `linkifiers` | Realm linkifiers are not applied |


## Mass mentions

Mass pings are blocked in both directions by default, and every message the bridge sends to Discord declares its allowed mentions explicitly rather than relying on a client-wide default.

| Setting | Default | Effect |
| --- | --- | --- |
| `allow_mass_mentions` | `false` | `@everyone` and `@here` relayed from Zulip cannot ping anyone on Discord |
| `mentionable_discord_roles` | `[]` | Only roles listed here can be pinged from Zulip, so an empty list blocks every role ping |
| `mentionable_zulip_groups` | `[]` | Only groups listed here can be pinged from Discord, everything else is relayed as a silent mention |
| `escape_wildcard_mentions` | `true` | `@**all**`, `@**everyone**`, `@**channel**` and `@**topic**` are escaped to silent mentions on the way to Zulip |

Leave `allow_mass_mentions` off and both lists empty and no relayed message can ping a whole channel, a whole organization, or any role. Individual user mentions still work, and a relayed reply still notifies the person being replied to.


## Rate limiting

The bridge limits how many messages a single user or a single channel can relay, to keep a spammer on one platform from flooding the other. Limits are applied per direction and are configured with an optional `rate_limits` key in `config.json`. Setting `messages` to `0` turns that limit off.

```json
{
	"rate_limit_exempt_discord_users": [],
	"rate_limit_exempt_zulip_users": [],
	"rate_limits": {
		"discord_to_zulip": {
			"per_user": { "messages": 10, "seconds": 30, "cooldown": 60 },
			"per_channel": { "messages": 60, "seconds": 30, "cooldown": 30 }
		},
		"zulip_to_discord": {
			"per_user": { "messages": 10, "seconds": 30, "cooldown": 60 },
			"per_channel": { "messages": 60, "seconds": 30, "cooldown": 30 }
		}
	}
}
```

| Option | Meaning |
| --- | --- |
| `messages` | How many messages are allowed within the window, `0` disables the limit |
| `seconds` | The length of the window |
| `cooldown` | How long relaying is paused for once the limit is reached |
| `per_user` | Applied to each sender, catches a single spammer |
| `per_channel` | Applied to each bridged channel, catches a raid spread across several accounts |
| `rate_limit_exempt_discord_users` | Discord user ids that are never rate limited |
| `rate_limit_exempt_zulip_users` | Zulip user ids that are never rate limited |

Message edits count against the same budget as new messages, since edits flood just as effectively. When a limit is reached the bridge posts a single notice on the receiving side and then drops messages silently until the cooldown expires, so the safeguard does not amplify the spam it is stopping. Counters are kept in memory only and reset when the bridge restarts.


## Pausing the bridge

The bridge can be paused by hand during an incident, without restarting it or removing the channel link. Pausing stops new messages, edits and new threads from being relayed in both directions. Message deletions still go through, so moderators can clean up spam that was already relayed.

Only Zulip organization owners and administrators may use the command, and on Discord only the server owner and members with the Administrator permission. Anyone else writing a message that starts with `!bridge` has it relayed as an ordinary message.

On Zulip, DM the bot:

- `!bridge pause all` and `!bridge resume all`
- `!bridge pause #**Channel>Topic**` and `!bridge resume #**Channel>Topic**`
- `!bridge status`

On Discord, in any channel the bot can see:

- `!bridge pause` and `!bridge resume` for the current channel
- `!bridge pause all` and `!bridge resume all`
- `!bridge status`

Discord commands only ever affect bridges belonging to the server the command was sent in, so being an administrator of some other server the bot happens to be in grants nothing. `!bridge pause all` on Discord pauses that server's bridges, not every bridge. The Zulip command is organization-wide, since a Zulip owner or administrator is already trusted with the whole realm.

The paused state is stored in the database, so it survives a restart or a redeploy. A channel paused during an incident stays paused until someone resumes it. The command is checked before the rate limit, so a flood can never stop an administrator from pausing the bridge.


## Commands

The `!bridge` command is available to configure channel links. You can use this command by DMing the bot on Zulip. Note that you must be an admin to perform this.

- Syntax: `!bridge <zulipChannelMention> <discordChannelId> <includeThreads>`
- Options:
  - `zulipChannelMention`: Mention the channel on Zulip
  - `discordChannelId`: You can obtain this by turning on User Settings > Advanced > Developer Mode and right click the channel to copy its ID
  - If `includeThreads` is `true`, threads created on the Zulip/Discord channel will be synced to the respective Discord/Zulip channel.
- Example: `!bridge #**Channel>Topic** 123456789012345 true`
