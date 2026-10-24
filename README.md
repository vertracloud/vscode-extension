# Vertra Cloud for VS Code

[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Marketplace-Vertra%20Cloud-0f0f10.svg)](https://marketplace.visualstudio.com/items?itemName=VertraCloud.vertra-cloud)
[![Open VSX](https://img.shields.io/open-vsx/v/VertraCloud/vertra-cloud.svg?label=Open%20VSX)](https://open-vsx.org/extension/VertraCloud/vertra-cloud)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Official [Vertra Cloud](https://vertracloud.app) extension: deploy, watch logs, check metrics, edit environment variables, manage databases, Docker images, snapshots and workspaces, and edit your app's files — without leaving the editor.

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

**Deploy** sends the linked folder; **Deploy folder...** sends any folder, to a new or existing application. Each deploy can carry a short message, filled in with your last git commit subject, so the version is easy to find in the Rollbacks history.

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

For applications with web publishing: publish and unpublish, open the site, choose a subdomain, add or remove custom domains, see the DNS records to configure, and purge the cache.

### Databases

Create databases, start and stop them, edit their name and memory, view metrics, download the TLS certificate and reset the password. The new password is shown once, right after the reset — it is never stored or shown again. Deleting a database asks you to type its name.

### Docker images

The **Docker Images** view lists your custom images with the status of the latest build (building, ready or failed), the reason when a build failed, and the applications that run from each one. The images of a workspace appear under that workspace. Custom images are available on Enterprise 28, 30 and 32; on other plans the view stays empty and creating one tells you why. The full guide is at [docs.vertracloud.app/guides/custom-docker-images](https://docs.vertracloud.app/guides/custom-docker-images).

- **Create Docker image** takes a folder (from the Command Palette, or right-click a folder in the Explorer) or a GitHub repository and branch. A folder needs a file named exactly `Dockerfile` at its root. It is zipped like the Vertra CLI does it: `.dockerignore` is respected, `.env*` files and symbolic links never leave your computer, and the extension stops before uploading anything over 100 MB (or over 512 MB uncompressed or 50,000 files).
- **Checked before building**: the Dockerfile is checked first. Refusals are listed with their line and stop the build; warnings (for example a `WORKDIR` under `/app`) ask you to confirm.
- **Rename Docker image** and **Edit Docker image description** (right-click an image) change the name (1 to 50 characters, unique among your images) and the description (up to 128 characters; empty removes it) without building anything: your applications keep running. The description also appears in the image's tooltip and details.
- **Rebuild from folder** replaces the whole build context. A rebuild never restarts your applications, and a failed build keeps the current version.
- **Show build log** replays the log of the build in an Output channel and keeps following it while the build runs.
- **List versions**, **Download build context**, **Link to GitHub** (a push to the branch rebuilds the image) and **Unlink from GitHub**.
- **Delete image** asks you to type the name. It also deletes every application created from the image, and an API key needs `apps:delete` as well when the image has applications.
- **Create application from image** asks for the name, RAM, whether it serves web traffic, the subdomain, the port (pre-filled with the first `EXPOSE` of your Dockerfile, or 80) and the variables.

For an application that runs from an image:

- **Deploy** is a commit: your files go on top of the image's current build context and the image is rebuilt. The extension tells you how many applications use the image before sending, and only this application restarts, and only if you ask for a restart.
- **Publish to web** asks for the port the image listens on when the application was created without web.
- **Restore** a snapshot can also bring back the image version the snapshot was taken on, when that version still exists.
- Language, version, main file, start and build commands come from the image, so they are not offered.

### Rollbacks

**Rollbacks...** on an application lists its versions with status, author and date. Pick one to roll back to it (with the option to bring back that version's environment variables, after showing which names would change), view the log of a version that crashed, or copy its ID. Rolling back needs the Pro plan or above.

### Snapshots

**Manage snapshots** lists, creates, downloads and restores snapshots of applications and databases. Restoring always asks for confirmation.

### Blob Storage

The **Blob** view shows your Blob Storage as folders and files, with the used and total storage at the top.

- **Upload**: right-click files or folders in the Explorer and choose **Upload to Blob Storage**, drag them onto the Blob view, or use the upload button of the view. Progress is cancellable; paths that already exist are skipped, never overwritten.
- **Share**: copy the public URL, copy a Markdown image link (`![name](url)`), or create a temporary link valid for 10 minutes, 1 hour or 24 hours. A temporary link can't be revoked before it expires.
- **Manage**: preview images and text inside the editor (other files are downloaded), rename or move, switch between public and private, and delete a file or a whole folder. Deleting always asks for confirmation.

The setting `vertraCloud.blob.baseUrl` changes the Blob API address and rarely needs touching. Blob Storage is available on the plans that include it; see [docs.vertracloud.app](https://docs.vertracloud.app).

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
| Blob Storage | `blob:read` (browse, preview, links), `blob:write` (upload, rename, visibility, delete) |
| Docker images | `images:read` (list, details, versions, logs, context, Dockerfile check), `images:write` (create, rebuild, delete, GitHub link); creating an application from an image uses `apps:write` |
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
| Network | Publish to web · Unpublish from web · Set subdomain · Add custom domain · Remove custom domain · Show DNS settings · Purge cache |
| Docker images | Create Docker image · Rebuild Docker image from folder · Show build log · List versions · Download build context · Link to GitHub · Unlink from GitHub · Delete image · Create application from image |
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
