# Install T3 Code

T3 Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch T3 Code and configure providers afterwards.

## Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

This installs the `t3` command to `~/.local/bin`. If that folder is not on your
`PATH` yet, the installer says so and, for zsh, bash on Linux, and fish, prints
a command to add it. On Windows, `t3` works in the same PowerShell window right
away; add the folder to your `PATH` for new windows. If a `t3` that the
installer or the desktop app did not create is already there, it leaves that
one alone and stops. Set `T3CODE_CHANNEL=nightly` to install the nightly train, or
`T3CODE_VERSION` to pin an exact version.

| Task                                  | Command                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Start the server and open the web app | `t3`                                                                    |
| Start the server without a browser    | `t3 serve`                                                              |
| Use it from your other devices        | `t3 up` ([details](./remote-access.md))                                 |
| Keep it running in the background     | `t3 service install` ([details](./background-service.md))               |
| Move to the newest release            | `t3 update`                                                             |
| Reclaim database space                | `t3 doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                       | `t3 uninstall`                                                          |

Run `t3 help` or `t3 --help` for the full reference. To start in a new working
directory, use an explicit path such as `t3 ./my-project`. A bare directory name
is accepted only if it already exists.

If `t3` or `t3 start` reports an already running server, run the `t3 pair`
command it names and open the pairing URL to connect to that server. Stop it
before starting a replacement, or use a different `--base-dir` for an
independent server.

To try T3 Code once without installing it, run `npx t3@latest` instead (needs
Node.js for `npx`). It offers to install the `t3` command first. If you say no,
it asks again at the next minor release, and `npx t3 install` installs it later.
`npx t3` always runs the version npm picked, even when a `t3` is installed. On
the nightly train, run your installed `t3` (for example `t3 connect`), not
`npx t3`, which runs the latest stable release.

### Intel Macs

There is no `t3` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with `vp`, which provides the Node version it needs
([Install vp](../operations/development.md#first-checkout)):

```bash
git clone https://github.com/pingdotgg/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`t3 update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download a release from [GitHub Releases](https://github.com/pingdotgg/t3code/releases),
or use a package manager:

| Platform           | Install                                                      |
| ------------------ | ------------------------------------------------------------ |
| Windows            | `winget install T3Tools.T3Code`                              |
| Windows (Scoop)    | `scoop install extras/t3code`                                |
| macOS              | `brew install --cask t3-code`                                |
| Debian, Ubuntu     | `sudo apt install ./T3-Code-*.deb`                           |
| Arch Linux         | `yay -S t3code-bin`                                          |
| Arch Linux nightly | `yay -S t3code-nightly-bin`                                  |
| Nix                | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code` |

### Linux

AppImage and `.deb` downloads are available for x86_64 and ARM64. Check your
architecture with `uname -m`: for `x86_64`, choose a file ending in
`x86_64.AppImage` or `amd64.deb`; for `aarch64`, choose `arm64.AppImage` or
`arm64.deb`.

To launch an AppImage, open a terminal in its download folder. Replace
`T3-Code.AppImage` below with the exact filename you downloaded:

```bash
chmod +x ./T3-Code.AppImage
./T3-Code.AppImage
```

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

The AUR packages currently support x86_64 only; on ARM64, use the AppImage.
Update AUR installs with your AUR helper, such as `yay -Syu`, instead of the
in-app updater.

### Nix (nixpkgs)

T3 Code is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code).
The command above installs from `nixos-unstable` and requires Nix 2.30 or later with
`nix-command` and `flakes` enabled. Launch the desktop app with `t3code-desktop`;
the package also includes the `t3` command.

On NixOS, you can instead add the package to your system configuration, using
a nixpkgs revision that includes `t3code`:

```nix
environment.systemPackages = [ pkgs.t3code ];
```

Apply the change with `sudo nixos-rebuild switch`. For Home Manager, add
`pkgs.t3code` to `home.packages` and run `home-manager switch`.

Update a profile installation with `nix profile upgrade t3code`. For NixOS or
Home Manager, update your configuration's nixpkgs input or channel and rebuild.
Nix manages both the desktop app and the bundled
`t3` command; use Nix to update them instead of the in-app updater or `t3 update`.

### The `t3` command

The desktop app includes the `t3` command-line tool. A new install sets it up
on first launch; after an update, or any time, choose **Install** next to
**t3 command** in **Settings → About**. On macOS and Linux it adds a `t3` link
in `~/.local/bin` (or `~/bin`); on Windows it adds the app's command folder to
your `PATH`. Open a new terminal afterwards. If the folder is not on your
`PATH`, **Add to PATH** on the Welcome page or in **Settings → About** adds one
line to your shell's startup file. **Remove** takes it off, and the app does not
add it again. If you already have another `t3`, it stays as it is.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. T3 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

### Drop a folder on the sidebar

Drag one or more folders from Finder, Explorer, or your file manager onto the
sidebar. Each one opens as a project on this computer, the same as `t3 app`.
Files dropped on a thread still attach to that thread. Browsers do not share
folder paths, so in the web app use **Add project** instead.

## Mobile app

Install T3 Code from the
[App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

Store links and QR codes are also available in **Settings → About → Mobile app**
on web and desktop. The store apps work with both stable and Nightly servers. Test builds are optional:

- **iPhone and iPad:** TestFlight is invite-only.
- **Android:** download an APK from the
  [Android beta releases](https://github.com/pingdotgg/t3code/releases?q=android-beta-).

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and sign in from provider settings. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then sign in from provider settings.                                                                    |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                                  |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                                     |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                             |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                               |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                                                                      |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                                     |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                                       |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                                     |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when T3 Code cannot tell. Claude, Codex, and
OpenCode installs T3 Code cannot identify stay manual: update them through the
installer you used. T3 Code runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with T3 Code. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release T3 Code tested. When T3 Code finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Claude and
Codex accounts can be added and signed in from the app: see [Claude](./providers-claude.md#separate-accounts-or-configurations)
and [Codex](./providers-codex.md#multiple-cli-logins). The other providers listed above
sign in with their own CLI on the environment's machine. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

### Thread isolation

Turn on **Settings → Providers → Advanced → Thread isolation** to run each
thread's agent on that environment's machine in a sandbox, including Claude's and
Codex's title and commit-message runs that can use tools. Work a provider runs in
its own cloud is not affected. The agent can write only the thread's folder (its
worktree or project folder) and its provider's own folders; for Claude and Codex,
a private folder holding the sign-in. Claude and Codex read your whole provider
configuration (settings, instructions, skills, plugins and MCP servers, including
the folder's own) but not your other sign-ins, history or projects. Every agent
reads the tools on T3 Code's `PATH` such as `npm`, `pnpm` and `corepack`, and
your Git name and email. Everything else on the machine is hidden apart from the
system files programs need, and the network reaches only the provider, GitHub,
PyPI, npm and T3 Code's own agent tools, on port 443, through T3 Code's own proxy
(and the proxy T3 Code itself uses, if any); SOCKS is not offered. Bedrock,
Vertex and a custom `ANTHROPIC_BASE_URL`, set in the environment or in Claude's
`settings.json`, also reach their own hosts, and read your `~/.aws` or gcloud
folder.

**Sandbox** chooses how: **Automatic (srt, then Docker)**, the default, uses
Anthropic's sandbox runtime (`srt`) and Docker where srt cannot run; **srt** or
**Docker** uses that one only. A thread that cannot be isolated starts as it
would without isolation, and says so: a shield icon on the thread in the
sidebar, its **Isolation…** dialog and the setting's status line give the
reason, while its session runs; the mark is gone when that session ends or
isolation is turned off, and after T3 Code restarts it returns only when the
thread starts again. Set **Threads that cannot be sandboxed** to **Refuse them** (in
Settings, or for one thread in its dialog) to stop such a thread instead, with
the same reason and how to fix it; runs that belong to no thread, such as
titles and commit messages, still start. That happens when the chosen sandbox cannot
run on the machine, and for:

- Cursor, which runs inside T3 Code's own process;
- OpenCode, whose server T3 Code reaches over the network, which a sandbox closes;
- Codex with custom model providers in `config.toml`;
- Docker on a folder that is not a Git repository;
- a Git older than 2.31, which T3 Code cannot keep from running what a thread
  wrote;
- on Windows, every provider but Claude and Codex, and a provider command that
  is a script other than an npm or pnpm shim starting Node.

A thread that can be isolated is stopped, with the reason, when what isolation
is asked to apply is wrong: an allowed host not written as `host:port`, a
variable name that is invalid or one isolation sets itself, an extra folder or
a provider's own folder variable that is missing, your home folder or one
holding it, T3 Code's own data, or (for a provider's folder) a system folder;
under the Windows bridge (below), any choice other than the defaults; and when the thread's Git
folder or hooks are links, or Git or Docker do not answer. Correct the value
where the message says, or turn isolation off.

The other providers each get their own folders, as T3 Code's code for them names
them, writable, so they sign in as usual: Antigravity its private `GEMINI_HOME`
(and, to read, only the skill folders T3 Code links from `~/.gemini`; the rest
of `~/.gemini`, the Gemini CLI's sign-in included, stays hidden), Grok `~/.grok`
(or `GROK_HOME`), Kiro `~/.kiro`, fx `~/.fx` and Pi `~/.pi` (or
`PI_CODING_AGENT_DIR`). Of the server's environment they receive only what T3
Code set for them, such as their configured variables. With **Provider only**,
Antigravity reaches Google's Cloud Code and sign-in hosts and Grok xAI's, plus
any host its configured base URL names; for Kiro, fx, Pi, Muse and ACP registry
agents, whose hosts T3 Code's code does not name, list them as allowed hosts,
and Muse's and an ACP registry agent's own folders, which it does not name
either, as writable folders. The thread's **Isolation…** dialog says which.
Their title and commit-message runs are not sandboxed.

The agent commits, branches, stashes, rebases, deletes branches and tags, and runs
`git gc` as usual. Git configuration and other worktrees' checkouts stay
read-only, and an isolated thread cannot edit hook files: the hooks folder, or
the whole project folder holding the one `core.hooksPath` names (all of
`.husky` for husky), is read-only to it, and so is a file your Git
configuration includes from the project (`include.path`), with the whole
project folder holding it. A hook still runs scripts and tools
from the project, which the agent can change, so while isolation is on T3 Code's
own Git commands in a folder an isolated thread has used run no hooks: a
pre-commit check does not run on a commit made from T3 Code there, and Git LFS
does not upload on its push (run `git lfs push` yourself). The agent's own Git
commands run your hooks, inside the sandbox. In a worktree, the agent still writes the
objects and branches of the repository it shares with the other worktrees. While
isolation is on, those commands of T3 Code's also run no fsmonitor or submodule
commands, so a repository the agent made
inside runs nothing outside the sandbox. Live isolated sessions of one Claude or
Codex account share one copy of its sign-in, so a refresh in one reaches the
others; a complete one is copied back while your own file is unchanged,
otherwise yours is kept, also after a crash. Isolation does not protect a
sign-in from the thread: a thread holds the sign-in it uses, so it can replace
it with another complete sign-in of the same plan; the other providers' folders
are open to their threads. Codex conversations are kept in
`sessions/t3code-isolated` in your Codex folder, so they resume after a restart.

What is not covered: a `.gitattributes` file can choose a diff or merge driver
your own Git configuration defines; a Codex conversation begun while isolation
is on may not resume once it is turned off; and when `srt` has to restart, the
running isolated threads lose their network until they start again. Where T3
Code itself reaches the internet through a proxy, **Any host** refuses this
machine only by the name or address the thread writes: a name that resolves to
this machine is resolved by that proxy.

On Linux, srt needs `bubblewrap` and `socat` from your package manager; T3 Code
includes srt itself. Docker isolation needs Docker and `socat`, and runs on Linux
only: it runs the provider with the machine's own Linux system folders. On
macOS, srt runs with macOS's own sandbox; this has not been tried on a Mac. On
Windows, srt runs the agent as a Windows account of its own, `srt-sandbox`,
behind a network fence that lets it reach only T3 Code's proxy. Both are made
once: press **Set up** on the setting's status line and approve the
administrator prompt Windows shows on the machine T3 Code runs on. To remove
them, press **Remove** there (offered whenever srt is set up, also when it
then fails to start), or run `srt-win.exe uninstall` from
`vendor\srt-win\x64` (or `arm64`) of the `@anthropic-ai/sandbox-runtime`
package T3 Code ships; in the desktop app that package is in
`resources\server.asar.unpacked\node_modules`. srt-win's fence lets the
sandbox reach only ports 60080 to 60089, where T3 Code's proxy listens; if
Hyper-V, WSL2 or Docker reserved them all (`netsh int ipv4 show
excludedportrange protocol=tcp` lists what is reserved), the status says so.
Until srt is set up, a
machine prepared earlier with `~/.t3/windows-sandbox.json` (or
`guild-sandbox.json`) uses that bridge instead; isolation is on by default where
that file exists or a provider had the sandbox on. Turning isolation on applies
to sessions started afterwards.

srt on Windows holds less than on Linux. Every isolated thread runs as the same
sandbox account, so threads running at the same time can read and write each
other's folders and private state, sign-ins included. The agent reads what
Windows lets every account read (other drives, program folders), and only your
user folder and T3 Code's data are hidden; files it creates belong to the sandbox account, which
later threads share, so a later thread can open those files again; your
provider settings and the sign-in are copies, so a sign-in refreshed in one
session reaches the others only when they start again. A thread's variables,
its sign-in and API keys among them, reach it through a file in its private
folder that T3 Code's launcher, run with T3 Code's own Node, deletes once read;
srt-win's command line, which other processes can read, carries only its own
`PATH`, Git settings and proxy port.

With isolation on, the same section also sets what isolated threads may reach
and receive; the defaults are what is described above. **Network access** is the
provider only (with its sign-in hosts and T3 Code's agent tools); the provider,
GitHub, PyPI, npm and the **Allowed hosts** you add (`host:port`); or any host:
a tunnel through T3 Code's proxy to any host and port, your local network and
link-local addresses such as a cloud machine's metadata service included, but
never this machine's own addresses, which still reach T3 Code only through its
agent tools. Plain `http://` requests reach only those tools in every mode.
**Environment variables** names variables of the server's environment a thread
receives besides its sign-in. **Writable folders** and **Readable folders** add
folders on the machine, one at a time, typed or chosen with **Browse…** where
the folder is on the machine the desktop app runs on; never your home folder or
one holding it, nor T3 Code's own data folder. A Git repository among the
writable folders keeps its Git configuration and hooks read-only, as the
thread's own folder does. A repository nested inside a writable folder that is
not itself a repository is not protected that way: list the repository itself.
Choose **Isolation…** in a
thread's menu to set its own sandbox and choices in place of these; a list it
sets starts from the one in Settings, and each applies from the thread's next
session. Changing either needs permission to change settings
and manage providers, which a thread itself does not have. Hooks stay read-only
whatever is chosen. The Windows bridge applies only the defaults: the choices
stay shown there so that one carried over from elsewhere can be reset.

With the Windows bridge, chatting and reading project files do not create a sandbox; the
first file write or code execution starts an isolated copy of the project,
which Claude and Codex reuse within the thread. Completed tool changes return to
the project, and conflicting outside edits are kept for recovery. Projects must
be Git repositories; tracked and unignored files are copied, and ignored
dependencies need installing inside the sandbox. Files outside the project and
T3 Code's own tools, such as delegation and scheduling, are unavailable there.
Hook files the agent changed return with the rest: T3 Code's own Git commands
there run no hooks, yours run them as changed.
Its title and commit-message runs are not sandboxed. Unlike the earlier
per-provider switch, the one setting covers Claude and Codex together. The
bridge scripts the prepared file points at (`apps/server/scripts/guild_sandbox.py`
and `guild_lazy.py`), their MCP server and the "Guild MCP tools" text the agent
sees keep their names, since prepared machines depend on them.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

### Provider check timeouts

If a provider works in its CLI but T3 Code reports a timeout while checking it,
allow more time in the T3 server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 t3 serve
```

For a remote environment, set these on the machine running the T3 server.
Keep them in your launcher or service configuration to retain them across
updates, then restart the server. For systemd, add
`Environment=T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                   |
| ------------------- | -------------------------------------- |
| Codex               | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code           | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure T3 Code for everyone on a machine.
