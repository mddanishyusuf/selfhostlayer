# Self Host Layer docs

Self Host Layer turns one Linux server into a place to deploy Node apps and static sites from GitHub, with a web panel on the server itself. There's no Docker: every app is a folder, a Linux user, a systemd unit and a Caddy site you can read, and your apps keep running if you remove the panel.

- **[Install](install.md):** what you need, the one command, what it changes on the server, updating, repairing and removing.
- **[The panel, page by page](panel.md):** what each page does, and what happens on the server when you press its buttons.
- **[Servers](servers.md):** one panel deploying to several servers, each its own agent-only install, and moving a project from one to another.
- **[Sites](sites.md):** WordPress and Ghost in one click, as many as the server holds, each its own sandboxed install with its own database.
- **[Links](links.md):** the link shortener in Integrations: short links on your own domain, with click stats and QR codes.
- **[Email](email.md):** newsletters, transactional email (a Resend-compatible API) and automations, through your SMTP or Amazon SES.
- **[Forms](forms.md):** forms and surveys like Typeform or Tally, one page or one question at a time, with logic, uploads, embeds and signed webhooks.
- **[Analytics](analytics.md):** cookie-free web analytics for your sites, on your own server, with goals and the revenue each source brings in.
- **[The `layer` command](cli.md):** the same things from an SSH session, with the raw commands underneath.
- **[Security model](security.md):** how apps are kept apart, what the panel can and can't do, and the honest limits.
- **[Moving an app from pm2](moving-from-pm2.md):** bringing an app and its data over from another server.
