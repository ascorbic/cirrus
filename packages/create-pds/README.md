# create-pds

Scaffold a new [AT Protocol](https://atproto.com) Personal Data Server (PDS) on Cloudflare Workers.

## Usage

```bash
npm create pds
# or
pnpm create pds
yarn create pds
bun create pds
```

This will:

1. Create a new project directory with the PDS template
2. Install dependencies
3. Run the setup wizard to configure your PDS

## Options

```
create-pds [name]

Arguments:
  name                Project name (default: pds-worker)

Options:
  --package-manager   Package manager to use (npm, yarn, pnpm, bun)
  --skip-install      Skip installing dependencies
  --skip-git          Skip git initialization
  --skip-init         Skip running pds init
  -y, --yes           Accept all defaults (non-interactive)
```

## What's Next

After scaffolding, start the dev server:

```bash
cd pds-worker
npm run dev
```

Your PDS will be running at http://localhost:5173

See the [@ascorbic/pds documentation](https://github.com/ascorbic/atproto-worker/tree/main/packages/pds) for configuration and deployment instructions.
