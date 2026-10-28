# Self Host Layer

Vercel on your own VPS, without Docker. Private while in development. Read [CLAUDE.md](CLAUDE.md) for the product and [PLAN-WEEK1.md](PLAN-WEEK1.md) for the current plan.

## Develop

Needs Node 24 (`.nvmrc`) and yarn 1. TypeScript runs directly through Node's type stripping, with no build step in development.

```sh
yarn install
yarn test          # vitest
yarn typecheck     # tsc, no emit
yarn build:installer   # → dist/install.sh (single file)
bash scripts/build-release.sh   # → dist/layer-<version>.tar.gz
```

| Path | What |
|---|---|
| `installer/` | `install.sh` plus `lib/*.sh`, bundled into one file by `scripts/build-installer.sh` |
| `agent/` | Root helper: allowlisted actions over a unix socket, templates for units and Caddy files |
| `packages/protocol/` | Action allowlist, validators and the agent client, shared by agent, CLI and panel |
| `packages/cli/` | The `layer` command: `ps`, `status`, `logs -f`, `score`, `info`, `call` |
| `panel/` | Next.js panel (runs as `layer`, unix socket only). `LAYER_FAKE_AGENT=1 yarn --cwd panel dev` for UI work on a Mac |
| `system/` | systemd units for the agent and the panel |
| `spike/` | Throwaway experiments to run on a test VPS |

## Test in a local Ubuntu VM

Install [Multipass](https://canonical.com/multipass) with `brew install --cask multipass`. Then:

```sh
scripts/dev-vm.sh up        # Ubuntu 24.04 VM, 2 CPU / 2GB RAM like a small VPS
scripts/dev-vm.sh release   # build the release tarball and run the real installer with it
scripts/dev-vm.sh ui        # Chrome tour of the VM's panel: setup, 2FA, sign in (dist/screenshots)
scripts/dev-vm.sh verify    # check the server state the installer promises
scripts/dev-vm.sh e2e       # agent and blue/green end-to-end tests
scripts/dev-vm.sh lint      # shellcheck every script inside the VM
scripts/dev-vm.sh spike     # the Day 1 sandbox spike
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
