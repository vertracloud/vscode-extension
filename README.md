# Vertra Cloud for VS Code

[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Marketplace-Vertra%20Cloud-0f0f10.svg)](https://marketplace.visualstudio.com/items?itemName=VertraCloud.vertra-cloud)
[![Open VSX](https://img.shields.io/open-vsx/v/VertraCloud/vertra-cloud.svg?label=Open%20VSX)](https://open-vsx.org/extension/VertraCloud/vertra-cloud)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Official [Vertra Cloud](https://vertracloud.app) extension: deploy, watch logs, check metrics, edit environment variables, manage databases, snapshots and workspaces, and edit your app's files — without leaving the editor.

- Works in VS Code, Cursor, Google Antigravity and other VS Code-compatible editors.
- Interface in English, Portuguese and Spanish, following your editor's language.
- No telemetry. Your credential lives only in the editor's secret storage.

## Installation

| Editor | Where |
|---|---|
| VS Code | [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=VertraCloud.vertra-cloud) — search for "Vertra Cloud" |
| Cursor, VSCodium and other Open VSX editors | [Open VSX](https://open-vsx.org/extension/VertraCloud/vertra-cloud) — search for "Vertra Cloud" |
| Anything else | Download the `.vsix` from a [release](https://github.com/vertracloud/vscode-extension/releases) and run `code --install-extension vertra-cloud-<version>.vsix` (use your editor's CLI in place of `code`) |

Requires a VS Code-compatible editor at version 1.85 or later.

## Getting started

1. Open the **Vertra Cloud** panel in the Activity Bar.
2. Run **Use API key**: create a key in the dashboard under **Settings → API keys** and paste it when asked. See [scopes](#api-key-scopes) for what to grant.
3. Open your project folder and run **Link folder to application**. The link is saved as `ID=<application id>` in a `vertracloud.config` file — the same file the Vertra CLI reads.
4. Run **Deploy**. That's it: the folder is zipped, uploaded and your app restarts with the new code.

## Features

### Deploy

**Deploy** sends the linked folder; **Deploy folder...** sends any folder, to a new or existing application.

- Files matched by `.vertraignore` (or `.vertracloudignore`) are left out, along with version control, dependency and build folders by default.
- Uploads are capped at 100 MB; the extension stops before uploading anything larger.
- **Run checks** looks at the project locally before a deploy: missing main file, invalid `package.json`, a `.env` file or reserved keys in it, files that should not be deployed, and project size.
- **Show deploys** lists the deploy history, and **Pull files from Vertra Cloud** downloads the application's current files into the folder (after asking, since local files with the same path are overwritten).

### `vertracloud.config`

The project file gets syntax highlighting, completion, hover help and inline errors. **Create config file** writes one for you, and **Edit config file** opens it.

### Applications

- Start, stop and restart — also **Restart (reinstall dependencies)** and **Restart (force build)**.
- **Show logs** prints recent output; **Toggle realtime logs** streams it live to an output channel and reconnects while the connection stays healthy.
- **Show metrics** summarizes CPU, memory and network usage.
- **Manage environment variables** adds, edits and removes variables. Values are masked, and never copied or logged unless you ask.
- **Open remote files** mounts the application's files as a `vertra://` folder, so you can open, edit and save them in place. Deleting, moving and uploading ask first.
- **Delete application** asks you to type the name before deleting.

### Network

For applications with web publishing: publish and unpublish, open the site, choose a subdomain, connect a custom domain, see the DNS records to configure, and purge the cache.

### Databases

Create databases, start and stop them, edit their name and memory, view metrics, download the TLS certificate and reset the password. The new password is shown once, right after the reset — it is never stored or shown again. Deleting a database asks you to type its name.

### Snapshots

**Manage snapshots** lists, creates, downloads and restores snapshots of applications and databases. Restoring always asks for confirmation.

### Workspaces

Create and edit workspaces, link applications and databases to them, and delete a workspace you own.

- **Manage invites** lists pending invites and revokes them.
- **Open workspace invite** takes an invite link or token, shows who invited you and to which workspace, and lets you accept or decline.
- **Request an action** asks the workspace owner to approve a destructive action (deleting an app or database, creating or restoring a snapshot); **View action requests** follows their status.

Sending new invites, transferring ownership and approving action requests are done in the dashboard.

### Organization

Group applications and databases into colored folders and mark favorites. The organization is saved to your account, so the dashboard shows the same folders.

## Plan availability

Every plan can connect, deploy, control, view logs and manage environment variables. Some features — web publishing, custom domains, manual snapshots, workspaces — depend on the plan of the application's owner; see [docs.vertracloud.app](https://docs.vertracloud.app) for what each plan includes. When an action needs a higher plan, the extension tells you instead of failing silently.

## API key scopes

Grant only the scopes you use when creating the key.

| To... | Scopes |
|---|---|
| See your apps, databases and account | `account:read`, `apps:read`, `databases:read` |
| Deploy, control and configure apps | `apps:write` (+ `apps:envs` for variables, `apps:files` for remote files, `apps:delete` to delete) |
| Manage databases | `databases:write` (+ `databases:credentials` for certificate and password, `databases:delete` to delete) |
| Snapshots | `snapshots:read`, `snapshots:write` |
| Folders and favorites | `account:write` |
| Workspaces | `workspaces:read`, `workspaces:write` (+ `workspaces:invites` for invites, `workspaces:delete` to delete a workspace) |

A missing scope shows up as an error naming the scope, with a shortcut to the key management page. The full list is in the [API reference](https://docs.vertracloud.app/api-reference/introduction).

## Privacy and security

- The API key is kept only in the editor's secret storage — never in settings, workspace files or logs.
- The extension sends requests only to `api.vertracloud.app`.
- No telemetry, no analytics.
- In an untrusted workspace, deploying, pulling files and writing remote files are disabled.
- **Disconnect** removes the credential from this editor only. To revoke it, delete the key or session in the dashboard.

## Troubleshooting

| Message | What to do |
|---|---|
| Invalid API key | The key was revoked or mistyped. Create a new one and connect again. |
| Missing scope | Your key lacks the scope named in the error. Edit the key in the dashboard or create one with that scope. |
| Plan restriction | The action needs a higher plan (see [plan availability](#plan-availability)). |
| Project is too large to deploy | Add build output and large assets to `.vertraignore`. |

## Commands

Every command is in the Command Palette under **Vertra Cloud**, and in the context menu of each item in the panel.

<details>
<summary>Full list</summary>

| Area | Commands |
|---|---|
| Account | Use API key · Disconnect · Refresh · Show service status · Open dashboard · Open documentation · Copy ID |
| Project | Link folder to application · Unlink folder · Deploy · Deploy folder... · Pull files from Vertra Cloud · Run checks · Create config file · Edit config file · Show deploys |
| Applications | Start · Stop · Restart · Restart (reinstall dependencies) · Restart (force build) · Open in browser · Show logs · Toggle realtime logs · Show metrics · Manage environment variables · Manage snapshots · Open remote files · Delete application |
| Network | Publish to web · Unpublish from web · Set subdomain · Show DNS settings · Purge cache |
| Databases | Create database · Start · Stop · Edit database · Show metrics · Download certificate · Reset password · Manage snapshots · Delete database |
| Workspaces | Create workspace · Edit workspace · Link application · Link database · Delete workspace · Manage invites · Open workspace invite · View action requests · Request an action |
| Organization | Create, rename, recolor and delete resource folders · Add or remove a resource · Add or remove favorites |

</details>

## Documentation

- Product docs: [docs.vertracloud.app](https://docs.vertracloud.app)
- API reference: [docs.vertracloud.app/api-reference](https://docs.vertracloud.app/api-reference/introduction)
- Changes in each version: [CHANGELOG](CHANGELOG.md)

## Contributing

Issues and pull requests are welcome at [github.com/vertracloud/vscode-extension](https://github.com/vertracloud/vscode-extension). Before sending a change, run:

```bash
npm run lint && npm run typecheck && npm test
```

## License

[MIT](LICENSE)
