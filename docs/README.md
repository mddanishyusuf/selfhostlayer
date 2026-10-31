# Self Host Layer docs

Self Host Layer turns one Linux server into a place to deploy Node apps and static sites from GitHub, with a web panel on the server itself. There's no Docker: every app is a folder, a Linux user, a systemd unit and a Caddy site you can read, and your apps keep running if you remove the panel.

- **[Install](install.md):** what you need, the one command, what it changes on the server, updating, repairing and removing.
- **[The panel, page by page](panel.md):** what each page does, and what happens on the server when you press its buttons.
- **[Links](links.md):** the link shortener in Integrations: short links on your own domain, with click stats and QR codes.
- **[The `layer` command](cli.md):** the same things from an SSH session, with the raw commands underneath.
- **[Security model](security.md):** how apps are kept apart, what the panel can and can't do, and the honest limits.
- **[Moving an app from pm2](moving-from-pm2.md):** bringing an app and its data over from another server.
