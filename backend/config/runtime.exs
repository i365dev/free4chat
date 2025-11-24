import Config

defmodule ConfigParser do
  def parse_integrated_turn_ip(ip) do
    with {:ok, parsed_ip} <- ip |> to_charlist() |> :inet.parse_address() do
      parsed_ip
    else
      _ ->
        raise("""
        Bad integrated TURN IP format. Expected IPv4, got: \
        #{inspect(ip)}
        """)
    end
  end

  def parse_integrated_turn_port_range(range) do
    with [str1, str2] <- String.split(range, "-"),
         from when from in 0..65_535 <- String.to_integer(str1),
         to when to in from..65_535 and from <= to <- String.to_integer(str2) do
      {from, to}
    else
      _else ->
        raise("""
        Bad INTEGRATED_TURN_PORT_RANGE enviroment variable value. Expected "from-to", where `from` and `to` \
        are numbers between 0 and 65535 and `from` is not bigger than `to`, got: \
        #{inspect(range)}
        """)
    end
  end

  def parse_port_number(nil, _var_name), do: nil

  def parse_port_number(var_value, var_name) do
    with {port, _sufix} when port in 1..65535 <- Integer.parse(var_value) do
      port
    else
      _var ->
        raise(
          "Bad #{var_name} enviroment variable value. Expected valid port number, got: #{inspect(var_value)}"
        )
    end
  end

  def parse_metrics_scrape_interval(nil), do: nil

  def parse_metrics_scrape_interval(interval) do
    with {number, _sufix} when number >= 1 <- Integer.parse(interval) do
      number
    else
      _var ->
        raise "Bad METRICS_SCRAPE_INTERVAL enviroment variable value. Expected positive integer, got: #{interval}"
    end
  end
end

config :free4chat,
  integrated_turn_ip:
    System.get_env("INTEGRATED_TURN_IP", "127.0.0.1") |> ConfigParser.parse_integrated_turn_ip(),
  integrated_turn_port_range:
    System.get_env("INTEGRATED_TURN_PORT_RANGE", "50000-59999")
    |> ConfigParser.parse_integrated_turn_port_range(),
  integrated_tcp_turn_port:
    System.get_env("INTEGRATED_TCP_TURN_PORT")
    |> ConfigParser.parse_port_number("INTEGRATED_TCP_TURN_PORT"),
  integrated_tls_turn_port:
    System.get_env("INTEGRATED_TLS_TURN_PORT")
    |> ConfigParser.parse_port_number("INTEGRATED_TLS_TURN_PORT"),
  integrated_turn_pkey: System.get_env("INTEGRATED_TURN_PKEY"),
  integrated_turn_cert: System.get_env("INTEGRATED_TURN_CERT"),
  integrated_turn_domain: System.get_env("VIRTUAL_HOST"),
  metrics_scrape_interval:
    System.get_env("METRICS_SCRAPE_INTERVAL", "1")
    |> ConfigParser.parse_metrics_scrape_interval()

protocol = if System.get_env("USE_TLS") == "true", do: :https, else: :http

get_env = fn env, default ->
  if config_env() == :prod do
    System.fetch_env!(env)
  else
    System.get_env(env, default)
  end
end

host = get_env.("VIRTUAL_HOST", "localhost")
port = 4000

args =
  if protocol == :https do
    [
      keyfile: get_env.("KEY_FILE_PATH", "priv/certs/key.pem"),
      certfile: get_env.("CERT_FILE_PATH", "priv/certs/certificate.pem"),
      cipher_suite: :strong
    ]
  else
    []
  end
  |> Keyword.merge(otp_app: :free4chat, port: port)

config :free4chat, Free4chatWeb.Endpoint, [
  {:url, [host: host]},
  {protocol, args}
]

config :opentelemetry, :resource,
  service: [
    name: "membrane",
    namespace: "membrane"
  ],
  tracer: :otel_tracer_default,
  processors: [
    otel_batch_processor: %{
      exporter: {:otel_exporter_stdout, []}
    }
  ]

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/free4chat start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :free4chat, Free4chatWeb.Endpoint, server: true
end

if config_env() == :prod do
  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  config :free4chat, Free4chatWeb.Endpoint, secret_key_base: secret_key_base
end

otel_state = :local

config :opentelemetry, :resource,
  service: [
    name: "free4chat",
    namespace: "free4chat"
  ]

exporter =
  case otel_state do
    :local ->
      {:otel_exporter_stdout, []}

    :honeycomb ->
      {:opentelemetry_exporter,
       %{
         endpoints: ["https://api.honeycomb.io:443"],
         headers: [
           {"x-honeycomb-dataset", "experiments"},
           {"x-honeycomb-team", System.get_env("HONEYCOMB")}
         ]
       }}

    :zipkin ->
      {:opentelemetry_zipkin,
       %{
         address: ["http://localhost:9411/api/v2/spans"],
         local_endpoint: %{service_name: "Free4chat"}
       }}

    _ ->
      {}
  end

if otel_state != :purge,
  do:
    config(:opentelemetry,
      processors: [
        otel_batch_processor: %{
          exporter: exporter
        }
      ]
    )

config :libcluster,
  debug: true,
  topologies: [
    free4chat: [
      strategy: Cluster.Strategy.Epmd,
      # config: [hosts: [:"rtc1@172.26.8.68", :"rtc2@172.26.25.248"]]
      config: [hosts: [:"rtc1@172.26.8.68"]]
    ]
  ]
