# Self Host Layer docs

Self Host Layer turns one Linux server into a place to deploy Node apps and static sites from GitHub, with a web panel on the server itself. There's no Docker: every app is a folder, a Linux user, a systemd unit and a Caddy site you can read, and your apps keep running if you remove the panel.

- **[Install](install.md):** what you need, the one command, what it changes on the server, updating, repairing and removing.
- **[The panel, page by page](panel.md):** what each page does, and what happens on the server when you press its buttons.
- **[Servers](servers.md):** one panel deploying to several servers, each its own agent-only install, and moving a project from one to another.
- **[Sites](sites.md):** WordPress and Ghost in one click, as many as the server holds, each its own sandboxed install with its own database.
- **[The `layer` command](cli.md):** the same things from an SSH session, with the raw commands underneath.
- **[Security model](security.md):** how apps are kept apart, what the panel can and can't do, and the honest limits.
- **[Moving an app from pm2](moving-from-pm2.md):** bringing an app and its data over from another server.
