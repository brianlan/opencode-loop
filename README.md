# opencode-loop

An [OpenCode](https://opencode.ai) plugin that lets you create, list, and delete system cron jobs through AI conversation.

## Features

- **cron_create** – Add a cron job using standard 5-field syntax
- **cron_list** – View all managed cron jobs
- **cron_delete** – Remove a cron job by name

All cron jobs are stored in the system crontab (via `crontab -e`), so they survive OpenCode restarts and run even when OpenCode is not active.

## Installation

### Option A: bunx (zero-config)

Run this inside your project directory:

```bash
bunx opencode-loop install
```

This creates `.opencode/plugins/opencode-loop.ts` automatically. Restart OpenCode and the plugin is ready.

### Option B: npm package

Add the package to your project and reference it in `opencode.json`:

```bash
bun add -d opencode-loop
# or: npm install -D opencode-loop
```

Then in `opencode.json`:

```json
{
  "plugins": {
    "opencode-loop": {
      "enabled": true
    }
  }
}
```

### Option C: manual

Copy `src/index.ts` into `.opencode/plugins/opencode-loop.ts` in your project.

## Usage

Once installed, just ask OpenCode:

- "Create a daily backup cron job at 2 AM that runs `tar czf backup.tar.gz ./src`"
- "List all my cron jobs"
- "Delete the backup cron job"

## Permissions

This plugin inherits the current OpenCode agent's permissions. When the AI calls `cron_create` or `cron_delete`, OpenCode will ask for approval according to your agent rules, unless you have configured auto-allow.

## License

MIT
