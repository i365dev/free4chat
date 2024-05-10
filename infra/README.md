# Infrastructure for free4.chat

## Deploy backend server

### AWS Lightsail

1. use `./scripts/init-server.sh` to init server.
2. On Lightsail web console -> IPv4 Firewall, add TCP port `49999` and UDP port `50000-65355`.
3. Because our backend server run in Docker as `host` network mode and listen port `4000`, our DNS record direct to `80` or `443`, so we need redirect the traffic from these ports to port `4000`.
   1. `sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 4000`
   2. `sudo iptables -t nat -A PREROUTING -p tcp --dport 443 -j REDIRECT --to-port 4000`
   3. __NOTE__: These iptables rules not persistent and need __re-execute__ when server reboot.

### GitHub Actions

Set these secrets in `Actions secrets`:

```bash
DOCKER_HUB_USERNAME=
DOCKER_HUB_PASSWORD=
DOCKER_HUB_ACCESS_TOKEN=

DASHBOARD_AUTH_USERNAME=
DASHBOARD_AUTH_PASSWORD=

SECRET_KEY_BASE=
SSH_PRIV_KEY=
SSH_PUB_KEY=

RTC1_HOST={user@ip} # remember update in github actions secrets when server ip update
RTC2_HOST={user@ip} # remember update in github actions secrets when server ip update
```

### Cluster

Use [libcluster](https://github.com/bitwalker/libcluster) to build cluster server, and frontend do the client load balance (random strategy).

### Upgrade server instance size

When change server or upgrade server, that means ip will changed. We need to do these tasks:

- [ ] Provision server by `scripts/init-server.sh` script.
- [ ] Replace all public or private ip in code base include github actions config file.
- [ ] Update `RTC1_HOST` and `RTC1_HOST` in GitHub `Actions secrets`.
- [ ] Update DNS records.
- [ ] Re-deploy container to server.
- [ ] Open the firewall IPV4/IPV6 protocols in server web console.
- [ ] If server reboot, remember to config the iptables (80/443 -> 4000) in server.

### Manually deploy the docker instance on the server when GitHub Action fails

```bash
docker ps # check if there is any instance
docker stop `old-instances-id` # stop the instance if needs
docker rm `old-instances-id` # remove the old instance if needs
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' `old-instances-id` > container_env.txt # dump the env file and you can modify it if needs
docker run -d --name rtc1_free4chat_1 --env-file container_env.txt -p 4000:4000 madawei2699/free4chat:prod # run the instance
sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 4000 # tunnel the server port to 80
sudo iptables -t nat -A PREROUTING -p tcp --dport 443 -j REDIRECT --to-port 4000 # tunnel the server port to 443
```

### ~~Fly.io~~

__NOTE__: There are some stumbling blocks that make it difficult to deploy to Fly.io:

- IPV6: Fly.io internal is IPV6 private network, but [ei_connect does not handle IPv6](https://github.com/erlang/otp/issues/5068) which make it hard to start our backend server, because it need use CNode to start [ex_dtls](https://github.com/membraneframework/ex_dtls). Althoght we can sue `NIF` mode to start ex_dtls, but it seems [libcluster](https://github.com/bitwalker/libcluster) still can not connect the node in Fly.io IPV6.
- TURN: WebRTC need TURN server to relay the package behind on the NAT network, and the TURN need open lots of UDP ports, but Fly.io needs our server to listen on [fly-global-services](https://fly.io/docs/app-guides/udp-and-tcp/#udp-must-listen-on-the-same-port-externally-and-internally) which is conflict with the TURN server address.

<details>
  <summary>fly.io config backup</summary>

  ```
fly secrets set SECRET_KEY_BASE=my_secret_value # `mix phx.gen.secret` to generate secret value for production
```

```bash
flyctl deploy --build-arg DASHBOARD_AUTH_USERNAME=admin --build-arg DASHBOARD_AUTH_PASSWORD=xxx
```
</details>

## Deploy frontend app

Use [Vercel](vercel.com) to deploy the frontend app.
