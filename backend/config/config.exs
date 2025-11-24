# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

# Configures the endpoint
config :free4chat, Free4chatWeb.Endpoint,
  url: [host: "localhost"],
  render_errors: [view: Free4chatWeb.ErrorView, accepts: ~w(json), layout: false],
  pubsub_server: Free4chat.PubSub,
  live_view: [signing_salt: "PwVJ7akS"]

config :membrane_opentelemetry, enabled: true

# Configures Elixir's Logger
config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

config :logger,
  compile_time_purge_matching: [
    [level_lower_than: :info],
    # Silence irrelevant warnings caused by resending handshake events
    [module: Membrane.SRTP.Encryptor, function: "handle_event/4", level_lower_than: :error]
  ]

telemetry_enabled = true

config :membrane_telemetry_metrics, enabled: telemetry_enabled

config :membrane_opentelemetry, enabled: telemetry_enabled

config :logger, :console, metadata: [:room, :peer]

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"

config :ex_dtls, impl: NIF
