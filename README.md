# Self Host Layer

Vercel on your own VPS, without Docker. Private while in development. Read [CLAUDE.md](CLAUDE.md) for the product and [PLAN-WEEK1.md](PLAN-WEEK1.md) for the current plan.

## Develop

Needs Node 24 (`.nvmrc`) and yarn 1. TypeScript runs directly through Node's type stripping, with no build step in development.

```sh
yarn install
yarn test          # vitest
yarn typecheck     # tsc, no emit
yarn build:installer   # → dist/install.sh (single file)
```

| Path | What |
|---|---|
| `installer/` | `install.sh` plus `lib/*.sh`, bundled into one file by `scripts/build-installer.sh` |
| `agent/` | Root helper: allowlisted actions over a unix socket, templates for units and Caddy files |
| `packages/protocol/` | Action allowlist and validators shared by agent and panel |
| `spike/` | Throwaway experiments to run on a test VPS |

## Test in a local Ubuntu VM

Install [Multipass](https://canonical.com/multipass) with `brew install --cask multipass`. Then:

```sh
scripts/dev-vm.sh up        # Ubuntu 24.04 VM, 2 CPU / 2GB RAM like a small VPS
scripts/dev-vm.sh spike     # run the Day 1 sandbox spike inside it
scripts/dev-vm.sh install   # build and run the installer inside it
scripts/dev-vm.sh reset     # start again from a fresh box
```

Use `LAYER_VM_IMAGE=26.04` to test the other Ubuntu release. The VM has no public IP, so anything that needs real Let's Encrypt certificates still needs a real VPS.

## Day 1 spike: Next.js inside the sandbox

On a throwaway Ubuntu 24.04/26.04 box (or use `scripts/dev-vm.sh spike`):

```sh
node agent/scripts/render-unit.ts --slug hello --node 24.13.1 --write .next/cache \
  -- node node_modules/next/dist/bin/next start -H 127.0.0.1 > /tmp/app-hello@.service
scp spike/next-sandbox.sh /tmp/app-hello@.service root@<box>:
ssh root@<box> bash next-sandbox.sh app-hello@.service
ssh root@<box> bash next-sandbox.sh --cleanup
```
