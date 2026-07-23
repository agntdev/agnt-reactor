# Multi-Bot Reaction Manager — Bot specification

**Archetype:** custom

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram service that creates and manages multiple bots to automatically post reactions (messages/replies) in channels, meeting engagement targets while following Telegram TOS and rate limits. Owners can configure bot pools, reaction rules, and monitor activity.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Telegram channel owners
- Content managers
- Community moderators

## Success criteria

- System maintains 20% reaction rate on channels with 1k-10k subscribers
- Bots are created and managed without violating Telegram TOS
- Owners receive alerts for quota events and errors

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu for bot management
- **Onboard Account** (button, actor: user, callback: onboard:start) — Begin linking Telegram account and authorizing channels
- **Create Bot Pool** (button, actor: user, callback: bot_pool:create) — Request X bots for a channel or let system decide
  - inputs: Channel ID, Number of bots
  - outputs: Bot profile list
- **Configure Reaction Rule** (button, actor: user, callback: reaction_rule:configure) — Set target, timing, and message templates for reactions
  - inputs: Reaction target percentage, Timing rules, Message templates
  - outputs: Reaction job configuration
- **Monitor Jobs** (button, actor: user, callback: monitor:jobs) — View status of recent jobs and bot pool activity
  - inputs: Filter by channel, Filter by time range
  - outputs: Job status summary

## Flows

### Onboarding
_Trigger:_ onboard:start

1. Connect Telegram account
2. Authorize channel linking

_Data touched:_ Owner account, Channel

### Bot Pool Creation
_Trigger:_ bot_pool:create

1. Request bot count
2. Create/register bots
3. Add bots to channel

_Data touched:_ Bot profile, Bot pool, Channel

### Reaction Job Execution
_Trigger:_ reaction_rule:execute

1. Calculate required reactions
2. Select bots from pool
3. Post reactions with rate limit awareness

_Data touched:_ Reaction job, Bot pool, Logs

### Monitoring
_Trigger:_ monitor:jobs

1. Fetch job status
2. Display summary
3. Allow filtering

_Data touched:_ Logs, Reaction job

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Owner account** _(retention: persistent)_ — User who manages channels and bot pools
  - fields: Telegram user ID, Email (optional)
- **Channel** _(retention: persistent)_ — Telegram channel linked to the system with subscriber count snapshot
  - fields: Channel ID, Subscriber count, Linked status
- **Bot profile** _(retention: persistent)_ — Telegram bot identity with credentials
  - fields: Bot token, Display name, Creation date
- **Bot pool** _(retention: persistent)_ — Set of bot profiles assigned to a channel
  - fields: Channel ID, Bot profile list, Creation date
- **Reaction job** _(retention: persistent)_ — Rule or scheduled task for posting reactions
  - fields: Target percentage, Timing rules, Message templates, Status
- **Logs** _(retention: persistent)_ — Record of posts and delivery status
  - fields: Bot ID, Message content, Timestamp, Status

## Integrations

- **Telegram** (required) — Bot registration, channel management, and message posting
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Create/assign bots
- Configure reaction rules
- Pause/scale bot pool
- View job status
- Receive notifications

## Notifications

- Telegram direct message alerts for quota events
- In-app dashboard alerts for errors and confirmations

## Permissions & privacy

- Owner must authorize channel linking
- Bot credentials are stored securely
- Subscriber data is not shared or sold

## Edge cases

- Channel subscriber count changes mid-job
- Telegram rate limits are exceeded
- Owner requests more bots than plan allows
- Bot is removed from channel by admin

## Required tests

- Verify 20% reaction target is met across 10k subscriber channel
- Confirm bots are created and added to channels without violating TOS
- Test rate limit handling during high-volume job

## Assumptions

- System creates bots by default unless owner provides existing tokens
- Reaction target defaults to 20% of subscribers
- Free tier supports up to 10 bots
- Notifications are sent via Telegram DM by default
