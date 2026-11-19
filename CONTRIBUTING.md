# Contributing

Thanks for wanting to help. Self Host Layer is open source under the [MIT license](LICENSE), and issues and pull requests are welcome.

## Issues

- **Bugs:** use the bug report form, with your version, OS and the relevant logs (secrets removed).
- **Ideas:** use the feature request form. Describe the problem first; the solution can be worked out together.
- **Security problems:** never in a public issue. See [SECURITY.md](SECURITY.md).

## Pull requests

1. For anything bigger than a small fix, **open an issue first** so we agree on the approach before you spend time on it.
2. Fork the repo and make a branch from `main`.
3. Keep the PR focused on one change. Update `docs/` when behaviour changes.
4. Run the checks:

   ```sh
   yarn install
   yarn test
   yarn typecheck
   ```

   Changes to the installer or the agent should also be tried in the dev VM (`scripts/dev-vm.sh up`, then `release` and `e2e`; see the README).
5. Open the PR and fill in the template.

**Every pull request is reviewed by the maintainer, and only the maintainer merges.** Reviews may ask for changes; that's normal. Some PRs won't be merged if they don't fit the project's direction (no Docker, small memory footprint, everything readable on the server), which is another reason to open an issue first.

By submitting a pull request, you agree that your contribution is licensed under the MIT license.

## Ground rules for the code

- **The agent is the only thing that runs as root.** New root actions go through the allowlist in `packages/protocol` with strict validators; the panel never gets more power than it needs.
- **No new heavy dependencies** without a reason: the whole panel is meant to idle in a few hundred MB.
- **Everything stays plain on the server:** a folder, a Linux user, a systemd unit, a Caddy file. If a feature would hide state somewhere a user can't read it, rethink it.
- Write docs as plain, short sentences for someone who isn't a sysadmin.
