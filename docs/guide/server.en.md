# Deploy the server

[中文](server.md)

This guide explains how to deploy and maintain the server (`kiteline-server`), which provides the workbench web app, API, device connections and development-service proxy. Once deployed, follow [Connect devices](devices.en.md) to connect your first device.

## Runtime requirements

- The server runs on Linux amd64 or arm64, with two deployment options:
  - Docker image `ghcr.io/azure99/kiteline:<version>`. Each tag includes both amd64 and arm64.
  - Native release package `kiteline-server-<version>-linux-<architecture>.tar.gz`, available from [GitHub Releases](https://github.com/Azure99/kiteline/releases). It includes the official Node runtime, a dynamically linked build requiring glibc, and targets Ubuntu 24.04.
- The server provides HTTP only and does not manage TLS certificates. For HTTPS, place a reverse proxy in front of it; see [HTTPS and reverse proxies](#https-and-reverse-proxies).
- By default, the server accepts connections only at `127.0.0.1:8080`. For access from other machines, see [LAN access and ports](#lan-access-and-ports).
- The owner password, login sessions and device registrations are stored in the server data directory (default `/var/lib/kiteline`, database file `kiteline.sqlite`). The server sets this directory's permissions to `0700` at every startup. Only one server process can use a data directory at a time.
- One server can be accessed through several origins. An origin combines the scheme, hostname and port, such as `http://192.168.1.10:8080` or `https://kiteline.example.com`. The server must be deployed at the origin's root path; subpaths such as `https://example.com/kiteline/` are not supported.
- Server release packages and images contain agent release packages for every platform. Devices download the agent matching the server's version from the server when connecting or upgrading, without needing access to GitHub.

For server environment variables, see [Reference](reference.en.md#server-environment-variables).

## Deploy with Docker

Docker Engine and Docker Compose v2 (the `docker compose` command) are required. Run these commands on the server host as a user with Docker access (root or a member of the `docker` group).

1. Create a deployment directory, download `compose.yaml` from the repository tag for your version, and write the version to `.env`:

   ```sh
   KITELINE_VERSION=X.Y.Z  # Replace with the version to deploy
   mkdir -p ~/kiteline && cd ~/kiteline
   curl -fsSLO "https://raw.githubusercontent.com/Azure99/kiteline/v$KITELINE_VERSION/deploy/compose.yaml"
   printf 'KITELINE_VERSION=%s\n' "$KITELINE_VERSION" > .env
   ```

   Docker Compose automatically reads `.env` in this directory. Run all subsequent `docker compose` commands here.

2. Pull the image and start it:

   ```sh
   docker compose up -d
   docker compose logs server
   ```

   The `Kiteline setup token: …` log line contains the setup token (the UI's "Setup token"), needed for the next step. `Kiteline listening on http://0.0.0.0:8080` means the server has started listening.

3. Check that the server responds:

   ```sh
   curl -fsS http://127.0.0.1:8080/healthz
   ```

   See [Health check](reference.en.md#health-check) for the response format.

4. Open `http://127.0.0.1:8080` and set a password as described in [Set up the owner](#set-up-the-owner).

You can also set `KITELINE_HTTP_BIND`, `KITELINE_HTTP_PORT` and `KITELINE_TRUST_PROXY_PROTO` in `.env`. See [LAN access and ports](#lan-access-and-ports) and [HTTPS and reverse proxies](#https-and-reverse-proxies) for usage, and [Reference](reference.en.md#server-environment-variables) for defaults. After changing `.env`, run `docker compose up -d` again; Compose recreates the container with the new settings.

Compose uses the official GHCR image by default, and Docker selects the host architecture automatically. For a locally built or fork image, set `KITELINE_IMAGE` to its image path and `KITELINE_VERSION` to its tag. See [Build and release (Chinese)](../development/release.md#构建-linux-包与镜像) for local builds and tags.

Inside the container, the server runs as `kiteline` (UID 1000, GID 1000). Its data directory `/var/lib/kiteline` is in the Compose volume `server-data`. The Compose project is named `kiteline`, so Docker's actual volume name is `kiteline_server-data`. `docker compose down` keeps this volume; `docker compose down -v` deletes it and all server data. If you replace the volume with a host directory mount, that directory must be owned by `1000:1000`.

## Native deployment

Native deployment runs the server with systemd. Run the following commands in order, in the same shell on the server host, as a user with sudo access. Later steps use the variables set in step 1.

1. Install runtime libraries, download the release package and checksum file, and verify the package:

   ```sh
   KITELINE_VERSION=X.Y.Z  # Replace with the version to deploy
   KITELINE_ARCH=amd64     # Use arm64 on an ARM64 host
   name="kiteline-server-$KITELINE_VERSION-linux-$KITELINE_ARCH"
   sudo apt-get update && sudo apt-get install -y curl libstdc++6 libatomic1
   curl -fLO "https://github.com/Azure99/kiteline/releases/download/v$KITELINE_VERSION/$name.tar.gz"
   curl -fLO "https://github.com/Azure99/kiteline/releases/download/v$KITELINE_VERSION/$name.tar.gz.sha256"
   sha256sum -c "$name.tar.gz.sha256"
   ```

2. Extract into the installation directory `/opt/kiteline-server`. The package contains a top-level `kiteline-server-<version>-linux-<architecture>/` directory, so strip one component:

   ```sh
   sudo mkdir /opt/kiteline-server
   sudo tar -xzf "$name.tar.gz" --no-same-owner --strip-components=1 -C /opt/kiteline-server
   /opt/kiteline-server/bin/kiteline-server --version
   ```

3. Create a dedicated system user, `kiteline`, and a data directory it owns:

   ```sh
   sudo useradd --system --user-group --home-dir /var/lib/kiteline --shell /usr/sbin/nologin kiteline
   sudo install -d -o kiteline -g kiteline -m 700 /var/lib/kiteline
   ```

4. Download the systemd unit from the same repository tag (it is not included in the server release package), create the environment file, and start the server:

   ```sh
   sudo curl -fsSL -o /etc/systemd/system/kiteline-server.service \
     "https://raw.githubusercontent.com/Azure99/kiteline/v$KITELINE_VERSION/deploy/systemd/kiteline-server.service"
   echo 'KITELINE_TRUST_PROXY_PROTO=0' | sudo tee /etc/kiteline-server.env
   sudo systemctl daemon-reload
   sudo systemctl enable --now kiteline-server
   sudo journalctl -u kiteline-server
   ```

   The unit runs `/opt/kiteline-server/bin/kiteline-server serve` as `kiteline`, with `KITELINE_DATA_DIR=/var/lib/kiteline` and `KITELINE_LISTEN_ADDR=127.0.0.1:8080`. `/etc/kiteline-server.env` must exist; its variables override settings with the same names in the unit. The `Kiteline setup token: …` log line contains the setup token.

5. Check the response with `curl -fsS http://127.0.0.1:8080/healthz`, then open `http://127.0.0.1:8080` and follow [Set up the owner](#set-up-the-owner).

## Set up the owner

The workbench has one account, the owner. Open any origin in a browser and use the setup token from the logs to set a password.

The setup token is printed only once, on the server's first startup, and expires after a limited time (see [Limits](reference.en.md#limits)). Restarting the server does not print it again. If it expires or is lost, generate another as described in [Reset the setup token or password](#reset-the-setup-token-or-password).

Password length is measured in UTF-8 bytes (a Chinese character usually takes 3 bytes). See [Limits](reference.en.md#limits) for the allowed length and login lifetime, and [Sign-in and language](usage.en.md#sign-in-and-language) for login scope.

If the server is on a remote host and listens only on `127.0.0.1`, you can use SSH port forwarding for initial setup: run `ssh -L 8080:127.0.0.1:8080 USER@SERVER_HOST` on your computer, then open `http://127.0.0.1:8080`. This address is accessible only from your computer. When connecting devices, open the workbench through an origin those devices can also reach; see [Connect using the web command](devices.en.md#connect-using-the-web-command).

## LAN access and ports

To allow other machines on your LAN to access the server directly over HTTP:

- Docker: add `KITELINE_HTTP_BIND=0.0.0.0` to `.env`, optionally add a different port such as `KITELINE_HTTP_PORT=9080`, then run `docker compose up -d`.
- Native: add `KITELINE_LISTEN_ADDR=0.0.0.0:8080` to `/etc/kiteline-server.env`, then run `sudo systemctl restart kiteline-server`.

Other machines can then open `http://SERVER_IP:8080` (using the actual port).

- For native deployment, allow the port through the host firewall.
- Docker-published ports bypass ufw and firewalld inbound rules. If the host has a public IP address, set `KITELINE_HTTP_BIND` to its LAN address (for example `192.168.1.10`), rather than `0.0.0.0`, which would expose the port publicly.

Always include a port in `KITELINE_LISTEN_ADDR` (see the format in [Reference](reference.en.md#server-environment-variables)). Omitting it makes the server listen on port 80, and startup fails because `kiteline` cannot bind ports below 1024. Browsers refuse connections to some ports, such as 6000 and 6665 through 6669; choose a commonly used port.

Direct HTTP access sends passwords, login cookies, terminal content and files in plain text. Use HTTPS across untrusted networks.

## HTTPS and reverse proxies

Provide HTTPS through your own reverse proxy, such as nginx or Caddy, forwarding HTTPS requests to the server's HTTP port.

First configure the server to trust the protocol header from the reverse proxy:

- Docker: set `KITELINE_TRUST_PROXY_PROTO=1` in `.env` and run `docker compose up -d`.
- Native: set `KITELINE_TRUST_PROXY_PROTO=1` in `/etc/kiteline-server.env` and run `sudo systemctl restart kiteline-server`.

With this set to `1`, the server also trusts `X-Forwarded-Proto` sent by directly connected clients. Therefore, only the reverse proxy should be able to access the HTTP port: keep the `127.0.0.1` binding or expose it only within the proxy's network.

The reverse proxy must meet these requirements:

1. Forward the origin's entire root path `/`, including `/api/`, `/proxy/`, `/absproxy/`, `/downloads/` and installation scripts, preserving paths and query parameters.
2. Preserve `Host`, including non-default ports such as `kiteline.example.com:8443`.
3. Replace `X-Forwarded-Proto` with the single value `https`; do not append to an existing value.
4. Support WebSocket Upgrade.
5. Stream both requests and responses without buffering. SSE, downloads and uploads depend on this. Do not limit upload size, or set the limit no lower than the agent's `transferBytes`.
6. Set read and write timeouts no shorter than the longest operation deadline, such as `gitWriteTimeout` for Git writes. See [Limits](reference.en.md#limits) for values.
7. Do not automatically retry or replay requests, including after a reused upstream connection closes.
8. Preserve `Origin`, `Cookie` and `Set-Cookie` (the proxy's default behavior is sufficient).

If the server and proxy are in different network namespaces, the proxy must be able to reach the server's HTTP port. For a proxy on another host, bind the server to an address that host can reach. For a proxy in another container in the same Compose project, forward to `http://server:8080`. `127.0.0.1` inside another container refers to that container, not the host.

### nginx example

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name kiteline.example.com;
    ssl_certificate     /etc/ssl/kiteline.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/kiteline.example.com/privkey.pem;

    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_next_upstream off;
    }
}
```

Place `map` in the `http` block (files under `conf.d` are inside it by default). Use `$http_host` for `Host`, because `$host` omits the port.

### Caddy example

```caddyfile
{
	servers {
		enable_full_duplex
	}
}

kiteline.example.com {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval 10ms
		transport http {
			keepalive off
		}
	}
}
```

Caddy obtains certificates automatically, preserves `Host`, replaces `X-Forwarded-Proto` with the actual scheme, and supports WebSocket. `flush_interval` delivers streaming responses promptly. `keepalive off` prevents upstream connection reuse, avoiding automatic request replay when a reused connection closes. `enable_full_duplex` lets the server respond before an upload completes.

This example requires Caddy 2.7 or later. Caddy 2.6.2 from the Ubuntu 24.04 and Debian 12 repositories does not support `enable_full_duplex`; install from Caddy's official repository.

### Multiple origins

One server can have several origins at once, such as `http://192.168.1.10:8080` on a LAN and `https://kiteline.example.com` publicly. Add sites to the reverse proxy; origins do not need to be registered with the server. See [Sign-in and language](usage.en.md#sign-in-and-language) for login scope. A device connects only to the origin used when binding it. HTTP-to-HTTPS redirects work only for browsers; use the `https://` address directly when binding a device.

### Common errors

For symptoms of proxy misconfiguration, such as `Origin mismatch`, `Invalid X-Forwarded-Proto`, terminals failing to connect or downloads not responding, and their remedies, see [Troubleshooting](reference.en.md#troubleshooting).

## Reset the setup token or password

Both recovery commands must run with the server stopped and with the same data directory. Running them while the server is active produces `Lock file is already being held`.

- `setup-token` generates a new setup token, replacing the previous one, with the same lifetime as the first token. It can only be used before owner setup; afterward it reports `Already initialized`.
- `reset-password`: set a new owner password. Success invalidates every browser login session, requiring sign-in with the new password. Device bindings are unaffected. It works only after owner setup; before that it reports `Not initialized`.

Docker (run in the deployment directory):

```sh
docker compose stop server
docker compose run --rm --no-deps server setup-token
docker compose up -d server
```

Native:

```sh
sudo systemctl stop kiteline-server
sudo -u kiteline /opt/kiteline-server/bin/kiteline-server setup-token --data-dir /var/lib/kiteline
sudo systemctl start kiteline-server
```

To reset the password, replace `setup-token` in the middle command with `reset-password`. "Sign-in recovery" on the sign-in page also displays the appropriate commands.

## Backup and restore

The server data directory stores the owner password, device registrations and scheduled-task summaries. Device binding credentials, workspace registrations and scheduled tasks are in each device's agent data directory (see [File locations](reference.en.md#file-locations)); back these up separately on the device. Back up project files using your existing process.

Stop the server and back up the entire data directory for a consistent copy.

Docker (run in the deployment directory): the backup and restore commands below use the default volume `kiteline_server-data`. If you changed the data mount, replace that volume name in both commands with the actual volume name or the absolute host-directory path.

```sh
docker compose stop server
docker run --rm -v kiteline_server-data:/data:ro -v "$PWD":/backup ubuntu:24.04 \
  tar -czf /backup/kiteline-server-data.tar.gz -C /data .
docker compose start server
```

Restore:

```sh
docker compose stop server
docker run --rm -v kiteline_server-data:/data -v "$PWD":/backup ubuntu:24.04 \
  sh -c 'find /data -mindepth 1 -delete && tar -xzf /backup/kiteline-server-data.tar.gz -C /data'
docker compose start server
```

Native:

```sh
sudo systemctl stop kiteline-server
sudo tar -czf kiteline-server-data.tar.gz -C /var/lib/kiteline .
sudo systemctl start kiteline-server
```

Restore:

```sh
sudo systemctl stop kiteline-server
sudo find /var/lib/kiteline -mindepth 1 -delete
sudo tar -xzf kiteline-server-data.tar.gz -C /var/lib/kiteline
sudo systemctl start kiteline-server
```

Restoring returns device registrations to their state at backup time. Devices bound since the backup cannot connect and must be [bound again](devices.en.md#bind-again). Devices deleted since the backup reappear in the list and can be deleted again in the web app.

## Upgrade the server

Read the [target version's release notes](https://github.com/Azure99/kiteline/releases) first, checking changes to deployment files, environment variables and configuration, and any manual steps. Upgrade the server before the agents. A [backup](#backup-and-restore) is recommended first. Stopping or restarting the server does not affect terminals or scheduled tasks on devices. Agents with a matching version reconnect automatically when the server returns.

For Docker, run the following in the deployment directory. The `curl` command overwrites `compose.yaml` with the new version. If you customized it, for example to use a host directory mount, download to `compose.yaml.new` instead (`curl -fsSL -o compose.yaml.new …`), merge your changes, replace `compose.yaml`, then run the remaining commands. Overwriting loses your changes; for example, the server may start with the named volume `server-data` and no longer read the original data.

```sh
KITELINE_VERSION=X.Y.Z  # Replace with the new version
curl -fsSLO "https://raw.githubusercontent.com/Azure99/kiteline/v$KITELINE_VERSION/deploy/compose.yaml"
sed -i "s/^KITELINE_VERSION=.*/KITELINE_VERSION=$KITELINE_VERSION/" .env
docker compose pull
docker compose up -d
```

Native:

```sh
KITELINE_VERSION=X.Y.Z  # Replace with the new version
KITELINE_ARCH=amd64     # Use arm64 on an ARM64 host
name="kiteline-server-$KITELINE_VERSION-linux-$KITELINE_ARCH"
curl -fLO "https://github.com/Azure99/kiteline/releases/download/v$KITELINE_VERSION/$name.tar.gz"
curl -fLO "https://github.com/Azure99/kiteline/releases/download/v$KITELINE_VERSION/$name.tar.gz.sha256"
sha256sum -c "$name.tar.gz.sha256"
sudo systemctl stop kiteline-server
sudo mv /opt/kiteline-server /opt/kiteline-server.previous
sudo mkdir /opt/kiteline-server
sudo tar -xzf "$name.tar.gz" --no-same-owner --strip-components=1 -C /opt/kiteline-server
sudo systemctl start kiteline-server
curl -fsS http://127.0.0.1:8080/healthz
```

After `healthz` shows the new version, remove the old installation directory: `sudo rm -rf /opt/kiteline-server.previous`. If `deploy/systemd/kiteline-server.service` changed in the new tag, also replace the unit and run `sudo systemctl daemon-reload`.

Refresh the browser after upgrading the server. Devices whose agent version differs from the server display "Version mismatch" and cannot connect until their agents are upgraded. Their terminals and scheduled tasks keep running. Follow [Upgrade the agent](devices.en.md#upgrade-the-agent) for each device.
